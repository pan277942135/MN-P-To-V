import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { getFirestoreInstance } from './src/server/db/firestore';
import { VideoGenerator } from './src/services/video/videoGenerator';
import { redactSecrets } from './src/utils/redactSecrets';
import {
  MVP_ALLOWED_DURATIONS,
  MVP_PROVIDER,
  MVP_VIDEO_MODEL,
  assertArtifactOnlyCompletion,
  normalizeProviderFailureReason,
  type MvpStructuredError,
  type MvpVideoTask,
} from './src/mvp/mvpContract';

const PORT = Number(process.env.PORT || 8080);
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || 'xp-vertex-project';
const REGION = process.env.VERTEX_LOCATION || process.env.GCP_REGION || 'us-central1';
const OUTPUT_BUCKET = String(process.env.VEO_OUTPUT_BUCKET || '').replace(/^gs:\/\//, '').replace(/\/+$/, '');
const TASK_COLLECTION = 'mvp_video_tasks';
const IDEMPOTENCY_COLLECTION = 'mvp_video_idempotency';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const SUBMIT_TIMEOUT_MS = 120_000;

const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
const storage = new Storage();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

function now(): number {
  return Date.now();
}

function sha256(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function providerPrefix(taskId: string): string {
  return `veo/${taskId}/provider/`;
}

function providerStorageUri(taskId: string): string {
  return `gs://${OUTPUT_BUCKET}/${providerPrefix(taskId)}`;
}

function canonicalObjectPath(taskId: string): string {
  return `veo/${taskId}/video.mp4`;
}

function publicTask(task: MvpVideoTask) {
  return {
    taskId: task.taskId,
    status: task.status,
    stage: task.stage,
    provider: task.provider,
    model: task.model,
    projectId: task.projectId,
    region: task.region,
    durationSeconds: task.durationSeconds,
    operationNamePresent: Boolean(task.operationName),
    pollAttempt: task.pollAttempt,
    artifactPersisted: task.artifactPersisted,
    artifactVerified: task.artifactVerified,
    sizeBytes: task.sizeBytes || null,
    videoUri: task.videoUri || null,
    videoUrl: task.status === 'COMPLETED' ? `/api/mvp/videos/${task.taskId}/stream` : null,
    error: task.error || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt || null,
  };
}

function inputError(code: 'INPUT_IMAGE_INVALID' | 'PROMPT_INVALID', message: string): MvpStructuredError {
  return {
    code,
    stage: 'input',
    message,
    retryable: false,
    recommendedAction: code === 'INPUT_IMAGE_INVALID' ? '重新上传有效 JPG/PNG/WebP 图片。' : '填写非空视频 Prompt。',
  };
}

function isSupportedImage(buffer: Buffer, mimeType: string): boolean {
  if (!buffer || buffer.length < 12) return false;
  const mime = String(mimeType || '').toLowerCase();
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png =
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  const webp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return (
    (mime === 'image/jpeg' && jpeg) ||
    (mime === 'image/png' && png) ||
    (mime === 'image/webp' && webp)
  );
}

async function getAccessToken(): Promise<string> {
  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
  if (!token) throw new Error('Runtime ADC did not return an access token.');
  return token;
}

function submitEndpoint(): string {
  return `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${MVP_VIDEO_MODEL}:predictLongRunning`;
}

function pollEndpoint(): string {
  return `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${MVP_VIDEO_MODEL}:fetchPredictOperation`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class ProviderHttpError extends Error {
  constructor(
    message: string,
    public httpStatus: number,
    public providerStatus: string | null,
    public rawBody: string,
  ) {
    super(message);
  }
}

async function submitVeoOnce(params: {
  prompt: string;
  imageBuffer: Buffer;
  mimeType: string;
  durationSeconds: number;
  taskId: string;
}): Promise<string> {
  const token = await getAccessToken();
  const body = {
    instances: [
      {
        prompt: params.prompt,
        image: {
          bytesBase64Encoded: params.imageBuffer.toString('base64'),
          mimeType: params.mimeType,
        },
      },
    ],
    parameters: {
      sampleCount: 1,
      aspectRatio: '9:16',
      durationSeconds: params.durationSeconds,
      resolution: '1080p',
      personGeneration: 'allow_adult',
      generateAudio: false,
      storageUri: providerStorageUri(params.taskId),
    },
  };

  const response = await fetchWithTimeout(
    submitEndpoint(),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    SUBMIT_TIMEOUT_MS,
  );

  const raw = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch {}

  if (!response.ok) {
    const providerStatus = parsed?.error?.status || null;
    const message = parsed?.error?.message || raw || `HTTP ${response.status}`;
    throw new ProviderHttpError(redactSecrets(message), response.status, providerStatus, redactSecrets(raw));
  }

  const operationName = parsed?.name;
  if (typeof operationName !== 'string' || !operationName.includes('/operations/')) {
    throw new Error(`Provider accepted request but returned no valid operationName: ${redactSecrets(raw)}`);
  }
  return operationName;
}

async function submitVeoWithSafeRateRetry(params: Parameters<typeof submitVeoOnce>[0]): Promise<string> {
  const delays = [2_000, 4_000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await submitVeoOnce(params);
    } catch (error: any) {
      const is429 = error instanceof ProviderHttpError &&
        (error.httpStatus === 429 || error.providerStatus === 'RESOURCE_EXHAUSTED');
      if (!is429 || attempt === delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  throw new Error('Unreachable submit retry state.');
}

async function pollProvider(operationName: string): Promise<any> {
  const token = await getAccessToken();
  const response = await fetchWithTimeout(
    pollEndpoint(),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operationName }),
    },
    30_000,
  );
  const raw = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch {}
  if (!response.ok) {
    throw new ProviderHttpError(
      redactSecrets(parsed?.error?.message || raw || `HTTP ${response.status}`),
      response.status,
      parsed?.error?.status || null,
      redactSecrets(raw),
    );
  }
  return parsed;
}

async function exactDownload(bucket: string, objectPath: string): Promise<Buffer> {
  const [bytes] = await storage.bucket(bucket).file(objectPath).download();
  return Buffer.from(bytes);
}

async function downloadProviderArtifact(taskId: string, response: any): Promise<Buffer> {
  const extracted = VideoGenerator.extractVideoData(response);
  if (extracted.base64) {
    const buffer = Buffer.from(extracted.base64, 'base64');
    if (VideoGenerator.isMp4Valid(buffer)) return buffer;
  }

  if (extracted.uri) {
    if (extracted.uri.startsWith(`gs://${OUTPUT_BUCKET}/`)) {
      const objectPath = extracted.uri.slice(`gs://${OUTPUT_BUCKET}/`.length);
      const buffer = await exactDownload(OUTPUT_BUCKET, objectPath);
      if (VideoGenerator.isMp4Valid(buffer)) return buffer;
    } else {
      const token = await getAccessToken();
      const buffer = await VideoGenerator.fetchGcsVideoBuffer(extracted.uri, token);
      if (VideoGenerator.isMp4Valid(buffer)) return buffer;
    }
  }

  const [files] = await storage.bucket(OUTPUT_BUCKET).getFiles({ prefix: providerPrefix(taskId) });
  const candidates: Array<{ path: string; size: number; updated: number }> = [];
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.mp4')) continue;
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size || 0);
    if (size < 1000) continue;
    candidates.push({
      path: file.name,
      size,
      updated: metadata.updated ? Date.parse(String(metadata.updated)) : 0,
    });
  }

  if (candidates.length !== 1) {
    throw new Error(`Provider output discovery expected exactly one valid MP4, found ${candidates.length}.`);
  }
  const buffer = await exactDownload(OUTPUT_BUCKET, candidates[0].path);
  if (!VideoGenerator.isMp4Valid(buffer)) {
    throw new Error(`Provider output ${candidates[0].path} is not a valid MP4.`);
  }
  return buffer;
}

