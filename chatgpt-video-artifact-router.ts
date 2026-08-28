import express from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import { getFirestoreInstance } from './src/server/db/firestore';
import { isIdentitySafeCompletionSatisfied, type MvpVideoTask } from './src/mvp/mvpContract';

const TASK_COLLECTION = 'mvp_video_tasks';
const ACCESS_TOKEN_COLLECTION = 'mvp_chatgpt_video_artifact_access';
const UAT_ADMISSION_COLLECTION = 'mvp_chatgpt_uat_admissions';
const UAT_QUOTA_COLLECTION = 'mvp_chatgpt_uat_daily_quota';
const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600;
const MIN_SIGNED_URL_TTL_SECONDS = 300;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const UPSTREAM_URL = String(process.env.ZAOJING_MVP_UPSTREAM_URL || '').replace(/\/+$/, '');
const UPSTREAM_AUTH_MODE = String(process.env.ZAOJING_UPSTREAM_AUTH_MODE || 'iap-signed-jwt').trim().toLowerCase();
const RUNTIME_SA = String(process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL || '');
const UAT_DIRECT_MODE = String(process.env.ZAOJING_CHATGPT_UAT_DIRECT || '').trim().toLowerCase() === 'true';
const UAT_DIRECT_DAILY_LIMIT = Math.max(1, Math.min(100, Number(process.env.ZAOJING_CHATGPT_UAT_DAILY_LIMIT || 12) || 12));
const auth = new GoogleAuth();

type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
type UatAdmission = { allowed: boolean; existingIntent: boolean; day: string; count: number; limit: number };

let cachedIapJwt: { token: string; expiresAt: number } | null = null;
let cachedCloudRunIdToken: { token: string; expiresAt: number } | null = null;

