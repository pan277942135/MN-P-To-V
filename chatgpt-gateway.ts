import express from 'express';
import crypto from 'crypto';
import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { getFirestoreInstance } from './src/server/db/firestore';

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_URL = String(process.env.ZAOJING_MVP_UPSTREAM_URL || '').replace(/\/+$/, '');
const PUBLIC_URL = String(process.env.ZAOJING_CHATGPT_PUBLIC_URL || '').replace(/\/+$/, '');
const RUNTIME_SA = String(process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL || '');
const KEY_COLLECTION = 'mvp_chatgpt_api_keys';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const auth = new GoogleAuth();

type OpenAIFileRef = { name?: string; id?: string; mime_type?: string; download_link?: string };

function sha256(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
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

async function downloadOpenAIImage(ref: OpenAIFileRef): Promise<{ bytes: Buffer; mimeType: string; name: string }> {
  const link = String(ref?.download_link || '');
  if (!allowedOpenAIFileUrl(link)) throw new Error('OPENAI_FILE_URL_INVALID');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(link, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`OPENAI_FILE_DOWNLOAD_FAILED_${response.status}`);
    const declared = String(ref?.mime_type || response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(declared)) throw new Error('OPENAI_FILE_TYPE_UNSUPPORTED');
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_BYTES) throw new Error('OPENAI_FILE_TOO_LARGE');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('OPENAI_FILE_TOO_LARGE');
    return { bytes, mimeType: declared, name: String(ref?.name || 'identity-reference') };
  } finally { clearTimeout(timer); }
}

let cachedIapJwt: { token: string; expiresAt: number } | null = null;

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

async function upstream(path: string, init: RequestInit = {}): Promise<Response> {
  if (!UPSTREAM_URL) throw new Error('ZAOJING_MVP_UPSTREAM_URL is missing');
  const iapJwt = await getIapServiceJwt();
  return fetch(`${UPSTREAM_URL}${path}`, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers).entries()), Authorization: `Bearer ${iapJwt}` },
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
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'zaojing-chatgpt-gateway', version: 'v1', upstreamConfigured: Boolean(UPSTREAM_URL) }));
  app.get('/openapi.yaml', (_req, res) => {
    const template = fs.readFileSync('chatgpt-action-openapi.yaml', 'utf8');
    const origin = PUBLIC_URL || `${_req.protocol}://${_req.get('host')}`;
    return res.type('application/yaml').send(template.replace('https://zaojing-chatgpt-gateway-uat-REPLACE.run.app', origin));
  });

  app.use('/v1', authenticateApiKey);

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
      return res.status(response.status).json({ ...actionTask(body), idempotencyKey });
    } catch (error: any) { return res.status(502).json({ error: 'create_video_failed', detail: String(error?.message || error) }); }
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

export function startChatGptGateway() {
  const app = createChatGptGatewayApp();
  return app.listen(PORT, '0.0.0.0', () => console.log(`[ZAOJING_CHATGPT_GATEWAY] listening on :${PORT}`));
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) startChatGptGateway();
