import express from 'express';
import crypto from 'crypto';
import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { getFirestoreInstance } from './src/server/db/firestore';
import { createChatGptCharacterRouter } from './chatgpt-character-router';
import {
  CharacterReferenceInputError,
  resolveCharacterReferenceInput,
} from './src/server/services/chatgptCharacterInputResolver';

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_URL = String(process.env.ZAOJING_MVP_UPSTREAM_URL || '').replace(/\/+$/, '');
const UPSTREAM_AUTH_MODE = String(process.env.ZAOJING_UPSTREAM_AUTH_MODE || 'iap-signed-jwt').trim().toLowerCase();
const PUBLIC_URL = String(process.env.ZAOJING_CHATGPT_PUBLIC_URL || '').replace(/\/+$/, '');
const RUNTIME_SA = String(process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL || '');
const BOOTSTRAP_KEY_HASH = String(process.env.ZAOJING_CHATGPT_BOOTSTRAP_KEY_HASH || '').trim().toLowerCase();
const UAT_DIRECT_MODE = String(process.env.ZAOJING_CHATGPT_UAT_DIRECT || '').trim().toLowerCase() === 'true';
const UAT_DIRECT_DAILY_LIMIT = Math.max(1, Math.min(100, Number(process.env.ZAOJING_CHATGPT_UAT_DAILY_LIMIT || 12) || 12));
const KEY_COLLECTION = 'mvp_chatgpt_api_keys';
const UAT_ADMISSION_COLLECTION = 'mvp_chatgpt_uat_admissions';
const UAT_QUOTA_COLLECTION = 'mvp_chatgpt_uat_daily_quota';
const INPUT_BINDING_COLLECTION = 'mvp_chatgpt_input_bindings';
const TASK_INPUT_BINDING_COLLECTION = 'mvp_chatgpt_task_input_bindings';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const auth = new GoogleAuth();

type SupportedImageMime = typeof SUPPORTED_IMAGE_MIMES[number];
type OpenAIFileRefObject = { name?: string; id?: string; mime_type?: string; download_link?: string };
type OpenAIFileRef = string | OpenAIFileRefObject;
type OpenAIImageDiagnostics = {
  referenceKind: 'string_file_id' | 'object' | 'unknown';
  fileIdPresent: boolean;
  downloadLinkPresent: boolean;
  fileName: string | null;
  declaredMime: string | null;
  responseMime: string | null;
  detectedMime: SupportedImageMime | null;
  sizeBytes: number;
  downloadHost: string | null;
  contentSha256: string | null;
  prefixHex: string | null;
};
type DownloadedOpenAIImage = { bytes: Buffer; mimeType: SupportedImageMime; name: string; diagnostics: OpenAIImageDiagnostics };

type GatewayInputSource =
  | { type: 'conversation_file'; contentSha256: string | null }
  | {
      type: 'character_reference';
      characterId: string;
      characterName: string;
      characterUpdatedAt: number | null;
      referenceId: string;
      angle: string;
      contentSha256: string;
      identitySpecSha256: string;
    };

type GatewayResolvedImage = {
  bytes: Buffer;
  mimeType: SupportedImageMime;
  name: string;
  diagnostics: Record<string, unknown>;
  source: GatewayInputSource;
  identityLockPrompt?: string | null;
};

type UatAdmission = {
  allowed: boolean;
  existingIntent: boolean;
  day: string;
  count: number;
  limit: number;
};

class OpenAIFileBridgeError extends Error {
  constructor(public code: string, public diagnostics: Partial<OpenAIImageDiagnostics> = {}) {
    super(code);
  }
}

class VideoInputSourceError extends Error {
  constructor(public code: string, public diagnostics: Record<string, unknown> = {}) {
    super(code);
  }
}

function sha256(value: Buffer | string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function bearer(req: express.Request): string {
  const value = String(req.header('authorization') || '');
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}
function utcDayKey(): string { return new Date().toISOString().slice(0, 10); }

async function ensureBootstrapApiKey(): Promise<void> {
  if (!BOOTSTRAP_KEY_HASH) return;
  if (!/^[a-f0-9]{64}$/.test(BOOTSTRAP_KEY_HASH)) throw new Error('ZAOJING_CHATGPT_BOOTSTRAP_KEY_HASH_INVALID');
  const db = getFirestoreInstance();
  if (!db) throw new Error('FIRESTORE_UNAVAILABLE_FOR_BOOTSTRAP_KEY');
  const ref = db.collection(KEY_COLLECTION).doc(BOOTSTRAP_KEY_HASH);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return;
    tx.set(ref, { createdAt: Date.now(), revokedAt: null, purpose: 'chatgpt-actions-v1-bootstrap' });
  });
}