function signedUrlTtlSeconds(): number {
  const configured = Number(process.env.ZAOJING_VIDEO_SIGNED_URL_TTL_SECONDS || DEFAULT_SIGNED_URL_TTL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_SIGNED_URL_TTL_SECONDS;
  return Math.max(MIN_SIGNED_URL_TTL_SECONDS, Math.min(MAX_SIGNED_URL_TTL_SECONDS, Math.floor(configured)));
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function utcDayKey(): string { return new Date().toISOString().slice(0, 10); }

function publicOrigin(req: express.Request): string {
  const configured = String(process.env.ZAOJING_CHATGPT_PUBLIC_URL || '').replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

function safeDownloadName(taskId: string): string {
  const safeTaskId = String(taskId || 'video').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
  return `zaojing_${safeTaskId}.mp4`;
}

function artifactFailure(params: {
  taskId: string;
  status: string;
  error: string;
  retryable: boolean;
  detail?: string;
}) {
  return {
    ok: false,
    taskId: params.taskId,
    status: params.status,
    videoReady: false,
    videoUrl: null,
    downloadUrl: null,
    expiresAt: null,
    error: params.error,
    retryable: params.retryable,
    ...(params.detail ? { detail: params.detail } : {}),
  };
}

function durableFailure(error: string, idempotencyKey: string | null = null, detail?: Record<string, unknown>) {
  return {
    ok: false,
    status: 'REQUEST_REJECTED',
    taskCreated: false,
    providerCalled: false,
    error,
    stage: 'durable_keyframe_input',
    retryable: false,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(detail || {}),
  };
}

function parseSingleRange(raw: string | undefined, sizeBytes: number): { start: number; end: number } | null {
  if (!raw) return null;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(raw.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : sizeBytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= sizeBytes || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, sizeBytes - 1) };
}

function detectImageMime(bytes: Buffer): SupportedImageMime | null {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

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

function durableEnvelope(body: any, upstreamHttpStatus: number, idempotencyKey: string, inputFile: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    ok: upstreamHttpStatus >= 200 && upstreamHttpStatus < 300,
    upstreamHttpStatus,
    ...actionTask(body),
    taskCreated: Boolean(body?.taskId),
    providerCalled: inferProviderCalled(body),
    idempotencyKey,
    inputFile,
    inputSource: 'durable_gcs_asset',
    authMode: UAT_DIRECT_MODE ? 'uat_direct_bounded' : 'bearer',
    ...extra,
  };
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

async function loadVerifiedTask(taskId: string): Promise<{ task: MvpVideoTask; bucketName: string; objectPath: string } | null> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('FIRESTORE_UNAVAILABLE');
  const snap = await db.collection(TASK_COLLECTION).doc(taskId).get();
  if (!snap.exists) return null;
  const task = snap.data() as MvpVideoTask;
  if (task.status !== 'COMPLETED' || !isIdentitySafeCompletionSatisfied(task)) return null;
  const bucketName = String(task.outputBucket || '').trim();
  const objectPath = String(task.outputObjectPath || '').trim();
  if (!bucketName || !objectPath || task.artifactPersisted !== true || task.artifactVerified !== true) return null;
  return { task, bucketName, objectPath };
}

async function issueGatewayCapability(params: {
  taskId: string;
  expiresAtMs: number;
  origin: string;
}): Promise<{ videoUrl: string; downloadUrl: string }> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('FIRESTORE_UNAVAILABLE');
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  await db.collection(ACCESS_TOKEN_COLLECTION).doc(tokenHash).set({
    taskId: params.taskId,
    purpose: 'chatgpt_verified_video_artifact',
    createdAt: Date.now(),
    expiresAt: params.expiresAtMs,
  });
  const base = `${params.origin}/v1/videos/artifact-access/${encodeURIComponent(token)}`;
  return { videoUrl: base, downloadUrl: `${base}?download=1` };
}

export function createChatGptVideoArtifactRouter() {
  const router = express.Router();
  const storage = new Storage();
  const durableUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 16 },
  }).single('image');

  // Internal P0-7 ingress. It is deliberately not part of the ChatGPT Actions OpenAPI.
  // Production requests remain protected by the gateway /v1 auth middleware; bounded UAT
  // direct mode uses the same Firestore-backed new-intent quota as the conversation path.
  router.post('/durable', (req, res, next) => {
    durableUpload(req, res, (error) => {
      if (error) {
        return res.status(200).json(durableFailure('durable_keyframe_upload_invalid', null, {
          message: error instanceof Error ? error.message : String(error),
        }));
      }
      return next();
    });
  }, async (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    const durationSeconds = Number(req.body?.durationSeconds || 4);
    const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
    const inputSource = String(req.body?.inputSource || '').trim();
    const assetId = String(req.body?.assetId || '').trim();
    const expectedSha256 = String(req.body?.contentSha256 || '').trim().toLowerCase();
    const keyframeVersion = Number(req.body?.keyframeVersion || 0);
    const expectedMime = String(req.body?.mimeType || '').trim().toLowerCase();
    const outputBucket = String(req.body?.outputBucket || '').trim();
    const outputObjectPath = String(req.body?.outputObjectPath || '').trim();

    if (UAT_DIRECT_MODE && !idempotencyKey) return res.status(200).json(durableFailure('idempotency_key_required_in_uat_direct_mode'));
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) return res.status(200).json(durableFailure('idempotency_key_invalid', idempotencyKey || null));
    if (!prompt || prompt.length > 12_000) return res.status(200).json(durableFailure('prompt_invalid', idempotencyKey));
    if (![4, 6, 8].includes(durationSeconds)) return res.status(200).json(durableFailure('duration_invalid', idempotencyKey));
    if (inputSource !== 'durable_gcs_asset') return res.status(200).json(durableFailure('durable_input_source_invalid', idempotencyKey));
    if (!assetId || !Number.isInteger(keyframeVersion) || keyframeVersion < 1) return res.status(200).json(durableFailure('durable_asset_identity_invalid', idempotencyKey));
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) return res.status(200).json(durableFailure('durable_content_hash_invalid', idempotencyKey));
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(expectedMime)) return res.status(200).json(durableFailure('durable_mime_invalid', idempotencyKey));
    if (!outputBucket || !outputObjectPath) return res.status(200).json(durableFailure('durable_gcs_location_missing', idempotencyKey));
    if (!req.file?.buffer?.length) return res.status(200).json(durableFailure('durable_image_missing', idempotencyKey));

    const bytes = Buffer.from(req.file.buffer);
    const detectedMime = detectImageMime(bytes);
    const actualSha256 = sha256(bytes);
    if (!detectedMime || detectedMime !== expectedMime) {
      return res.status(200).json(durableFailure('durable_mime_mismatch', idempotencyKey, { detectedMime }));
    }
    if (actualSha256 !== expectedSha256) {
      return res.status(200).json(durableFailure('durable_hash_mismatch', idempotencyKey));
    }

    const inputFile = {
      referenceKind: 'durable_gcs_asset',
      assetId,
      keyframeVersion,
      outputBucket,
      outputObjectPath,
      fileName: req.file.originalname || null,
      declaredMime: expectedMime,
      detectedMime,
      sizeBytes: bytes.length,
      contentSha256: actualSha256,
      prefixHex: bytes.subarray(0, Math.min(16, bytes.length)).toString('hex'),
    };

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
          stage: 'durable_keyframe_gateway',
          retryable: true,
          idempotencyKey,
          inputFile,
          diagnostics: { message: String(error?.message || error) },
        });
      }
      if (!admission.allowed) {
        return res.status(200).json(durableFailure('uat_direct_daily_limit_reached', idempotencyKey, { admission }));
      }
    }

    try {
      const existing = await lookupUpstreamTask(idempotencyKey);
      if (existing) {
        return res.status(200).json(durableEnvelope(existing, 200, idempotencyKey, inputFile, {
          recoveredBy: 'idempotency_lookup_before_submit',
          admission,
        }));
      }
    } catch {
      // The upstream start endpoint is itself idempotent; continue with the same key.
    }

    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)], { type: detectedMime }), req.file.originalname || `keyframe.${detectedMime === 'image/png' ? 'png' : detectedMime === 'image/webp' ? 'webp' : 'jpg'}`);
    form.append('prompt', prompt);
    form.append('durationSeconds', String(durationSeconds));
    form.append('identitySafeMode', 'true');

    try {
      const response = await upstream('/api/mvp/videos/start', {
        method: 'POST',
        headers: { 'x-idempotency-key': idempotencyKey },
        body: form,
      });
      const body = await responseJson(response);
      return res.status(200).json(durableEnvelope(body, response.status, idempotencyKey, inputFile, { admission }));
    } catch (startError: any) {
      try {
        const recovered = await lookupUpstreamTask(idempotencyKey);
        if (recovered) {
          return res.status(200).json(durableEnvelope(recovered, 200, idempotencyKey, inputFile, {
            recoveredBy: 'idempotency_lookup_after_transport_failure',
            admission,
          }));
        }
      } catch (lookupError: any) {
        return res.status(200).json({
          ok: false,
          status: 'UPSTREAM_OUTCOME_UNKNOWN',
          taskId: null,
          taskCreated: null,
          providerCalled: null,
          stage: 'durable_keyframe_upstream_transport',
          error: 'UPSTREAM_REQUEST_AND_LOOKUP_FAILED',
          retryable: true,
          idempotencyKey,
          inputFile,
          admission,
          diagnostics: {
            startError: String(startError?.message || startError),
            lookupError: String(lookupError?.message || lookupError),
          },
          recommendedAction: 'Resolve the same idempotencyKey before any create retry.',
        });
      }
      return res.status(200).json({
        ok: false,
        status: 'UPSTREAM_OUTCOME_UNKNOWN',
        taskId: null,
        taskCreated: false,
        providerCalled: false,
        stage: 'durable_keyframe_upstream_transport',
        error: 'UPSTREAM_REQUEST_FAILED_NO_TASK_FOUND',
        retryable: true,
        idempotencyKey,
        inputFile,
        admission,
        diagnostics: { startError: String(startError?.message || startError), lookupResult: 'not_found' },
        recommendedAction: 'Resolve the same idempotencyKey before any create retry.',
      });
    }
  });

  // Public capability endpoint used only when Cloud IAM cannot produce a native GCS V4 Signed URL.
  // The bearer capability is 256 random bits; only its SHA-256 hash is stored in Firestore.
  router.get('/artifact-access/:token', async (req, res) => {
    const token = String(req.params.token || '').trim();
    if (!/^[A-Za-z0-9_-]{40,80}$/.test(token)) return res.status(404).end();
    try {
      const db = getFirestoreInstance();
      if (!db) return res.status(503).end();
      const accessSnap = await db.collection(ACCESS_TOKEN_COLLECTION).doc(sha256(token)).get();
      if (!accessSnap.exists) return res.status(404).end();
      const access = accessSnap.data() as any;
      const expiresAt = Number(access?.expiresAt || 0);
      const taskId = String(access?.taskId || '');
      if (!taskId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return res.status(410).end();

      const resolved = await loadVerifiedTask(taskId);
      if (!resolved) return res.status(404).end();
      const file = storage.bucket(resolved.bucketName).file(resolved.objectPath);
      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size || resolved.task.sizeBytes || 0);
      const contentType = String(metadata.contentType || resolved.task.contentType || 'video/mp4');
      if (sizeBytes < 1000 || !contentType.toLowerCase().startsWith('video/')) return res.status(404).end();

      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${safeDownloadName(taskId)}"`);

      const rawRange = typeof req.headers.range === 'string' ? req.headers.range : undefined;
      const range = parseSingleRange(rawRange, sizeBytes);
      if (rawRange && !range) {
        res.status(416).setHeader('Content-Range', `bytes */${sizeBytes}`);
        return res.end();
      }

      if (range) {
        const length = range.end - range.start + 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${sizeBytes}`);
        res.setHeader('Content-Length', String(length));
        const stream = file.createReadStream({ start: range.start, end: range.end });
        stream.on('error', () => { if (!res.headersSent) res.status(502); res.end(); });
        return stream.pipe(res);
      }

      res.setHeader('Content-Length', String(sizeBytes));
      const stream = file.createReadStream();
      stream.on('error', () => { if (!res.headersSent) res.status(502); res.end(); });
      return stream.pipe(res);
    } catch {
      return res.status(503).end();
    }
  });

  router.get('/:taskId/artifact', async (req, res) => {
    const taskId = String(req.params.taskId || '').trim();
    if (!taskId || taskId.length > 200) {
      return res.status(400).json(artifactFailure({
        taskId,
        status: 'REQUEST_REJECTED',
        error: 'task_id_invalid',
        retryable: false,
      }));
    }

    try {
      const db = getFirestoreInstance();
      if (!db) {
        return res.status(503).json(artifactFailure({
          taskId,
          status: 'ARTIFACT_URL_FAILED',
          error: 'firestore_unavailable',
          retryable: true,
        }));
      }

      const snap = await db.collection(TASK_COLLECTION).doc(taskId).get();
      if (!snap.exists) {
        return res.status(404).json(artifactFailure({
          taskId,
          status: 'TASK_NOT_FOUND',
          error: 'task_not_found',
          retryable: false,
        }));
      }

      const task = snap.data() as MvpVideoTask;
      if (task.status !== 'COMPLETED' || !isIdentitySafeCompletionSatisfied(task)) {
        return res.status(409).json(artifactFailure({
          taskId,
          status: 'VIDEO_NOT_READY',
          error: 'verified_video_not_ready',
          retryable: task.status !== 'FAILED',
        }));
      }

      const bucketName = String(task.outputBucket || '').trim();
      const objectPath = String(task.outputObjectPath || '').trim();
      if (!bucketName || !objectPath || task.artifactPersisted !== true || task.artifactVerified !== true) {
        return res.status(409).json(artifactFailure({
          taskId,
          status: 'ARTIFACT_NOT_READY',
          error: 'verified_artifact_location_missing',
          retryable: true,
        }));
      }

      const file = storage.bucket(bucketName).file(objectPath);
      const [exists] = await file.exists();
      if (!exists) {
        return res.status(404).json(artifactFailure({
          taskId,
          status: 'ARTIFACT_NOT_FOUND',
          error: 'persisted_artifact_missing',
          retryable: true,
        }));
      }

      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size || task.sizeBytes || 0);
      const contentType = String(metadata.contentType || task.contentType || 'video/mp4');
      if (sizeBytes < 1000 || !contentType.toLowerCase().startsWith('video/')) {
        return res.status(409).json(artifactFailure({
          taskId,
          status: 'ARTIFACT_INVALID',
          error: 'persisted_artifact_invalid',
          retryable: true,
        }));
      }

      const ttlSeconds = signedUrlTtlSeconds();
      const expiresAtMs = Date.now() + ttlSeconds * 1000;
      let videoUrl: string;
      let downloadUrl: string;
      let deliveryMode: 'gcs_v4_signed_url' | 'gateway_capability_url' = 'gcs_v4_signed_url';
      try {
        const common = {
          version: 'v4' as const,
          action: 'read' as const,
          expires: expiresAtMs,
          responseType: contentType,
        };
        [videoUrl] = await file.getSignedUrl(common);
        [downloadUrl] = await file.getSignedUrl({
          ...common,
          responseDisposition: `attachment; filename="${safeDownloadName(taskId)}"`,
        });
      } catch {
        deliveryMode = 'gateway_capability_url';
        const capability = await issueGatewayCapability({ taskId, expiresAtMs, origin: publicOrigin(req) });
        videoUrl = capability.videoUrl;
        downloadUrl = capability.downloadUrl;
      }

      return res.status(200).json({
        ok: true,
        taskId,
        status: task.status,
        videoReady: true,
        videoUrl,
        downloadUrl,
        deliveryMode,
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresInSeconds: ttlSeconds,
        sizeBytes,
        contentType,
        artifactPersisted: true,
        artifactVerified: true,
      });
    } catch (error: any) {
      return res.status(503).json(artifactFailure({
        taskId,
        status: 'ARTIFACT_URL_FAILED',
        error: 'artifact_url_generation_failed',
        retryable: true,
        detail: String(error?.message || error),
      }));
    }
  });

  return router;
}