async function persistCanonicalArtifact(taskId: string, videoBuffer: Buffer) {
  if (!VideoGenerator.isMp4Valid(videoBuffer)) {
    throw new Error('Generated buffer is not a valid MP4.');
  }
  const objectPath = canonicalObjectPath(taskId);
  const file = storage.bucket(OUTPUT_BUCKET).file(objectPath);
  await file.save(videoBuffer, {
    resumable: false,
    metadata: { contentType: 'video/mp4' },
  });

  const [exists] = await file.exists();
  if (!exists) throw new Error('Canonical GCS artifact does not exist after upload.');
  const [metadata] = await file.getMetadata();
  const sizeBytes = Number(metadata.size || 0);
  if (sizeBytes < 1000) throw new Error(`Canonical GCS artifact is too small (${sizeBytes} bytes).`);

  const exactBuffer = await exactDownload(OUTPUT_BUCKET, objectPath);
  if (!VideoGenerator.isMp4Valid(exactBuffer)) {
    throw new Error('Canonical GCS artifact failed exact-read MP4 verification.');
  }

  return {
    outputBucket: OUTPUT_BUCKET,
    outputObjectPath: objectPath,
    videoUri: `gs://${OUTPUT_BUCKET}/${objectPath}`,
    sizeBytes: exactBuffer.length,
    contentType: 'video/mp4',
  };
}