async function authenticateApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const token = bearer(req);
    if (!token.startsWith('zjg_') || token.length < 32 || token.length > 256) return res.status(401).json({ error: 'invalid_api_key' });
    const db = getFirestoreInstance();
    if (!db) return res.status(503).json({ error: 'firestore_unavailable' });
    const snap = await db.collection(KEY_COLLECTION).doc(sha256(token)).get();
    if (!snap.exists || snap.data()?.revokedAt) return res.status(401).json({ error: 'invalid_api_key' });
    res.locals.chatgptKeyId = snap.id;
    return next();
  } catch (error: any) { return res.status(500).json({ error: 'authentication_failed', detail: String(error?.message || error) }); }
}

async function admitUatDirectIntent(idempotencyKey: string): Promise<UatAdmission> {
  const day = utcDayKey();
  if (!UAT_DIRECT_MODE) return { allowed: true, existingIntent: false, day, count: 0, limit: UAT_DIRECT_DAILY_LIMIT };
  const db = getFirestoreInstance();
  if (!db) throw new Error('FIRESTORE_UNAVAILABLE_FOR_UAT_ADMISSION');
  const intentHash = sha256(idempotencyKey);
  const admissionRef = db.collection(UAT_ADMISSION_COLLECTION).doc(intentHash);
  const quotaRef = db.collection(UAT_QUOTA_COLLECTION).doc(day);
  return db.runTransaction(async (tx) => {
    const admissionSnap = await tx.get(admissionRef);
    if (admissionSnap.exists) {
      const savedCount = Number(admissionSnap.data()?.dayCount || 0);
      return { allowed: true, existingIntent: true, day, count: savedCount, limit: UAT_DIRECT_DAILY_LIMIT };
    }
    const quotaSnap = await tx.get(quotaRef);
    const count = Number(quotaSnap.data()?.count || 0);
    if (count >= UAT_DIRECT_DAILY_LIMIT) {
      return { allowed: false, existingIntent: false, day, count, limit: UAT_DIRECT_DAILY_LIMIT };
    }
    const nextCount = count + 1;
    tx.create(admissionRef, { idempotencyKeyHash: intentHash, day, dayCount: nextCount, createdAt: Date.now() });
    tx.set(quotaRef, { day, count: nextCount, updatedAt: Date.now() }, { merge: true });
    return { allowed: true, existingIntent: false, day, count: nextCount, limit: UAT_DIRECT_DAILY_LIMIT };
  });
}

function allowedOpenAIFileUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'files.oaiusercontent.com' || host.endsWith('.oaiusercontent.com') || host === 'files.openai.com' || host.endsWith('.openai.com');
  } catch { return false; }
}

function downloadHost(raw: string): string | null {
  try { return new URL(raw).hostname.toLowerCase(); }
  catch { return null; }
}

function normalizeMime(raw: unknown): string | null {
  const mime = String(raw || '').split(';')[0].trim().toLowerCase();
  return mime || null;
}

function refDiagnostics(ref: OpenAIFileRef | undefined): Partial<OpenAIImageDiagnostics> {
  if (typeof ref === 'string') {
    return {
      referenceKind: 'string_file_id',
      fileIdPresent: ref.trim().length > 0,
      downloadLinkPresent: false,
      fileName: null,
      declaredMime: null,
      downloadHost: null,
    };
  }
  if (ref && typeof ref === 'object') {
    const link = String(ref.download_link || '');
    return {
      referenceKind: 'object',
      fileIdPresent: Boolean(ref.id),
      downloadLinkPresent: Boolean(link),
      fileName: ref.name ? String(ref.name) : null,
      declaredMime: normalizeMime(ref.mime_type),
      downloadHost: downloadHost(link),
    };
  }
  return {
    referenceKind: 'unknown',
    fileIdPresent: false,
    downloadLinkPresent: false,
    fileName: null,
    declaredMime: null,
    downloadHost: null,
  };
}

function detectImageMime(bytes: Buffer): SupportedImageMime | null {
  if (!bytes || bytes.length < 12) return null;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (jpeg) return 'image/jpeg';
  if (png) return 'image/png';
  if (webp) return 'image/webp';
  return null;
}

function extensionForMime(mime: SupportedImageMime): string {
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
}

