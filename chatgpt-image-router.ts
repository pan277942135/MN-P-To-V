import express from 'express';
import crypto from 'crypto';
import { GoogleAuth } from 'google-auth-library';
import { getFirestoreInstance } from './src/server/db/firestore';

const UPSTREAM_URL = String(process.env.ZAOJING_MVP_UPSTREAM_URL || '').replace(/\/+$/, '');
const UPSTREAM_AUTH_MODE = String(process.env.ZAOJING_UPSTREAM_AUTH_MODE || 'iap-signed-jwt').trim().toLowerCase();
const PUBLIC_URL = String(process.env.ZAOJING_CHATGPT_PUBLIC_URL || '').replace(/\/+$/, '');
const RUNTIME_SA = String(process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL || '');
const UAT_DIRECT_MODE = String(process.env.ZAOJING_CHATGPT_UAT_DIRECT || '').trim().toLowerCase() === 'true';
const UAT_DIRECT_DAILY_LIMIT = Math.max(1, Math.min(100, Number(process.env.ZAOJING_CHATGPT_UAT_DAILY_LIMIT || 12) || 12));
const KEY_COLLECTION = 'mvp_chatgpt_api_keys';
const UAT_ADMISSION_COLLECTION = 'mvp_chatgpt_uat_admissions';
const UAT_QUOTA_COLLECTION = 'mvp_chatgpt_uat_daily_quota';
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

class OpenAIFileBridgeError extends Error {
  constructor(public code: string, public diagnostics: Partial<OpenAIImageDiagnostics> = {}) {
    super(code);
  }
}

function sha256(value: Buffer | string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function utcDayKey(): string { return new Date().toISOString().slice(0, 10); }
function bearer(req: express.Request): string {
  const value = String(req.header('authorization') || '');
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

async function authenticateApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const token = bearer(req);
    if (!token.startsWith('zjg_') || token.length < 32 || token.length > 256) return res.status(401).json({ error: 'invalid_api_key' });
    const db = getFirestoreInstance();
    if (!db) return res.status(503).json({ error: 'firestore_unavailable' });
    const snap = await db.collection(KEY_COLLECTION).doc(sha256(token)).get();
    if (!snap.exists || snap.data()?.revokedAt) return res.status(401).json({ error: 'invalid_api_key' });
    return next();
  } catch (error: any) {
    return res.status(500).json({ error: 'authentication_failed', detail: String(error?.message || error) });
  }
}