async function getTask(taskId: string): Promise<MvpVideoTask | null> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('Firestore unavailable.');
  const snap = await db.collection(TASK_COLLECTION).doc(taskId).get();
  return snap.exists ? (snap.data() as MvpVideoTask) : null;
}

async function updateTask(taskId: string, patch: Partial<MvpVideoTask>): Promise<MvpVideoTask> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('Firestore unavailable.');
  const ref = db.collection(TASK_COLLECTION).doc(taskId);
  await ref.update({ ...patch, updatedAt: now() });
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Task ${taskId} disappeared after update.`);
  return snap.data() as MvpVideoTask;
}

async function createTaskIdempotently(params: {
  idempotencyKey: string;
  prompt: string;
  durationSeconds: number;
  imageBuffer: Buffer;
  mimeType: string;
}): Promise<{ task: MvpVideoTask; existing: boolean }> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('Firestore unavailable.');

  const idempotencyKeyHash = sha256(params.idempotencyKey);
  const idemRef = db.collection(IDEMPOTENCY_COLLECTION).doc(idempotencyKeyHash);
  const taskId = `mvp_${crypto.randomUUID()}`;
  const taskRef = db.collection(TASK_COLLECTION).doc(taskId);
  const createdAt = now();

  return await db.runTransaction(async (tx) => {
    const idemSnap = await tx.get(idemRef);
    if (idemSnap.exists) {
      const existingTaskId = String(idemSnap.data()?.taskId || '');
      if (!existingTaskId) throw new Error('Idempotency record is missing taskId.');
      const existingSnap = await tx.get(db.collection(TASK_COLLECTION).doc(existingTaskId));
      if (!existingSnap.exists) throw new Error('Idempotency record points to a missing task.');
      return { task: existingSnap.data() as MvpVideoTask, existing: true };
    }

    const task: MvpVideoTask = {
      taskId,
      idempotencyKeyHash,
      status: 'PREPARING',
      stage: 'input',
      provider: MVP_PROVIDER,
      model: MVP_VIDEO_MODEL,
      projectId: PROJECT_ID,
      region: REGION,
      prompt: params.prompt,
      durationSeconds: params.durationSeconds,
      inputMimeType: params.mimeType,
      inputSha256: sha256(params.imageBuffer),
      inputSizeBytes: params.imageBuffer.length,
      providerStorageUri: providerStorageUri(taskId),
      pollAttempt: 0,
      artifactPersisted: false,
      artifactVerified: false,
      error: null,
      createdAt,
      updatedAt: createdAt,
    };
    tx.create(taskRef, task);
    tx.create(idemRef, { taskId, createdAt });
    return { task, existing: false };
  });
}

function classifySubmitFailure(error: unknown): { status: 'FAILED' | 'SUBMISSION_OUTCOME_UNKNOWN'; detail: MvpStructuredError } {
  if (error instanceof ProviderHttpError) {
    if (error.httpStatus === 429 || error.providerStatus === 'RESOURCE_EXHAUSTED') {
      return {
        status: 'FAILED',
        detail: {
          code: 'RATE_LIMITED',
          stage: 'submit',
          message: error.message,
          retryable: true,
          recommendedAction: '稍后创建新任务；本任务未获得 Operation Name。',
          providerHttpStatus: error.httpStatus,
          providerStatus: error.providerStatus,
          technicalMessage: error.rawBody,
        },
      };
    }
    if ([400, 401, 403, 404].includes(error.httpStatus)) {
      const code = [401, 403].includes(error.httpStatus) ? 'AUTH_FAILED' : 'REQUEST_REJECTED';
      return {
        status: 'FAILED',
        detail: {
          code,
          stage: code === 'AUTH_FAILED' ? 'auth' : 'submit',
          message: error.message,
          retryable: false,
          recommendedAction: code === 'AUTH_FAILED' ? '检查 Cloud Run Runtime Service Account / IAM。' : '检查输入、模型和 Vertex 路由配置。',
          providerHttpStatus: error.httpStatus,
          providerStatus: error.providerStatus,
          technicalMessage: error.rawBody,
        },
      };
    }
  }

  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  return {
    status: 'SUBMISSION_OUTCOME_UNKNOWN',
    detail: {
      code: 'SUBMISSION_OUTCOME_UNKNOWN',
      stage: 'submit',
      message,
      retryable: false,
      recommendedAction: '不要重新提交同一任务；先使用【恢复产物】检查任务专属 GCS 前缀。',
      technicalMessage: message,
    },
  };
}

async function completeFromBuffer(task: MvpVideoTask, buffer: Buffer): Promise<MvpVideoTask> {
  await updateTask(task.taskId, { status: 'SAVING', stage: 'artifact_persist', error: null });
  try {
    const artifact = await persistCanonicalArtifact(task.taskId, buffer);
    const candidate: MvpVideoTask = {
      ...task,
      ...artifact,
      status: 'COMPLETED',
      stage: 'ready',
      artifactPersisted: true,
      artifactVerified: true,
      error: null,
      completedAt: now(),
      updatedAt: now(),
    };
    assertArtifactOnlyCompletion(candidate);
    return await updateTask(task.taskId, candidate);
  } catch (error: any) {
    const message = redactSecrets(error?.message || String(error));
    return await updateTask(task.taskId, {
      status: 'FAILED',
      stage: 'artifact_persist',
      artifactPersisted: false,
      artifactVerified: false,
      error: {
        code: 'OUTPUT_PERSIST_FAILED',
        stage: 'artifact_persist',
        message,
        retryable: true,
        recommendedAction: '检查 GCS 权限/配额后恢复或重新生成。',
        technicalMessage: message,
      },
    });
  }
}

async function recoverFromProviderPrefix(task: MvpVideoTask): Promise<{ task: MvpVideoTask; found: boolean }> {
  const [files] = await storage.bucket(OUTPUT_BUCKET).getFiles({ prefix: providerPrefix(task.taskId) });
  const candidates: string[] = [];
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.mp4')) continue;
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size || 0) >= 1000) candidates.push(file.name);
  }
  if (candidates.length === 0) return { task, found: false };
  if (candidates.length > 1) {
    const failed = await updateTask(task.taskId, {
      error: {
        code: 'OUTPUT_MISSING',
        stage: 'output_fetch',
        message: `任务专属 Provider 前缀发现 ${candidates.length} 个视频，无法安全绑定。`,
        retryable: false,
        recommendedAction: '人工核实 GCS 产物后再处理；不要自动重新提交 Veo。',
        technicalMessage: candidates.join(', '),
      },
    });
    return { task: failed, found: false };
  }
  const buffer = await exactDownload(OUTPUT_BUCKET, candidates[0]);
  if (!VideoGenerator.isMp4Valid(buffer)) return { task, found: false };
  return { task: await completeFromBuffer(task, buffer), found: true };
}

function renderMvpPage(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>造境 MVP_SIMPLE</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#09090b;color:#fafafa;margin:0;padding:24px}main{max-width:760px;margin:auto}section{background:#18181b;border:1px solid #27272a;border-radius:16px;padding:20px;margin:16px 0}input,textarea,select,button{font:inherit}textarea,select,input[type=file]{width:100%;box-sizing:border-box;margin:8px 0 16px;background:#09090b;color:#fafafa;border:1px solid #3f3f46;border-radius:10px;padding:10px}textarea{min-height:160px}button{background:#7c3aed;color:white;border:0;border-radius:10px;padding:12px 18px;font-weight:700;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}pre{white-space:pre-wrap;word-break:break-word;background:#09090b;padding:12px;border-radius:10px;border:1px solid #27272a}video{width:100%;border-radius:12px;background:black}.ok{color:#34d399}.bad{color:#fb7185}.muted{color:#a1a1aa;font-size:13px}
</style></head><body><main>
<h1>造境 MVP_SIMPLE</h1><p class="muted">固定链路：Cloud Run → Runtime ADC → Vertex AI → veo-3.1-fast-generate-001 → GCS。无母板、无身份 QA、无 Prompt 改写。</p>
<section><label>已人工确认的梅凝图片</label><input id="image" type="file" accept="image/jpeg,image/png,image/webp"/>
<label>原始 Prompt（服务端不改写）</label><textarea id="prompt" placeholder="输入视频生成 Prompt"></textarea>
<label>时长</label><select id="duration"><option value="4">4s</option><option value="6">6s</option><option value="8">8s</option></select>
<button id="go">生成视频</button></section>
<section><div id="headline">尚未开始</div><pre id="status">{}</pre><button id="recover" style="display:none">恢复产物（不重新提交 Veo）</button></section>
<section id="videoBox" style="display:none"><video id="video" controls></video><p><a id="download" style="color:#c4b5fd" download>下载视频</a></p></section>
<script>
const $=id=>document.getElementById(id);let taskId=null;let timer=null;
function show(data){$('status').textContent=JSON.stringify(data,null,2);$('headline').textContent=data.status?('状态：'+data.status):'状态未知';$('headline').className=data.status==='COMPLETED'?'ok':(data.status==='FAILED'?'bad':'');$('recover').style.display=data.status==='SUBMISSION_OUTCOME_UNKNOWN'?'inline-block':'none';if(data.videoUrl){$('videoBox').style.display='block';$('video').src=data.videoUrl;$('download').href=data.videoUrl+'?download=1';}}
async function poll(){if(!taskId)return;try{const r=await fetch('/api/mvp/videos/'+taskId);const d=await r.json();show(d);if(['COMPLETED','FAILED','SUBMISSION_OUTCOME_UNKNOWN'].includes(d.status)){clearInterval(timer);timer=null;$('go').disabled=false;}}catch(e){console.error(e)}}
$('go').onclick=async()=>{const image=$('image').files[0];const prompt=$('prompt').value.trim();if(!image||!prompt){alert('请选择图片并填写 Prompt');return}$('go').disabled=true;$('videoBox').style.display='none';const fd=new FormData();fd.append('image',image);fd.append('prompt',prompt);fd.append('durationSeconds',$('duration').value);const key=crypto.randomUUID();try{const r=await fetch('/api/mvp/videos/start',{method:'POST',headers:{'x-idempotency-key':key},body:fd});const d=await r.json();show(d);taskId=d.taskId||null;if(taskId&&!['COMPLETED','FAILED','SUBMISSION_OUTCOME_UNKNOWN'].includes(d.status)){timer=setInterval(poll,5000);}}catch(e){show({status:'FAILED',error:{message:String(e)}});$('go').disabled=false}};
$('recover').onclick=async()=>{if(!taskId)return;$('recover').disabled=true;try{const r=await fetch('/api/mvp/videos/'+taskId+'/recover',{method:'POST'});const d=await r.json();show(d)}finally{$('recover').disabled=false}};
</script></main></body></html>`;
}