function normalizedImageName(rawName: unknown, mime: SupportedImageMime): string {
  const original = String(rawName || 'identity-reference').split(/[\\/]/).pop() || 'identity-reference';
  const stem = original.replace(/\.[A-Za-z0-9]{1,10}$/, '') || 'identity-reference';
  return `${stem}.${extensionForMime(mime)}`;
}

function actionSafeFileBridgeFailure(error: unknown, fallbackError: string, extra: Record<string, unknown> = {}) {
  if (error instanceof OpenAIFileBridgeError) {
    return {
      ok: false,
      status: 'FILE_BRIDGE_FAILED',
      taskCreated: false,
      providerCalled: false,
      error: error.code,
      stage: 'action_file_bridge',
      retryable: false,
      diagnostics: error.diagnostics,
      ...extra,
    };
  }
  return {
    ok: false,
    status: 'GATEWAY_ERROR',
    taskCreated: false,
    providerCalled: false,
    error: fallbackError,
    stage: 'action_gateway',
    retryable: true,
    ...extra,
  };
}

async function downloadOpenAIImage(ref: OpenAIFileRef): Promise<DownloadedOpenAIImage> {
  const initialDiagnostics = refDiagnostics(ref);
  const objectRef = typeof ref === 'string' ? null : ref;
  const link = String(objectRef?.download_link || '');
  if (!allowedOpenAIFileUrl(link)) throw new OpenAIFileBridgeError('OPENAI_FILE_URL_INVALID', initialDiagnostics);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(link, { signal: controller.signal, redirect: 'follow' });
    const responseMime = normalizeMime(response.headers.get('content-type'));
    if (!response.ok) {
      throw new OpenAIFileBridgeError(`OPENAI_FILE_DOWNLOAD_FAILED_${response.status}`, { ...initialDiagnostics, responseMime });
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_BYTES) {
      throw new OpenAIFileBridgeError('OPENAI_FILE_TOO_LARGE', { ...initialDiagnostics, responseMime, sizeBytes: contentLength });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const detectedMime = detectImageMime(bytes);
    const diagnostics: OpenAIImageDiagnostics = {
      referenceKind: initialDiagnostics.referenceKind || 'unknown',
      fileIdPresent: initialDiagnostics.fileIdPresent === true,
      downloadLinkPresent: initialDiagnostics.downloadLinkPresent === true,
      fileName: initialDiagnostics.fileName || null,
      declaredMime: initialDiagnostics.declaredMime || null,
      responseMime,
      detectedMime,
      sizeBytes: bytes.length,
      downloadHost: initialDiagnostics.downloadHost || null,
      contentSha256: bytes.length ? sha256(bytes) : null,
      prefixHex: bytes.length ? bytes.subarray(0, Math.min(16, bytes.length)).toString('hex') : null,
    };
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new OpenAIFileBridgeError('OPENAI_FILE_TOO_LARGE', diagnostics);
    if (!detectedMime) throw new OpenAIFileBridgeError('OPENAI_FILE_CONTENT_INVALID', diagnostics);
    return { bytes, mimeType: detectedMime, name: normalizedImageName(objectRef?.name, detectedMime), diagnostics };
  } finally { clearTimeout(timer); }
}

function characterIdentityPrompt(prompt: string, image: GatewayResolvedImage): string {
  if (image.source.type !== 'character_reference' || !image.identityLockPrompt) return prompt;
  return `${prompt}\n\n[ZAOJING_DURABLE_CHARACTER_IDENTITY]\n${image.identityLockPrompt}\nKeep the generated person faithful to this durable character identity and to the supplied master reference.`;
}

