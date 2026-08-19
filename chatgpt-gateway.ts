import express from 'express';
import crypto from 'crypto';
import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { getFirestoreInstance } from './src/server/db/firestore';

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_URL = String(process.env.ZAOJING_MVP_UPSTREAM_URL || '').replace(/\/+$/, '');
const UPSTREAM_AUTH_MODE = String(process.env.ZAOJING_UPSTREAM_AUTH_MODE || 'iap-signed-jwt').trim().toLowerCase();
const PUBLIC_URL = String(process.env.ZAOJING_CHATGPT_PUBLIC_URL || '').replace(/\/+$/, '');
const RUNTIME_SA = String(process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL || '');
const BOOTSTRAP_KEY_HASH = String(process.env.ZAOJING_CHATGPT_BOOTSTRAP_KEY_HASH || '').trim().toLowerCase();
const KEY_COLLECTION = 'mvp_chatgpt_api_keys';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const auth = new GoogleAuth();

type SupportedImageMime = typeof SUPPORTED_IMAGE_MIMES[number];
type OpenAIFileRef = { name?: string; id?: string; mime_type?: string; download_link?: string };
type OpenAIImageDiagnostics = {
  fileIdPresent: boolean;
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
  constructor(public code: string, public httpStatus: number, public diagnostics: Partial<OpenAIImageDiagnostics> = {}) {
    super(code);
  }
}