async function admitUatDirectIntent(idempotencyKey: string) {
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
      return { allowed: true, existingIntent: true, day, count: Number(admissionSnap.data()?.dayCount || 0), limit: UAT_DIRECT_DAILY_LIMIT };
    }
    const quotaSnap = await tx.get(quotaRef);
    const count = Number(quotaSnap.data()?.count || 0);
    if (count >= UAT_DIRECT_DAILY_LIMIT) return { allowed: false, existingIntent: false, day, count, limit: UAT_DIRECT_DAILY_LIMIT };
    const nextCount = count + 1;
    tx.create(admissionRef, { idempotencyKeyHash: intentHash, day, dayCount: nextCount, createdAt: Date.now(), purpose: 'head-only-image' });
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
function normalizeMime(raw: unknown): string | null {
  const mime = String(raw || '').split(';')[0].trim().toLowerCase();
  return mime || null;
}
function downloadHost(raw: string): string | null { try { return new URL(raw).hostname.toLowerCase(); } catch { return null; } }
function detectImageMime(bytes: Buffer): SupportedImageMime | null {
  if (!bytes || bytes.length < 12) return null;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return jpeg ? 'image/jpeg' : png ? 'image/png' : webp ? 'image/webp' : null;
}
function extensionForMime(mime: SupportedImageMime) { return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'; }
function normalizedImageName(rawName: unknown, mime: SupportedImageMime): string {
  const original = String(rawName || 'head-only-source').split(/[\\/]/).pop() || 'head-only-source';
  const stem = original.replace(/\.[A-Za-z0-9]{1,10}$/, '') || 'head-only-source';
  return `${stem}.${extensionForMime(mime)}`;
}
function refDiagnostics(ref: OpenAIFileRef | undefined): Partial<OpenAIImageDiagnostics> {
  if (typeof ref === 'string') return { referenceKind: 'string_file_id', fileIdPresent: ref.trim().length > 0, downloadLinkPresent: false, fileName: null, declaredMime: null, downloadHost: null };
  if (ref && typeof ref === 'object') {
    const link = String(ref.download_link || '');
    return { referenceKind: 'object', fileIdPresent: Boolean(ref.id), downloadLinkPresent: Boolean(link), fileName: ref.name ? String(ref.name) : null, declaredMime: normalizeMime(ref.mime_type), downloadHost: downloadHost(link) };
  }
  return { referenceKind: 'unknown', fileIdPresent: false, downloadLinkPresent: false, fileName: null, declaredMime: null, downloadHost: null };
}

async function downloadOpenAIImage(ref: OpenAIFileRef): Promise<DownloadedOpenAIImage> {
  const initial = refDiagnostics(ref);
  const objectRef = typeof ref === 'string' ? null : ref;
  const link = String(objectRef?.download_link || '');
  if (!allowedOpenAIFileUrl(link)) throw new OpenAIFileBridgeError('OPENAI_FILE_URL_INVALID', initial);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(link, { signal: controller.signal, redirect: 'follow' });
    const responseMime = normalizeMime(response.headers.get('content-type'));
    if (!response.ok) throw new OpenAIFileBridgeError(`OPENAI_FILE_DOWNLOAD_FAILED_${response.status}`, { ...initial, responseMime });
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_BYTES) throw new OpenAIFileBridgeError('OPENAI_FILE_TOO_LARGE', { ...initial, responseMime, sizeBytes: contentLength });
    const bytes = Buffer.from(await response.arrayBuffer());
    const detectedMime = detectImageMime(bytes);
    const diagnostics: OpenAIImageDiagnostics = {
      referenceKind: initial.referenceKind || 'unknown',
      fileIdPresent: initial.fileIdPresent === true,
      downloadLinkPresent: initial.downloadLinkPresent === true,
      fileName: initial.fileName || null,
      declaredMime: initial.declaredMime || null,
      responseMime,
      detectedMime,
      sizeBytes: bytes.length,
      downloadHost: initial.downloadHost || null,
      contentSha256: bytes.length ? sha256(bytes) : null,
      prefixHex: bytes.length ? bytes.subarray(0, Math.min(16, bytes.length)).toString('hex') : null,
    };
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new OpenAIFileBridgeError('OPENAI_FILE_TOO_LARGE', diagnostics);
    if (!detectedMime) throw new OpenAIFileBridgeError('OPENAI_FILE_CONTENT_INVALID', diagnostics);
    return { bytes, mimeType: detectedMime, name: normalizedImageName(objectRef?.name, detectedMime), diagnostics };
  } finally { clearTimeout(timer); }
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
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ payload }),
  });
  const body = await response.json() as any;
  if (!response.ok || !body?.signedJwt) throw new Error('IAP_SIGN_JWT_FAILED');
  cachedIapJwt = { token: String(body.signedJwt), expiresAt: exp * 1000 };
  return cachedIapJwt.token;
}
async function getCloudRunIdToken(): Promise<string> {
  if (cachedCloudRunIdToken && cachedCloudRunIdToken.expiresAt - Date.now() > 60_000) return cachedCloudRunIdToken.token;
  if (!UPSTREAM_URL) throw new Error('ZAOJING_MVP_UPSTREAM_URL is missing');
  const endpoint = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity' + `?audience=${encodeURIComponent(UPSTREAM_URL)}&format=full`;
  const response = await fetch(endpoint, { headers: { 'Metadata-Flavor': 'Google' } });
  const token = (await response.text()).trim();
  if (!response.ok || !token) throw new Error(`CLOUD_RUN_ID_TOKEN_FAILED_${response.status}`);
  cachedCloudRunIdToken = { token, expiresAt: Date.now() + 5 * 60_000 };
  return token;
}
async function upstream(path: string, init: RequestInit = {}) {
  if (!UPSTREAM_URL) throw new Error('ZAOJING_MVP_UPSTREAM_URL is missing');
  const token = UPSTREAM_AUTH_MODE === 'cloud-run-id-token' ? await getCloudRunIdToken() : await getIapServiceJwt();
  return fetch(`${UPSTREAM_URL}${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers).entries()), Authorization: `Bearer ${token}` } });
}
async function responseJson(response: Response): Promise<any> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: 'upstream_non_json', httpStatus: response.status }; }
}

function publicOrigin(req: express.Request) { return PUBLIC_URL || `${req.protocol}://${req.get('host')}`; }
function actionSafeTask(body: any, req: express.Request) {
  const imageReady = body?.status === 'COMPLETED' && body?.qaPassed === true;
  return {
    taskId: body?.taskId || null,
    status: body?.status || null,
    mode: body?.mode || 'HEAD_ONLY_CHARACTER_SWAP',
    characterId: body?.characterId || null,
    characterName: body?.characterName || null,
    targetHeadBodyRatio: body?.targetHeadBodyRatio || 9,
    generatorAttempt: body?.generatorAttempt || 0,
    repairAttempts: body?.repairAttempts || 0,
    qaPassed: body?.qaPassed === true,
    qaReport: body?.qaReport || null,
    firstAttemptQaReport: body?.firstAttemptQaReport || null,
    artifactPersisted: body?.artifactPersisted === true,
    artifactVerified: body?.artifactVerified === true,
    sizeBytes: body?.sizeBytes || null,
    imageReady,
    imageUrl: imageReady && body?.taskId ? `${publicOrigin(req)}/v1/images/${encodeURIComponent(body.taskId)}/stream` : null,
    error: body?.error || null,
  };
}

function bridgeFailure(error: unknown, idempotencyKey?: string) {
  if (error instanceof OpenAIFileBridgeError) {
    return { ok: false, status: 'FILE_BRIDGE_FAILED', taskCreated: false, generatorCalled: false, error: error.code, stage: 'action_file_bridge', retryable: false, diagnostics: error.diagnostics, ...(idempotencyKey ? { idempotencyKey } : {}) };
  }
  return { ok: false, status: 'GATEWAY_ERROR', taskCreated: false, generatorCalled: null, error: String((error as any)?.message || error), stage: 'action_gateway', retryable: true, ...(idempotencyKey ? { idempotencyKey } : {}) };
}

export function createChatGptImageRouter() {
  const router = express.Router();
  const protect = UAT_DIRECT_MODE ? (_req: express.Request, _res: express.Response, next: express.NextFunction) => next() : authenticateApiKey;

  router.post('/head-swap', protect, async (req, res) => {
    const characterId = String(req.body?.characterId || '').trim();
    const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
    const targetHeadBodyRatio = Number(req.body?.targetHeadBodyRatio || 9);
    const refs = Array.isArray(req.body?.openaiFileIdRefs) ? req.body.openaiFileIdRefs as OpenAIFileRef[] : [];
    if (!characterId) return res.status(200).json({ ok: false, status: 'REQUEST_REJECTED', taskCreated: false, generatorCalled: false, error: 'character_id_required', retryable: false });
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) return res.status(200).json({ ok: false, status: 'REQUEST_REJECTED', taskCreated: false, generatorCalled: false, error: 'idempotency_key_invalid', retryable: false });
    if (targetHeadBodyRatio !== 9) return res.status(200).json({ ok: false, status: 'REQUEST_REJECTED', taskCreated: false, generatorCalled: false, error: 'target_head_body_ratio_must_be_9', retryable: false });
    if (refs.length !== 1) return res.status(200).json({ ok: false, status: 'REQUEST_REJECTED', taskCreated: false, generatorCalled: false, error: 'exactly_one_image_required', retryable: false, receivedFileRefCount: refs.length });

    let image: DownloadedOpenAIImage;
    try { image = await downloadOpenAIImage(refs[0]); }
    catch (error) { return res.status(200).json(bridgeFailure(error, idempotencyKey)); }

    let admission: any = null;
    if (UAT_DIRECT_MODE) {
      try { admission = await admitUatDirectIntent(idempotencyKey); }
      catch (error) { return res.status(200).json(bridgeFailure(error, idempotencyKey)); }
      if (!admission.allowed) return res.status(200).json({ ok: false, status: 'REQUEST_REJECTED', taskCreated: false, generatorCalled: false, error: 'uat_direct_daily_limit_reached', retryable: false, idempotencyKey, admission });
    }

    const form = new FormData();
    form.append('image', new Blob([image.bytes], { type: image.mimeType }), image.name);
    form.append('characterId', characterId);
    form.append('targetHeadBodyRatio', '9');
    form.append('idempotencyKey', idempotencyKey);

    try {
      const response = await upstream('/api/mvp/images/head-swap', { method: 'POST', headers: { 'x-idempotency-key': idempotencyKey }, body: form });
      const body = await responseJson(response);
      const safe = actionSafeTask(body, req);
      return res.status(200).json({
        ok: response.ok && !body?.error,
        upstreamHttpStatus: response.status,
        ...safe,
        taskCreated: Boolean(body?.taskId),
        generatorCalled: Number(body?.generatorAttempt || 0) > 0,
        idempotencyKey,
        inputFile: image.diagnostics,
        admission,
        authMode: UAT_DIRECT_MODE ? 'uat_direct_bounded' : 'bearer',
      });
    } catch (error) {
      return res.status(200).json({ ...bridgeFailure(error, idempotencyKey), inputFile: image.diagnostics, admission });
    }
  });

  router.get('/:taskId', protect, async (req, res) => {
    try {
      const response = await upstream(`/api/mvp/images/${encodeURIComponent(req.params.taskId)}`);
      const body = await responseJson(response);
      return res.status(200).json({ ok: response.ok, upstreamHttpStatus: response.status, ...actionSafeTask(body, req) });
    } catch (error) {
      return res.status(200).json(bridgeFailure(error));
    }
  });

  // Public artifact proxy: task IDs are unguessable UUIDs, and the upstream only serves
  // artifacts whose final QA gate passed. This allows ChatGPT/web clients to render the image
  // without exposing GCS credentials or an internal storage URI.
  router.get('/:taskId/stream', async (req, res) => {
    try {
      const query = req.query.download === '1' || req.query.download === 'true' ? '?download=1' : '';
      const response = await upstream(`/api/mvp/images/${encodeURIComponent(req.params.taskId)}/stream${query}`);
      if (!response.ok) {
        const body = await responseJson(response);
        return res.status(response.status).json(body);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', bytes.length);
      res.setHeader('Cache-Control', 'private, max-age=300');
      if (query) res.setHeader('Content-Disposition', `attachment; filename="zaojing_${req.params.taskId}.${contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'}"`);
      return res.send(bytes);
    } catch (error: any) {
      return res.status(502).json({ error: 'image_stream_proxy_failed', detail: String(error?.message || error) });
    }
  });

  return router;
}