async function resolveVideoInput(body: any): Promise<GatewayResolvedImage> {
  const refs = Array.isArray(body?.openaiFileIdRefs) ? body.openaiFileIdRefs as OpenAIFileRef[] : [];
  const inputSource = body?.inputSource && typeof body.inputSource === 'object' ? body.inputSource : null;
  const sourceType = String(inputSource?.type || '').trim();

  if (sourceType === 'character_reference') {
    if (refs.length > 0 || inputSource?.openaiFileIdRef) {
      throw new VideoInputSourceError('multiple_input_sources_not_allowed');
    }
    try {
      const resolved = await resolveCharacterReferenceInput(inputSource?.characterId, inputSource?.referenceId);
      return {
        bytes: resolved.bytes,
        mimeType: resolved.mimeType,
        name: resolved.name,
        diagnostics: resolved.diagnostics,
        identityLockPrompt: resolved.identityLockPrompt,
        source: {
          type: 'character_reference',
          characterId: resolved.characterId,
          characterName: resolved.characterName,
          characterUpdatedAt: resolved.characterUpdatedAt,
          referenceId: resolved.referenceId,
          angle: resolved.angle,
          contentSha256: resolved.contentSha256,
          identitySpecSha256: resolved.identitySpecSha256,
        },
      };
    } catch (error: any) {
      if (error instanceof CharacterReferenceInputError) {
        throw new VideoInputSourceError(error.code, error.diagnostics);
      }
      throw error;
    }
  }

  if (sourceType && sourceType !== 'conversation_file') {
    throw new VideoInputSourceError('input_source_type_invalid', { sourceType });
  }

  const explicitRef = inputSource?.openaiFileIdRef as OpenAIFileRef | undefined;
  if (explicitRef && refs.length > 0) throw new VideoInputSourceError('multiple_input_sources_not_allowed');
  const ref = explicitRef || refs[0];
  const count = explicitRef ? 1 : refs.length;
  if (!ref || count !== 1) throw new VideoInputSourceError('exactly_one_image_required', { receivedFileRefCount: refs.length });

  const downloaded = await downloadOpenAIImage(ref);
  return {
    bytes: downloaded.bytes,
    mimeType: downloaded.mimeType,
    name: downloaded.name,
    diagnostics: downloaded.diagnostics,
    source: { type: 'conversation_file', contentSha256: downloaded.diagnostics.contentSha256 },
  };
}

function inputSourceFingerprint(source: GatewayInputSource): string {
  return sha256(JSON.stringify(source));
}

async function bindInputIntent(idempotencyKey: string, source: GatewayInputSource, taskId?: string | null): Promise<void> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('FIRESTORE_UNAVAILABLE_FOR_INPUT_BINDING');
  const intentHash = sha256(idempotencyKey);
  const intentRef = db.collection(INPUT_BINDING_COLLECTION).doc(intentHash);
  const fingerprint = inputSourceFingerprint(source);
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(intentRef);
    if (snap.exists) {
      const existingFingerprint = String(snap.data()?.sourceFingerprint || '');
      if (existingFingerprint && existingFingerprint !== fingerprint) {
        throw new VideoInputSourceError('IDEMPOTENCY_INPUT_MISMATCH', {
          idempotencyKeyHash: intentHash,
          existingSourceType: snap.data()?.inputSource?.type || null,
          requestedSourceType: source.type,
        });
      }
      tx.set(intentRef, { inputSource: source, sourceFingerprint: fingerprint, taskId: taskId || snap.data()?.taskId || null, updatedAt: now }, { merge: true });
      return;
    }
    tx.create(intentRef, {
      idempotencyKeyHash: intentHash,
      inputSource: source,
      sourceFingerprint: fingerprint,
      taskId: taskId || null,
      createdAt: now,
      updatedAt: now,
    });
  });

  if (taskId) {
    await db.collection(TASK_INPUT_BINDING_COLLECTION).doc(taskId).set({
      taskId,
      idempotencyKeyHash: intentHash,
      inputSource: source,
      sourceFingerprint: fingerprint,
      updatedAt: now,
    }, { merge: true });
  }
}

async function getIntentInputBinding(idempotencyKey: string): Promise<any | null> {
  const db = getFirestoreInstance();
  if (!db) return null;
  const snap = await db.collection(INPUT_BINDING_COLLECTION).doc(sha256(idempotencyKey)).get();
  return snap.exists ? snap.data() : null;
}

async function getTaskInputBinding(taskId: string): Promise<any | null> {
  const db = getFirestoreInstance();
  if (!db) return null;
  const snap = await db.collection(TASK_INPUT_BINDING_COLLECTION).doc(taskId).get();
  return snap.exists ? snap.data() : null;
}

let cachedIapJwt: { token: string; expiresAt: number } | null = null;
let cachedCloudRunIdToken: { token: string; expiresAt: number } | null = null;

async function getIapServiceJwt(): Promise<string> {
  if (cachedIapJwt && cachedIapJwt.expiresAt - Date.now() > 60_000) return cachedIapJwt.token;
  if (!RUNTIME_SA) throw new Error('RUNTIME_SERVICE_ACCOUNT_EMAIL is missing');
  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const accessToken = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
  if (!accessToken) throw new Error('ADC_ACCESS_TOKEN_UNAVAILABLE');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3000;
  const payload = JSON.stringify({ iss: RUNTIME_SA, sub: RUNTIME_SA, aud: UPSTREAM_URL + '/*', iat, exp });
  const response = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(RUNTIME_SA)}:signJwt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload }),
  });
  const body = await response.json() as any;
  if (!response.ok || !body?.signedJwt) throw new Error('IAP_SIGN_JWT_FAILED: ' + JSON.stringify(body));
  cachedIapJwt = { token: String(body.signedJwt), expiresAt: exp * 1000 };
  return cachedIapJwt.token;
}