function sha256(value: Buffer | string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function bearer(req: express.Request): string {
  const value = String(req.header('authorization') || '');
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

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

function fileBridgeErrorResponse(res: express.Response, error: unknown, fallbackError: string) {
  if (error instanceof OpenAIFileBridgeError) {
    return res.status(error.httpStatus).json({
      error: error.code,
      stage: 'action_file_bridge',
      retryable: false,
      diagnostics: error.diagnostics,
    });
  }
  return res.status(502).json({ error: fallbackError, detail: String((error as any)?.message || error) });
}

async function downloadOpenAIImage(ref: OpenAIFileRef): Promise<DownloadedOpenAIImage> {
  const link = String(ref?.download_link || '');
  const initialDiagnostics: Partial<OpenAIImageDiagnostics> = {
    fileIdPresent: Boolean(ref?.id),
    fileName: ref?.name ? String(ref.name) : null,
    declaredMime: normalizeMime(ref?.mime_type),
    downloadHost: downloadHost(link),
  };
  if (!allowedOpenAIFileUrl(link)) throw new OpenAIFileBridgeError('OPENAI_FILE_URL_INVALID', 400, initialDiagnostics);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(link, { signal: controller.signal, redirect: 'follow' });
    const responseMime = normalizeMime(response.headers.get('content-type'));
    if (!response.ok) {
      throw new OpenAIFileBridgeError(`OPENAI_FILE_DOWNLOAD_FAILED_${response.status}`, 502, { ...initialDiagnostics, responseMime });
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_BYTES) {
      throw new OpenAIFileBridgeError('OPENAI_FILE_TOO_LARGE', 400, { ...initialDiagnostics, responseMime, sizeBytes: contentLength });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const detectedMime = detectImageMime(bytes);
    const diagnostics: OpenAIImageDiagnostics = {
      fileIdPresent: Boolean(ref?.id),
      fileName: ref?.name ? String(ref.name) : null,
      declaredMime: normalizeMime(ref?.mime_type),
      responseMime,
      detectedMime,
      sizeBytes: bytes.length,
      downloadHost: downloadHost(link),
      contentSha256: bytes.length ? sha256(bytes) : null,
      prefixHex: bytes.length ? bytes.subarray(0, Math.min(16, bytes.length)).toString('hex') : null,
    };
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new OpenAIFileBridgeError('OPENAI_FILE_TOO_LARGE', 400, diagnostics);
    if (!detectedMime) throw new OpenAIFileBridgeError('OPENAI_FILE_CONTENT_INVALID', 400, diagnostics);
    return { bytes, mimeType: detectedMime, name: normalizedImageName(ref?.name, detectedMime), diagnostics };
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
      });
    }
  });
  app.get('/openapi.yaml', (_req, res) => {
    const template = fs.readFileSync('chatgpt-action-openapi.yaml', 'utf8');
    const origin = PUBLIC_URL || `${_req.protocol}://${_req.get('host')}`;
    return res.type('application/yaml').send(template.replace('https://zaojing-chatgpt-gateway-uat-REPLACE.run.app', origin));
  });

  app.use('/v1', authenticateApiKey);

  app.post('/v1/images/preflight', async (req, res) => {
    try {
      const refs = Array.isArray(req.body?.openaiFileIdRefs) ? req.body.openaiFileIdRefs as OpenAIFileRef[] : [];
      if (refs.length !== 1) return res.status(400).json({ error: 'exactly_one_image_required', stage: 'action_file_bridge' });
      const image = await downloadOpenAIImage(refs[0]);
      return res.json({ status: 'ok', fileBridge: 'valid_image', diagnostics: image.diagnostics });
    } catch (error) {
      return fileBridgeErrorResponse(res, error, 'preflight_image_failed');
    }
  });

  app.post('/v1/videos', async (req, res) => {
    try {
      const prompt = String(req.body?.prompt || '').trim();
      const durationSeconds = Number(req.body?.durationSeconds || 4);
      const refs = Array.isArray(req.body?.openaiFileIdRefs) ? req.body.openaiFileIdRefs as OpenAIFileRef[] : [];
      if (!prompt || prompt.length > 12_000) return res.status(400).json({ error: 'prompt_invalid' });
      if (![4, 6, 8].includes(durationSeconds)) return res.status(400).json({ error: 'duration_invalid' });
      if (refs.length !== 1) return res.status(400).json({ error: 'exactly_one_image_required' });
      const image = await downloadOpenAIImage(refs[0]);
      const form = new FormData();
      form.append('image', new Blob([image.bytes], { type: image.mimeType }), image.name);
      form.append('prompt', prompt);
      form.append('durationSeconds', String(durationSeconds));
      form.append('identitySafeMode', 'true');
      const idempotencyKey = String(req.body?.idempotencyKey || `chatgpt_${crypto.randomUUID()}`);
      const response = await upstream('/api/mvp/videos/start', { method: 'POST', headers: { 'x-idempotency-key': idempotencyKey }, body: form });
      const body = await responseJson(response);
      return res.status(response.status).json({ ...actionTask(body), idempotencyKey, inputFile: image.diagnostics });
    } catch (error) {
      return fileBridgeErrorResponse(res, error, 'create_video_failed');
    }
  });

  app.get('/v1/videos/:taskId', async (req, res) => {
    try {
      const response = await upstream(`/api/mvp/videos/${encodeURIComponent(req.params.taskId)}`);
      const body = await responseJson(response);
      return res.status(response.status).json(actionTask(body));
    } catch (error: any) { return res.status(502).json({ error: 'get_video_failed', detail: String(error?.message || error) }); }
  });

  app.post('/v1/videos/:taskId/recover', async (req, res) => {
    try {
      const response = await upstream(`/api/mvp/videos/${encodeURIComponent(req.params.taskId)}/recover`, { method: 'POST' });
      const body = await responseJson(response);
      return res.status(response.status).json(actionTask(body));
    } catch (error: any) { return res.status(502).json({ error: 'recover_video_failed', detail: String(error?.message || error) }); }
  });

  return app;
}

export async function startChatGptGateway() {
  await ensureBootstrapApiKey();
  const app = createChatGptGatewayApp();
  return app.listen(PORT, '0.0.0.0', () => console.log(`[ZAOJING_CHATGPT_GATEWAY] listening on :${PORT}; upstreamAuth=${UPSTREAM_AUTH_MODE}`));
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) void startChatGptGateway();