export async function createMvpApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => res.type('html').send(renderMvpPage()));
  app.get('/api/mvp/health', (_req, res) => res.json({
    status: 'ok',
    mode: 'MVP_SIMPLE',
    provider: MVP_PROVIDER,
    model: MVP_VIDEO_MODEL,
    projectId: PROJECT_ID,
    region: REGION,
    outputBucketConfigured: Boolean(OUTPUT_BUCKET),
    commitSha: process.env.K_REVISION || process.env.COMMIT_SHA || null,
  }));

  app.get('/api/mvp/readiness', async (_req, res) => {
    const result: any = {
      ready: false,
      mode: 'MVP_SIMPLE',
      provider: MVP_PROVIDER,
      model: MVP_VIDEO_MODEL,
      projectId: PROJECT_ID,
      region: REGION,
      outputBucket: OUTPUT_BUCKET || null,
      auth: 'unknown',
      firestore: 'unknown',
      gcs: 'unknown',
      vertexRoute: 'unknown',
      commitSha: process.env.K_REVISION || process.env.COMMIT_SHA || null,
    };
    try {
      if (!OUTPUT_BUCKET) throw new Error('VEO_OUTPUT_BUCKET is missing.');
      const token = await getAccessToken();
      result.auth = 'ok';
      const db = getFirestoreInstance();
      if (!db) throw new Error('Firestore unavailable.');
      await db.collection('_mvp_health').doc('readiness').get();
      result.firestore = 'ok';
      await storage.bucket(OUTPUT_BUCKET).file('_mvp_readiness_probe_nonexistent').exists();
      result.gcs = 'ok';
      const routeRes = await fetchWithTimeout(
        submitEndpoint(),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ instances: [] }),
        },
        15_000,
      );
      result.vertexRoute = routeRes.status === 400 ? 'ok' : `http_${routeRes.status}`;
      result.ready = result.auth === 'ok' && result.firestore === 'ok' && result.gcs === 'ok' && result.vertexRoute === 'ok';
      return res.status(result.ready ? 200 : 503).json(result);
    } catch (error: any) {
      result.error = redactSecrets(error?.message || String(error));
      return res.status(503).json(result);
    }
  });

  app.post('/api/mvp/videos/start', upload.single('image'), async (req, res) => {
    try {
      if (!OUTPUT_BUCKET) {
        return res.status(503).json({
          status: 'FAILED',
          error: { code: 'STORAGE_CONFIG_INVALID', stage: 'artifact_persist', message: 'VEO_OUTPUT_BUCKET is missing.' },
        });
      }
      const file = req.file;
      const prompt = String(req.body?.prompt || '').trim();
      const durationSeconds = Number(req.body?.durationSeconds || 4);
      const idempotencyKey = String(req.header('x-idempotency-key') || '').trim() || crypto.randomUUID();

      if (!file || !isSupportedImage(file.buffer, file.mimetype)) {
        return res.status(400).json({ status: 'FAILED', error: inputError('INPUT_IMAGE_INVALID', '图片必须是有效 JPG/PNG/WebP。') });
      }
      if (!prompt || prompt.length > 12_000) {
        return res.status(400).json({ status: 'FAILED', error: inputError('PROMPT_INVALID', 'Prompt 不能为空且长度不得超过 12000 字符。') });
      }
      if (!(MVP_ALLOWED_DURATIONS as readonly number[]).includes(durationSeconds)) {
        return res.status(400).json({ status: 'FAILED', error: inputError('PROMPT_INVALID', 'durationSeconds 仅允许 4、6、8。') });
      }

      const created = await createTaskIdempotently({
        idempotencyKey,
        prompt,
        durationSeconds,
        imageBuffer: file.buffer,
        mimeType: file.mimetype,
      });
      if (created.existing) return res.status(200).json(publicTask(created.task));

      let task = await updateTask(created.task.taskId, { status: 'SUBMITTING', stage: 'submit' });
      try {
        const operationName = await submitVeoWithSafeRateRetry({
          prompt,
          imageBuffer: file.buffer,
          mimeType: file.mimetype,
          durationSeconds,
          taskId: task.taskId,
        });
        task = await updateTask(task.taskId, {
          status: 'GENERATING',
          stage: 'polling',
          operationName,
          error: null,
        });
        return res.status(202).json(publicTask(task));
      } catch (error) {
        const classified = classifySubmitFailure(error);
        task = await updateTask(task.taskId, {
          status: classified.status,
          stage: 'submit',
          error: classified.detail,
        });
        return res.status(classified.status === 'FAILED' ? 502 : 202).json(publicTask(task));
      }
    } catch (error: any) {
      return res.status(500).json({
        status: 'FAILED',
        error: {
          code: 'INTERNAL_ERROR',
          stage: 'internal',
          message: redactSecrets(error?.message || String(error)),
          retryable: false,
          recommendedAction: '检查 Cloud Run / Firestore 日志。',
        },
      });
    }
  });

  app.get('/api/mvp/videos/:taskId', async (req, res) => {
    try {
      let task = await getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: 'task_not_found' });
      if (['COMPLETED', 'FAILED', 'SUBMISSION_OUTCOME_UNKNOWN'].includes(task.status)) {
        return res.json(publicTask(task));
      }
      if (!task.operationName) {
        task = await updateTask(task.taskId, {
          status: 'SUBMISSION_OUTCOME_UNKNOWN',
          stage: 'submit',
          error: {
            code: 'SUBMISSION_OUTCOME_UNKNOWN',
            stage: 'submit',
            message: '任务没有 durable operationName，无法安全轮询。',
            retryable: false,
            recommendedAction: '先恢复任务专属 GCS 产物，不要重新提交 Veo。',
          },
        });
        return res.json(publicTask(task));
      }

      let providerResponse: any;
      try {
        providerResponse = await pollProvider(task.operationName);
      } catch (error: any) {
        const status = error instanceof ProviderHttpError ? error.httpStatus : null;
        if (status === 401 || status === 403 || status === 404) {
          task = await updateTask(task.taskId, {
            status: 'FAILED',
            stage: status === 401 || status === 403 ? 'auth' : 'polling',
            error: {
              code: status === 401 || status === 403 ? 'AUTH_FAILED' : 'GENERATION_FAILED',
              stage: status === 401 || status === 403 ? 'auth' : 'polling',
              message: redactSecrets(error?.message || String(error)),
              retryable: false,
              recommendedAction: status === 404 ? '核对 Operation Name、区域和模型。' : '检查 Runtime Service Account IAM。',
              providerHttpStatus: status,
              providerStatus: error.providerStatus || null,
            },
          });
          return res.status(502).json(publicTask(task));
        }
        task = await updateTask(task.taskId, {
          pollAttempt: (task.pollAttempt || 0) + 1,
          error: {
            code: 'GENERATION_TIMEOUT',
            stage: 'polling',
            message: redactSecrets(error?.message || String(error)),
            retryable: true,
            recommendedAction: '继续轮询同一 Operation；不要重新提交 Veo。',
            providerHttpStatus: status,
            providerStatus: error?.providerStatus || null,
          },
        });
        return res.status(503).json(publicTask(task));
      }

      task = await updateTask(task.taskId, {
        pollAttempt: (task.pollAttempt || 0) + 1,
        error: null,
      });
      if (!providerResponse?.done) return res.status(202).json(publicTask(task));

      if (providerResponse.error) {
        const safety = VideoGenerator.checkSafetyBlock(null, providerResponse.error);
        const normalized = normalizeProviderFailureReason({
          failureReason: safety.isBlocked ? 'output_rai_filtered' : 'upstream_failed',
          message: safety.reason || redactSecrets(JSON.stringify(providerResponse.error)),
          providerStatus: providerResponse?.error?.status || null,
          httpStatus: providerResponse?.error?.code || null,
        });
        task = await updateTask(task.taskId, { status: 'FAILED', stage: normalized.stage, error: normalized });
        return res.status(502).json(publicTask(task));
      }

      const responseBody = providerResponse.response || providerResponse;
      const safety = VideoGenerator.checkSafetyBlock(responseBody);
      if (safety.isBlocked) {
        const normalized = normalizeProviderFailureReason({
          failureReason: 'output_rai_filtered',
          message: safety.reason || 'Vertex AI safety filtering removed the generated media.',
        });
        task = await updateTask(task.taskId, { status: 'FAILED', stage: normalized.stage, error: normalized });
        return res.status(422).json(publicTask(task));
      }

      await updateTask(task.taskId, { status: 'SAVING', stage: 'output_fetch' });
      let buffer: Buffer;
      try {
        buffer = await downloadProviderArtifact(task.taskId, responseBody);
      } catch (error: any) {
        const normalized = normalizeProviderFailureReason({
          failureReason: 'upstream_empty_response',
          message: redactSecrets(error?.message || String(error)),
        });
        task = await updateTask(task.taskId, { status: 'FAILED', stage: normalized.stage, error: normalized });
        return res.status(502).json(publicTask(task));
      }

      task = await completeFromBuffer(task, buffer);
      return res.status(task.status === 'COMPLETED' ? 200 : 502).json(publicTask(task));
    } catch (error: any) {
      return res.status(500).json({ error: redactSecrets(error?.message || String(error)) });
    }
  });

  app.post('/api/mvp/videos/:taskId/recover', async (req, res) => {
    try {
      const task = await getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: 'task_not_found' });
      if (task.status === 'COMPLETED') return res.json(publicTask(task));
      const recovered = await recoverFromProviderPrefix(task);
      if (!recovered.found) return res.status(404).json(publicTask(recovered.task));
      return res.json(publicTask(recovered.task));
    } catch (error: any) {
      return res.status(500).json({ error: redactSecrets(error?.message || String(error)) });
    }
  });

  app.get('/api/mvp/videos/:taskId/stream', async (req, res) => {
    try {
      const task = await getTask(req.params.taskId);
      if (!task || task.status !== 'COMPLETED') return res.status(404).json({ error: 'video_not_ready' });
      assertArtifactOnlyCompletion(task);
      const buffer = await exactDownload(task.outputBucket!, task.outputObjectPath!);
      if (!VideoGenerator.isMp4Valid(buffer)) return res.status(500).json({ error: 'persisted_video_invalid' });

      const isDownload = req.query.download === '1' || req.query.download === 'true';
      const range = req.headers.range;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'video/mp4');
      if (isDownload) res.setHeader('Content-Disposition', `attachment; filename="zaojing_mvp_${task.taskId}.mp4"`);

      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return res.status(416).end();
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : buffer.length - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= buffer.length) {
          res.setHeader('Content-Range', `bytes */${buffer.length}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
        res.setHeader('Content-Length', String(end - start + 1));
        return res.end(buffer.subarray(start, end + 1));
      }

      res.setHeader('Content-Length', String(buffer.length));
      return res.end(buffer);
    } catch (error: any) {
      return res.status(500).json({ error: redactSecrets(error?.message || String(error)) });
    }
  });

  return app;
}

export async function startMvpServer() {
  const app = await createMvpApp();
  return app.listen(PORT, '0.0.0.0', () => {
    console.log(`[MVP_SIMPLE] listening on :${PORT}; provider=${MVP_PROVIDER}; model=${MVP_VIDEO_MODEL}; project=${PROJECT_ID}; region=${REGION}; bucket=${OUTPUT_BUCKET || 'MISSING'}`);
  });
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  void startMvpServer();
}