async function getCloudRunIdToken(): Promise<string> {
  if (cachedCloudRunIdToken && cachedCloudRunIdToken.expiresAt - Date.now() > 60_000) return cachedCloudRunIdToken.token;
  if (!UPSTREAM_URL) throw new Error('ZAOJING_MVP_UPSTREAM_URL is missing');
  const endpoint = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity' +
    `?audience=${encodeURIComponent(UPSTREAM_URL)}&format=full`;
  const response = await fetch(endpoint, { headers: { 'Metadata-Flavor': 'Google' } });
  const token = (await response.text()).trim();
  if (!response.ok || !token) throw new Error(`CLOUD_RUN_ID_TOKEN_FAILED_${response.status}`);
  cachedCloudRunIdToken = { token, expiresAt: Date.now() + 5 * 60_000 };
  return token;
}

async function upstream(path: string, init: RequestInit = {}): Promise<Response> {
  if (!UPSTREAM_URL) throw new Error('ZAOJING_MVP_UPSTREAM_URL is missing');
  const token = UPSTREAM_AUTH_MODE === 'cloud-run-id-token' ? await getCloudRunIdToken() : await getIapServiceJwt();
  return fetch(`${UPSTREAM_URL}${path}`, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers).entries()), Authorization: `Bearer ${token}` },
  });
}

async function responseJson(response: Response): Promise<any> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: 'upstream_non_json', httpStatus: response.status }; }
}

async function lookupUpstreamTask(idempotencyKey: string): Promise<any | null> {
  const response = await upstream('/api/mvp/videos/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotencyKey }),
  });
  if (response.status === 404) return null;
  const body = await responseJson(response);
  if (!response.ok) throw new Error(`UPSTREAM_LOOKUP_HTTP_${response.status}`);
  return body?.taskId ? body : null;
}

function actionTask(task: any) {
  return {
    taskId: task?.taskId || null,
    status: task?.status || null,
    stage: task?.stage || null,
    providerAttempt: task?.providerAttempt || 1,
    identityRetryCount: task?.identityRetryCount || 0,
    retryReason: task?.retryReason || null,
    operationNamePresent: task?.operationNamePresent === true,
    identityReport: task?.identityReport || null,
    firstAttemptIdentityReport: task?.firstAttemptIdentityReport || null,
    artifactPersisted: task?.artifactPersisted === true,
    artifactVerified: task?.artifactVerified === true,
    sizeBytes: task?.sizeBytes || null,
    videoReady: task?.status === 'COMPLETED',
    error: task?.error || null,
  };
}

function inferProviderCalled(task: any): boolean | null {
  if (!task?.taskId) return false;
  const stage = String(task?.stage || '');
  if (stage === 'input' || stage === 'artifact_persist') return false;
  if (['submit', 'polling', 'quality_check', 'identity_qa', 'output_fetch'].includes(stage)) return true;
  if (['SUBMITTING', 'GENERATING', 'QUALITY_CHECKING', 'RETRYING', 'COMPLETED', 'SUBMISSION_OUTCOME_UNKNOWN'].includes(String(task?.status || ''))) return true;
  return null;
}

function requestRejected(error: string, idempotencyKey: string | null = null, detail?: Record<string, unknown>) {
  return {
    ok: false,
    status: 'REQUEST_REJECTED',
    taskCreated: false,
    providerCalled: false,
    error,
    stage: 'action_request',
    retryable: false,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(detail || {}),
  };
}

function actionEnvelope(body: any, upstreamHttpStatus: number, idempotencyKey: string, inputFile: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    ok: upstreamHttpStatus >= 200 && upstreamHttpStatus < 300,
    upstreamHttpStatus,
    ...actionTask(body),
    taskCreated: Boolean(body?.taskId),
    providerCalled: inferProviderCalled(body),
    idempotencyKey,
    inputFile,
    authMode: UAT_DIRECT_MODE ? 'uat_direct_bounded' : 'bearer',
    ...extra,
  };
}

