import express from 'express';
import crypto from 'crypto';
import { getFirestoreInstance } from './src/server/db/firestore';
import { IDENTITY_SAFE_VERSION } from './src/mvp/identitySafe';
import type { MvpVideoTask } from './src/mvp/mvpContract';
import { CHATGPT_GATEWAY_VERSION, chatgptGatewayEnabled, requireChatgptGatewayAuth, requireIdempotencyKey } from './src/mvp/chatgptGateway';

const PORT = Number(process.env.PORT || 8080);
const TASK_COLLECTION = 'mvp_video_tasks';
const IDEMPOTENCY_COLLECTION = 'mvp_video_idempotency';
const CLIENT_VERSION = 'identity-safe-v0.2.1-network-hardening';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function isRetryQaPending(status: unknown, providerAttempt: unknown): boolean {
  return Number(providerAttempt || 1) > 1 && ['RETRYING', 'GENERATING', 'QUALITY_CHECKING'].includes(String(status || ''));
}

function isSafeToClearPersistedRetryQa(status: unknown, providerAttempt: unknown): boolean {
  return Number(providerAttempt || 1) > 1 && ['RETRYING', 'GENERATING'].includes(String(status || ''));
}

function sanitizeTaskBody(body: any): any {
  if (!body || typeof body !== 'object') return body;
  let sanitized = body;
  if (body.taskId && isRetryQaPending(body.status, body.providerAttempt)) sanitized = { ...sanitized, identityReport: null };
  if (sanitized.error?.code === 'IDENTITY_INPUT_UNSAFE') {
    sanitized = { ...sanitized, error: { ...sanitized.error, recommendedAction: '按具体校验提示修正输入图尺寸或比例；动作风险由 Identity Safe 自动收敛，不需要因为转头、遮挡或运镜提示重新上传图片。' } };
  }
  return sanitized;
}

async function clearPersistedStaleRetryQa(taskId: string): Promise<void> {
  const db = getFirestoreInstance();
  if (!db) return;
  const ref = db.collection(TASK_COLLECTION).doc(taskId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const current = snap.data() as MvpVideoTask;
    if (!isSafeToClearPersistedRetryQa(current.status, current.providerAttempt) || !current.identityReport) return;
    tx.update(ref, { identityReport: null, updatedAt: Date.now() });
  });
}

function publicTask(task: MvpVideoTask) {
  const currentIdentityReport = isRetryQaPending(task.status, task.providerAttempt) ? null : task.identityReport || null;
  return sanitizeTaskBody({
    taskId: task.taskId, status: task.status, stage: task.stage, provider: task.provider, model: task.model,
    projectId: task.projectId, region: task.region, durationSeconds: task.durationSeconds,
    identitySafeMode: task.identitySafeMode === true, identitySafeVersion: IDENTITY_SAFE_VERSION, clientVersion: CLIENT_VERSION,
    identityQaModel: task.identityQaModel || null, providerAttempt: task.providerAttempt || 1,
    identityRetryCount: task.identityRetryCount || 0, retryReason: task.retryReason || null,
    operationNamePresent: Boolean(task.operationName), pollAttempt: task.pollAttempt,
    identityReport: currentIdentityReport, firstAttemptIdentityReport: task.firstAttemptIdentityReport || null,
    artifactPersisted: task.artifactPersisted, artifactVerified: task.artifactVerified, sizeBytes: task.sizeBytes || null,
    videoUri: task.videoUri || null, videoUrl: task.status === 'COMPLETED' ? `/api/mvp/videos/${task.taskId}/stream` : null,
    error: task.error || null, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt || null,
  });
}

function renderMvpPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>造境 Identity Safe v0.2.1</title></head><body><main><h1>造境 Identity Safe v0.2.1</h1><p>当前 API 与 UI 由 Identity Safe v0.2.1 提供。</p><p><a href="/api/mvp/client-health">Client health</a></p></main></body></html>`;
}

export async function createMvpAppV021() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: any) => {
      if (body?.taskId && body.identityReport && isSafeToClearPersistedRetryQa(body.status, body.providerAttempt)) {
        void clearPersistedStaleRetryQa(String(body.taskId)).catch((error) => console.warn('[MVP_IDENTITY_SAFE_V021] stale retry QA cleanup failed:', String((error as any)?.message || error)));
      }
      return originalJson(sanitizeTaskBody(body));
    }) as typeof res.json;
    next();
  });

  app.get('/', (_req, res) => res.type('html').send(renderMvpPage()));
  app.get('/api/mvp/client-health', (_req, res) => res.json({ status: 'ok', clientVersion: CLIENT_VERSION, identitySafeVersion: IDENTITY_SAFE_VERSION, networkRecovery: true, idempotencyLookup: true, chatgptGateway: chatgptGatewayEnabled(), chatgptGatewayVersion: CHATGPT_GATEWAY_VERSION }));

  app.post('/api/mvp/videos/lookup', async (req, res) => {
    try {
      const key = String(req.body?.idempotencyKey || '').trim();
      if (!key || key.length < 16 || key.length > 200) return res.status(400).json({ error: { code: 'IDEMPOTENCY_KEY_INVALID', message: 'Invalid idempotency key.' } });
      const db = getFirestoreInstance();
      if (!db) return res.status(503).json({ error: { code: 'FIRESTORE_UNAVAILABLE', message: 'Firestore unavailable.' } });
      const idemSnap = await db.collection(IDEMPOTENCY_COLLECTION).doc(sha256(key)).get();
      if (!idemSnap.exists) return res.status(404).json({ error: { code: 'TASK_NOT_FOUND', message: 'No task exists for this idempotency key yet.' } });
      const taskId = String(idemSnap.data()?.taskId || '');
      if (!taskId) return res.status(500).json({ error: { code: 'IDEMPOTENCY_RECORD_INVALID', message: 'Idempotency record has no taskId.' } });
      const taskSnap = await db.collection(TASK_COLLECTION).doc(taskId).get();
      if (!taskSnap.exists) return res.status(404).json({ error: { code: 'TASK_NOT_FOUND', message: 'Task record is missing.' } });
      return res.json(publicTask(taskSnap.data() as MvpVideoTask));
    } catch (error: any) { return res.status(500).json({ error: { code: 'LOOKUP_FAILED', message: String(error?.message || error) } }); }
  });

  // ChatGPT-facing namespace. Authentication happens before any provider-capable route.
  // Existing MVP handlers remain the single source of truth for idempotency, Provider admission,
  // retry budgets, Identity Safe QA, GCS recovery, and artifact verification.
  app.use('/api/chatgpt', requireChatgptGatewayAuth);
  app.get('/api/chatgpt/health', (_req, res) => res.json({ status: 'ok', gatewayVersion: CHATGPT_GATEWAY_VERSION, identitySafeVersion: IDENTITY_SAFE_VERSION, providerWritesProtectedByIdempotency: true }));
  app.post('/api/chatgpt/videos', requireIdempotencyKey, (req, _res, next) => {
    req.url = '/api/mvp/videos/start';
    next();
  });
  app.get('/api/chatgpt/videos/:taskId', (req, _res, next) => { req.url = `/api/mvp/videos/${encodeURIComponent(req.params.taskId)}`; next(); });
  app.post('/api/chatgpt/videos/:taskId/recover', (req, _res, next) => { req.url = `/api/mvp/videos/${encodeURIComponent(req.params.taskId)}/recover`; next(); });
  app.get('/api/chatgpt/videos/:taskId/result', async (req, res) => {
    const db = getFirestoreInstance();
    if (!db) return res.status(503).json({ error: { code: 'FIRESTORE_UNAVAILABLE', message: 'Firestore unavailable.' } });
    const snap = await db.collection(TASK_COLLECTION).doc(req.params.taskId).get();
    if (!snap.exists) return res.status(404).json({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found.' } });
    const task = snap.data() as MvpVideoTask;
    const body = publicTask(task);
    if (task.status !== 'COMPLETED' || !task.artifactPersisted || !task.artifactVerified) return res.status(409).json({ ...body, resultReady: false });
    return res.json({ ...body, resultReady: true });
  });

  const previousVitest = process.env.VITEST;
  process.env.VITEST = 'mvp-v021-wrapper';
  const legacyModule = await import('./mvp-server-v02');
  if (previousVitest === undefined) delete process.env.VITEST; else process.env.VITEST = previousVitest;
  const legacyApp = await legacyModule.createMvpAppV02();
  app.use(legacyApp);
  return app;
}

export async function startMvpServerV021() {
  const app = await createMvpAppV021();
  return app.listen(PORT, '0.0.0.0', () => console.log(`[MVP_IDENTITY_SAFE_V021] listening on :${PORT}; client=${CLIENT_VERSION}; chatgpt=${chatgptGatewayEnabled()}`));
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) void startMvpServerV021();