export function createChatGptGatewayApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', async (_req, res) => {
    try {
      const upstreamHealth = await upstream('/api/mvp/health');
      const upstreamReachable = upstreamHealth.ok;
      return res.status(upstreamReachable ? 200 : 503).json({
        status: upstreamReachable ? 'ok' : 'degraded',
        service: 'zaojing-chatgpt-gateway',
        version: 'v1',
        upstreamConfigured: Boolean(UPSTREAM_URL),
        upstreamAuthMode: UPSTREAM_AUTH_MODE,
        upstreamReachable,
        upstreamStatus: upstreamHealth.status,
        bootstrapKeyConfigured: Boolean(BOOTSTRAP_KEY_HASH),
        uatDirectMode: UAT_DIRECT_MODE,
        uatDirectDailyLimit: UAT_DIRECT_MODE ? UAT_DIRECT_DAILY_LIMIT : null,
      });
    } catch {
      return res.status(503).json({
        status: 'degraded',
        service: 'zaojing-chatgpt-gateway',
        version: 'v1',
        upstreamConfigured: Boolean(UPSTREAM_URL),
        upstreamAuthMode: UPSTREAM_AUTH_MODE,
        upstreamReachable: false,
        bootstrapKeyConfigured: Boolean(BOOTSTRAP_KEY_HASH),
        uatDirectMode: UAT_DIRECT_MODE,
        uatDirectDailyLimit: UAT_DIRECT_MODE ? UAT_DIRECT_DAILY_LIMIT : null,
      });
    }
  });
  app.get('/openapi.yaml', (_req, res) => {
    const template = fs.readFileSync('chatgpt-action-openapi.yaml', 'utf8');
    const origin = PUBLIC_URL || `${_req.protocol}://${_req.get('host')}`;
    return res.type('application/yaml').send(template.replace('https://zaojing-chatgpt-gateway-uat-REPLACE.run.app', origin));
  });

  // Preflight is non-billable and always public so ChatGPT can diagnose the conversation-file bridge.
  app.post('/v1/images/preflight', async (req, res) => {
    const refs = Array.isArray(req.body?.openaiFileIdRefs) ? req.body.openaiFileIdRefs as OpenAIFileRef[] : [];
    if (refs.length !== 1) {
      return res.status(200).json(requestRejected('exactly_one_image_required', null, { receivedFileRefCount: refs.length }));
    }
    try {
      const image = await downloadOpenAIImage(refs[0]);
      return res.status(200).json({
        ok: true,
        status: 'PREFLIGHT_OK',
        taskCreated: false,
        providerCalled: false,
        fileBridge: 'valid_image',
        diagnostics: image.diagnostics,
      });
    } catch (error) {
      return res.status(200).json(actionSafeFileBridgeFailure(error, 'preflight_image_failed'));
    }
  });

  // Production/default mode remains Bearer-protected. The dedicated UAT deployment may
  // explicitly enable bounded direct mode so ChatGPT can exercise the real file→Veo path
  // even when its Action credential is stale or unavailable.
  if (!UAT_DIRECT_MODE) app.use('/v1', authenticateApiKey);

  app.use('/v1/characters', createChatGptCharacterRouter({ upstream, publicUrl: PUBLIC_URL }));

  app.post('/v1/videos/resolve', async (req, res) => {
    const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      return res.status(200).json(requestRejected('idempotency_key_invalid', idempotencyKey || null));
    }
    try {
      const task = await lookupUpstreamTask(idempotencyKey);
      const binding = await getIntentInputBinding(idempotencyKey);
      if (!task) {
        return res.status(200).json({
          ok: true,
          status: 'INTENT_NOT_FOUND',
          taskId: null,
          taskCreated: false,
          providerCalled: false,
          stage: 'action_intent_resolve',
          error: null,
          retryable: false,
          idempotencyKey,
          inputSource: binding?.inputSource || null,
          recoveredBy: 'durable_idempotency_lookup',
          authMode: UAT_DIRECT_MODE ? 'uat_direct_bounded' : 'bearer',
          recommendedAction: 'No durable task exists for this intent. Classify it as pre-durable-task/client-to-gateway and do not infer a provider failure.',
        });
      }
      if (task?.taskId && binding?.inputSource) await bindInputIntent(idempotencyKey, binding.inputSource, task.taskId);
      return res.status(200).json({
        ok: true,
        ...actionTask(task),
        taskCreated: true,
        providerCalled: inferProviderCalled(task),
        idempotencyKey,
        inputSource: binding?.inputSource || null,
        recoveredBy: 'durable_idempotency_lookup',
        authMode: UAT_DIRECT_MODE ? 'uat_direct_bounded' : 'bearer',
      });
    } catch (error: any) {
      return res.status(200).json({
        ok: false,
        status: 'RESOLVE_FAILED',
        taskId: null,
        taskCreated: null,
        providerCalled: null,
        stage: 'action_intent_resolve',
        error: 'UPSTREAM_LOOKUP_FAILED',
        retryable: true,
        idempotencyKey,
        diagnostics: { message: String(error?.message || error) },
        recommendedAction: 'Retry resolveIdentitySafeVideoIntent with the same idempotencyKey. Do not call create again until resolve is conclusive.',
      });
    }
  });

  app.post('/v1/videos', async (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    const durationSeconds = Number(req.body?.durationSeconds || 4);
    const suppliedIdempotencyKey = String(req.body?.idempotencyKey || '').trim();
    if (UAT_DIRECT_MODE && !suppliedIdempotencyKey) return res.status(200).json(requestRejected('idempotency_key_required_in_uat_direct_mode'));
    const idempotencyKey = suppliedIdempotencyKey || `chatgpt_${crypto.randomUUID()}`;

    if (!prompt || prompt.length > 12_000) return res.status(200).json(requestRejected('prompt_invalid', idempotencyKey));
    if (![4, 6, 8].includes(durationSeconds)) return res.status(200).json(requestRejected('duration_invalid', idempotencyKey));

    let image: GatewayResolvedImage;
    try {
      image = await resolveVideoInput(req.body);
    } catch (error: any) {
      if (error instanceof VideoInputSourceError) {
        return res.status(200).json(requestRejected(error.code, idempotencyKey, { diagnostics: error.diagnostics }));
      }
      if (error instanceof OpenAIFileBridgeError) {
        return res.status(200).json(actionSafeFileBridgeFailure(error, 'create_video_file_bridge_failed', { idempotencyKey }));
      }
      return res.status(200).json({
        ok: false,
        status: 'GATEWAY_ERROR',
        taskCreated: false,
        providerCalled: false,
        error: 'INPUT_SOURCE_RESOLUTION_FAILED',
        stage: 'action_gateway',
        retryable: true,
        idempotencyKey,
        diagnostics: { message: String(error?.message || error) },
      });
    }

    const submittedPrompt = characterIdentityPrompt(prompt, image);
    if (submittedPrompt.length > 12_000) {
      return res.status(200).json(requestRejected('prompt_invalid_after_character_identity_lock', idempotencyKey));
    }

    try {
      await bindInputIntent(idempotencyKey, image.source);
    } catch (error: any) {
      if (error instanceof VideoInputSourceError) {
        return res.status(200).json(requestRejected(error.code, idempotencyKey, { diagnostics: error.diagnostics }));
      }
      return res.status(200).json({
        ok: false,
        status: 'GATEWAY_ERROR',
        taskCreated: false,
        providerCalled: false,
        error: 'INPUT_BINDING_FAILED',
        stage: 'action_gateway',
        retryable: true,
        idempotencyKey,
        inputSource: image.source,
        diagnostics: { message: String(error?.message || error) },
      });
    }

    let admission: UatAdmission | null = null;
    if (UAT_DIRECT_MODE) {
      try {
        admission = await admitUatDirectIntent(idempotencyKey);
      } catch (error: any) {
        return res.status(200).json({
          ok: false,
          status: 'GATEWAY_ERROR',
          taskCreated: false,
          providerCalled: false,
          error: 'UAT_ADMISSION_FAILED',
          stage: 'action_gateway',
          retryable: true,
          idempotencyKey,
          inputFile: image.diagnostics,
          inputSource: image.source,
          diagnostics: { message: String(error?.message || error) },
        });
      }
      if (!admission.allowed) {
        return res.status(200).json(requestRejected('uat_direct_daily_limit_reached', idempotencyKey, { admission, inputSource: image.source }));
      }
    }

    // A retry with the same intent first asks the durable upstream idempotency index.
    // If the first HTTP response was lost after task creation, this returns taskId without
    // performing another provider submission.
    try {
      const existing = await lookupUpstreamTask(idempotencyKey);
      if (existing) {
        await bindInputIntent(idempotencyKey, image.source, existing.taskId || null);
        return res.status(200).json(actionEnvelope(existing, 200, idempotencyKey, image.diagnostics, {
          recoveredBy: 'idempotency_lookup_before_submit',
          admission,
          inputSource: image.source,
        }));
      }
    } catch {
      // Continue to the idempotent start route. The same key is still the safety boundary.
    }

    const form = new FormData();
    form.append('image', new Blob([image.bytes], { type: image.mimeType }), image.name);
    form.append('prompt', submittedPrompt);
    form.append('durationSeconds', String(durationSeconds));
    form.append('identitySafeMode', 'true');
    form.append('inputSourceType', image.source.type);
    if (image.source.type === 'character_reference') {
      form.append('characterId', image.source.characterId);
      form.append('characterReferenceId', image.source.referenceId);
      form.append('identitySpecSha256', image.source.identitySpecSha256);
    }

    try {
      const response = await upstream('/api/mvp/videos/start', { method: 'POST', headers: { 'x-idempotency-key': idempotencyKey }, body: form });
      const body = await responseJson(response);
      if (body?.taskId) await bindInputIntent(idempotencyKey, image.source, body.taskId);
      return res.status(200).json(actionEnvelope(body, response.status, idempotencyKey, image.diagnostics, { admission, inputSource: image.source }));
    } catch (startError: any) {
      // If transport failed after the upstream committed the idempotency/task records,
      // recover that task immediately instead of making ChatGPT guess whether it exists.
      try {
        const recovered = await lookupUpstreamTask(idempotencyKey);
        if (recovered) {
          await bindInputIntent(idempotencyKey, image.source, recovered.taskId || null);
          return res.status(200).json(actionEnvelope(recovered, 200, idempotencyKey, image.diagnostics, {
            recoveredBy: 'idempotency_lookup_after_transport_failure',
            admission,
            inputSource: image.source,
          }));
        }
      } catch (lookupError: any) {
        return res.status(200).json({
          ok: false,
          status: 'UPSTREAM_OUTCOME_UNKNOWN',
          taskId: null,
          taskCreated: null,
          providerCalled: null,
          stage: 'action_upstream_transport',
          error: 'UPSTREAM_REQUEST_AND_LOOKUP_FAILED',
          retryable: true,
          idempotencyKey,
          inputFile: image.diagnostics,
          inputSource: image.source,
          admission,
          diagnostics: {
            startError: String(startError?.message || startError),
            lookupError: String(lookupError?.message || lookupError),
          },
          recommendedAction: 'Call resolveIdentitySafeVideoIntent with the same idempotencyKey before any create retry.',
        });
      }
      return res.status(200).json({
        ok: false,
        status: 'UPSTREAM_OUTCOME_UNKNOWN',
        taskId: null,
        taskCreated: false,
        providerCalled: false,
        stage: 'action_upstream_transport',
        error: 'UPSTREAM_REQUEST_FAILED_NO_TASK_FOUND',
        retryable: true,
        idempotencyKey,
        inputFile: image.diagnostics,
        inputSource: image.source,
        admission,
        diagnostics: { startError: String(startError?.message || startError), lookupResult: 'not_found' },
        recommendedAction: 'Call resolveIdentitySafeVideoIntent with the same idempotencyKey before any create retry.',
      });
    }
  });

  app.get('/v1/videos/:taskId', async (req, res) => {
    try {
      const response = await upstream(`/api/mvp/videos/${encodeURIComponent(req.params.taskId)}`);
      const body = await responseJson(response);
      const binding = await getTaskInputBinding(req.params.taskId);
      return res.status(response.status).json({ ...actionTask(body), inputSource: binding?.inputSource || null });
    } catch (error: any) { return res.status(502).json({ error: 'get_video_failed', detail: String(error?.message || error) }); }
  });

  app.post('/v1/videos/:taskId/recover', async (req, res) => {
    try {
      const response = await upstream(`/api/mvp/videos/${encodeURIComponent(req.params.taskId)}/recover`, { method: 'POST' });
      const body = await responseJson(response);
      const binding = await getTaskInputBinding(req.params.taskId);
      return res.status(response.status).json({ ...actionTask(body), inputSource: binding?.inputSource || null });
    } catch (error: any) { return res.status(502).json({ error: 'recover_video_failed', detail: String(error?.message || error) }); }
  });

  return app;
}

export async function startChatGptGateway() {
  await ensureBootstrapApiKey();
  const app = createChatGptGatewayApp();
  return app.listen(PORT, '0.0.0.0', () => console.log(`[ZAOJING_CHATGPT_GATEWAY] listening on :${PORT}; upstreamAuth=${UPSTREAM_AUTH_MODE}; uatDirect=${UAT_DIRECT_MODE}`));
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) void startChatGptGateway();
