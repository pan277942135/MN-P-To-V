import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { getFirestoreInstance } from './src/server/db/firestore';
import { VideoGenerator } from './src/services/video/videoGenerator';
import { VideoInspector } from './src/services/video/videoInspector';
import { resolveAutoAspectRatio } from './src/services/google/vertexClient';
import { redactSecrets } from './src/utils/redactSecrets';
import {
  MVP_ALLOWED_DURATIONS,
  MVP_PROVIDER,
  MVP_VIDEO_MODEL,
  normalizeProviderFailureReason,
  type MvpVideoTask,
} from './src/mvp/mvpContract';
import {
  IDENTITY_QA_MODEL_DEFAULT,
  buildIdentitySafePrompt,
  qaVideoIdentityAgainstInput,
  shouldRetryIdentity,
  validateIdentitySafeInput,
  type MvpIdentityQaReport,
} from './src/mvp/identitySafe';
import { IDENTITY_STABILITY_BENCHMARK_V1 } from './src/mvp/identityBenchmark';
import { preprocessVeoImage, type ImagePreprocessResult } from './src/server/services/imagePreprocessor';
import {
  classifyIdentityIntent,
  failClosedIdentityIntent,
  type IdentityIntentReport,
  type ProtectionMode,
} from './src/mvp/identityIntent';
import {
  SCENE_SAFE_VERSION,
  buildSceneSafePrompt,
  qaVideoSceneAgainstInput,
  type MvpSceneQaReport,
} from './src/mvp/sceneSafe';

const PORT = Number(process.env.PORT || 8080);
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || 'xp-vertex-project';
const REGION = process.env.VERTEX_LOCATION || process.env.GCP_REGION || 'us-central1';
const OUTPUT_BUCKET = String(process.env.VEO_OUTPUT_BUCKET || '').replace(/^gs:\/\//, '').replace(/\/+$/, '');
const IDENTITY_QA_MODEL = process.env.IDENTITY_QA_MODEL || IDENTITY_QA_MODEL_DEFAULT;
const PROTECTION_ROUTER_MODEL = process.env.PROTECTION_ROUTER_MODEL || IDENTITY_QA_MODEL;
const SCENE_QA_MODEL = process.env.SCENE_QA_MODEL || IDENTITY_QA_MODEL;
const PROTECTION_VERSION = 'identity-safe-v0.2.2' as const;
const CLIENT_VERSION = 'identity-safe-v0.2.2-scene-routing' as const;
const TASK_COLLECTION = 'mvp_video_tasks';
const IDEMPOTENCY_COLLECTION = 'mvp_video_idempotency';
const CHATGPT_KEY_COLLECTION = 'mvp_chatgpt_api_keys';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const SUBMIT_TIMEOUT_MS = 120_000;

const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
const storage = new Storage();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

type InputPreprocessPublic = Omit<ImagePreprocessResult, 'buffer'>;
type ProtectedTask = Omit<MvpVideoTask, 'stage' | 'error'> & {
  stage: MvpVideoTask['stage'] | 'preprocess' | 'intent_classification' | 'scene_qa';
  error?: any;
  protectionMode?: ProtectionMode;
  intentReport?: IdentityIntentReport | null;
  sceneReport?: MvpSceneQaReport | null;
  sceneQaModel?: string | null;
  inputPreprocess?: InputPreprocessPublic | null;
  inputOriginalMimeType?: string | null;
};

function now(): number { return Date.now(); }
function sha256(input: Buffer | string): string { return crypto.createHash('sha256').update(input).digest('hex'); }
function basePrefix(taskId: string): string { return `veo/${taskId}/`; }
function providerPrefix(taskId: string, attempt = 1): string { return `${basePrefix(taskId)}provider/attempt-${attempt}/`; }
function providerStorageUri(taskId: string, attempt = 1): string { return `gs://${OUTPUT_BUCKET}/${providerPrefix(taskId, attempt)}`; }
function canonicalObjectPath(taskId: string): string { return `${basePrefix(taskId)}video.mp4`; }
function auditAttemptPath(taskId: string, attempt: number): string { return `${basePrefix(taskId)}attempts/attempt-${attempt}.mp4`; }
function inputExtension(mime: string): string { return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'; }
function inputObjectPath(taskId: string, mime: string): string { return `${basePrefix(taskId)}input/reference.${inputExtension(mime)}`; }

function publicTask(task: ProtectedTask) {
  return {
    taskId: task.taskId,
    status: task.status,
    stage: task.stage,
    provider: task.provider,
    model: task.model,
    projectId: task.projectId,
    region: task.region,
    durationSeconds: task.durationSeconds,
    identitySafeMode: task.identitySafeMode === true,
    identitySafeVersion: PROTECTION_VERSION,
    clientVersion: CLIENT_VERSION,
    protectionMode: task.protectionMode || 'IDENTITY',
    intentReport: task.intentReport || null,
    inputPreprocess: task.inputPreprocess || null,
    identityQaModel: task.identityQaModel || IDENTITY_QA_MODEL,
    sceneQaModel: task.sceneQaModel || SCENE_QA_MODEL,
    providerAttempt: task.providerAttempt || 1,
    identityRetryCount: task.identityRetryCount || 0,
    retryReason: task.retryReason || null,
    operationNamePresent: Boolean(task.operationName),
    pollAttempt: task.pollAttempt,
    identityReport: task.identityReport || null,
    firstAttemptIdentityReport: task.firstAttemptIdentityReport || null,
    sceneReport: task.sceneReport || null,
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

function inputError(code: string, message: string, technicalMessage?: string) {
  return {
    code,
    stage: 'input',
    message,
    retryable: false,
    recommendedAction: code === 'INPUT_IMAGE_INVALID'
      ? '重新上传有效的 JPG/PNG/WebP 图片。系统会自动等比例修复常见的小尺寸图片。'
      : code === 'IDENTITY_INPUT_UNSAFE'
        ? '当前任务已判定需要严格身份锁定；请使用更清晰、身份更明确的参考图。'
        : '填写有效视频 Prompt。',
    technicalMessage: technicalMessage || null,
  };
}

function isSupportedImage(buffer: Buffer, mimeType: string): boolean {
  if (!buffer || buffer.length < 12) return false;
  const mime = String(mimeType || '').toLowerCase();
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  const webp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return (mime === 'image/jpeg' && jpeg) || (mime === 'image/png' && png) || (mime === 'image/webp' && webp);
}

async function getAccessToken(): Promise<string> {
  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
  if (!token) throw new Error('Runtime ADC did not return an access token.');
  return token;
}
function submitEndpoint(): string { return `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${MVP_VIDEO_MODEL}:predictLongRunning`; }
function pollEndpoint(): string { return `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${MVP_VIDEO_MODEL}:fetchPredictOperation`; }

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

class ProviderHttpError extends Error {
  constructor(message: string, public httpStatus: number, public providerStatus: string | null, public rawBody: string) { super(message); }
}

async function submitVeoOnce(params: { prompt: string; imageBuffer: Buffer; mimeType: string; durationSeconds: number; taskId: string; attempt: number; }): Promise<string> {
  const token = await getAccessToken();
  const aspectRatio = await resolveAutoAspectRatio(params.imageBuffer.toString('base64'));
  const body = {
    instances: [{ prompt: params.prompt, image: { bytesBase64Encoded: params.imageBuffer.toString('base64'), mimeType: params.mimeType } }],
    parameters: {
      sampleCount: 1,
      aspectRatio,
      durationSeconds: params.durationSeconds,
      resolution: '1080p',
      personGeneration: 'allow_adult',
      generateAudio: false,
      storageUri: providerStorageUri(params.taskId, params.attempt),
    },
  };
  const response = await fetchWithTimeout(submitEndpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, SUBMIT_TIMEOUT_MS);
  const raw = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch {}
  if (!response.ok) throw new ProviderHttpError(redactSecrets(parsed?.error?.message || raw || `HTTP ${response.status}`), response.status, parsed?.error?.status || null, redactSecrets(raw));
  const operationName = parsed?.name;
  if (typeof operationName !== 'string' || !operationName.includes('/operations/')) throw new Error(`Provider accepted request but returned no valid operationName: ${redactSecrets(raw)}`);
  return operationName;
}

async function submitVeoWithSafeRateRetry(params: Parameters<typeof submitVeoOnce>[0]): Promise<string> {
  const delays = [2_000, 4_000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try { return await submitVeoOnce(params); }
    catch (error: any) {
      const is429 = error instanceof ProviderHttpError && (error.httpStatus === 429 || error.providerStatus === 'RESOURCE_EXHAUSTED');
      if (!is429 || attempt === delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  throw new Error('Unreachable submit retry state.');
}

async function pollProvider(operationName: string): Promise<any> {
  const token = await getAccessToken();
  const response = await fetchWithTimeout(pollEndpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationName }),
  }, 30_000);
  const raw = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch {}
  if (!response.ok) throw new ProviderHttpError(redactSecrets(parsed?.error?.message || raw || `HTTP ${response.status}`), response.status, parsed?.error?.status || null, redactSecrets(raw));
  return parsed;
}

async function exactDownload(bucket: string, objectPath: string): Promise<Buffer> {
  const [bytes] = await storage.bucket(bucket).file(objectPath).download();
  return Buffer.from(bytes);
}

async function persistInputReference(taskId: string, buffer: Buffer, mimeType: string, mode: ProtectionMode): Promise<string> {
  const objectPath = inputObjectPath(taskId, mimeType);
  await storage.bucket(OUTPUT_BUCKET).file(objectPath).save(buffer, {
    resumable: false,
    metadata: { contentType: mimeType, metadata: { purpose: mode === 'SCENE' ? 'scene-reference' : 'identity-reference', protectionMode: mode } },
  });
  const verify = await exactDownload(OUTPUT_BUCKET, objectPath);
  if (!verify.equals(buffer)) throw new Error('Persisted reference failed exact-read verification.');
  return objectPath;
}

async function downloadProviderArtifact(taskId: string, attempt: number, response: any): Promise<Buffer> {
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
  const [files] = await storage.bucket(OUTPUT_BUCKET).getFiles({ prefix: providerPrefix(taskId, attempt) });
  const candidates: string[] = [];
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.mp4')) continue;
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size || 0) >= 1000) candidates.push(file.name);
  }
  if (candidates.length !== 1) throw new Error(`Provider attempt-${attempt} expected exactly one valid MP4, found ${candidates.length}.`);
  const buffer = await exactDownload(OUTPUT_BUCKET, candidates[0]);
  if (!VideoGenerator.isMp4Valid(buffer)) throw new Error(`Provider output ${candidates[0]} is not a valid MP4.`);
  return buffer;
}

async function persistAttemptAuditArtifact(taskId: string, attempt: number, videoBuffer: Buffer, mode: ProtectionMode): Promise<void> {
  if (!VideoGenerator.isMp4Valid(videoBuffer)) return;
  await storage.bucket(OUTPUT_BUCKET).file(auditAttemptPath(taskId, attempt)).save(videoBuffer, {
    resumable: false,
    metadata: { contentType: 'video/mp4', metadata: { purpose: mode === 'SCENE' ? 'scene-qa-failed-attempt' : 'identity-qa-failed-attempt', attempt: String(attempt) } },
  });
}

async function persistCanonicalArtifact(taskId: string, videoBuffer: Buffer) {
  if (!VideoGenerator.isMp4Valid(videoBuffer)) throw new Error('Generated buffer is not a valid MP4.');
  const objectPath = canonicalObjectPath(taskId);
  const file = storage.bucket(OUTPUT_BUCKET).file(objectPath);
  await file.save(videoBuffer, { resumable: false, metadata: { contentType: 'video/mp4' } });
  const [exists] = await file.exists();
  if (!exists) throw new Error('Canonical GCS artifact does not exist after upload.');
  const [metadata] = await file.getMetadata();
  const sizeBytes = Number(metadata.size || 0);
  if (sizeBytes < 1000) throw new Error(`Canonical GCS artifact is too small (${sizeBytes} bytes).`);
  const exactBuffer = await exactDownload(OUTPUT_BUCKET, objectPath);
  if (!VideoGenerator.isMp4Valid(exactBuffer)) throw new Error('Canonical GCS artifact failed exact-read MP4 verification.');
  return { outputBucket: OUTPUT_BUCKET, outputObjectPath: objectPath, videoUri: `gs://${OUTPUT_BUCKET}/${objectPath}`, sizeBytes: exactBuffer.length, contentType: 'video/mp4' };
}

function completionSatisfied(task: ProtectedTask): boolean {
  const artifact = Boolean(task.artifactPersisted && task.artifactVerified && task.outputBucket && task.outputObjectPath && task.videoUri && Number(task.sizeBytes || 0) >= 1000 && String(task.contentType || '').startsWith('video/'));
  if (!artifact) return false;
  if (task.identitySafeMode !== true) return true;
  if ((task.protectionMode || 'IDENTITY') === 'SCENE') return task.sceneReport?.pass === true && task.sceneReport?.gateStatus === 'pass';
  return task.identityReport?.pass === true && task.identityReport?.gateStatus === 'pass';
}
function assertProtectedCompletion(task: ProtectedTask): void {
  if (!completionSatisfied(task)) throw new Error('MVP_PROTECTED_COMPLETION_INVARIANT: protected completion requires verified artifact plus passing applicable QA gate.');
}

async function getTask(taskId: string): Promise<ProtectedTask | null> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('Firestore unavailable.');
  const snap = await db.collection(TASK_COLLECTION).doc(taskId).get();
  return snap.exists ? (snap.data() as ProtectedTask) : null;
}
async function updateTask(taskId: string, patch: Partial<ProtectedTask>): Promise<ProtectedTask> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('Firestore unavailable.');
  const ref = db.collection(TASK_COLLECTION).doc(taskId);
  await ref.update({ ...patch, updatedAt: now() });
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Task ${taskId} disappeared after update.`);
  return snap.data() as ProtectedTask;
}

async function createTaskIdempotently(params: {
  idempotencyKey: string;
  prompt: string;
  effectivePrompt: string;
  durationSeconds: number;
  imageBuffer: Buffer;
  mimeType: string;
  originalMimeType: string;
  protectionMode: ProtectionMode;
  intentReport: IdentityIntentReport;
  inputPreprocess: InputPreprocessPublic;
}): Promise<{ task: ProtectedTask; existing: boolean }> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('Firestore unavailable.');
  const idempotencyKeyHash = sha256(params.idempotencyKey);
  const idemRef = db.collection(IDEMPOTENCY_COLLECTION).doc(idempotencyKeyHash);
  const taskId = `mvp_${crypto.randomUUID()}`;
  const taskRef = db.collection(TASK_COLLECTION).doc(taskId);
  const createdAt = now();
  return db.runTransaction(async (tx) => {
    const idemSnap = await tx.get(idemRef);
    if (idemSnap.exists) {
      const existingTaskId = String(idemSnap.data()?.taskId || '');
      if (!existingTaskId) throw new Error('Idempotency record is missing taskId.');
      const existingSnap = await tx.get(db.collection(TASK_COLLECTION).doc(existingTaskId));
      if (!existingSnap.exists) throw new Error('Idempotency record points to a missing task.');
      return { task: existingSnap.data() as ProtectedTask, existing: true };
    }
    const task: ProtectedTask = {
      taskId,
      idempotencyKeyHash,
      status: 'PREPARING',
      stage: 'input',
      provider: MVP_PROVIDER,
      model: MVP_VIDEO_MODEL,
      projectId: PROJECT_ID,
      region: REGION,
      prompt: params.prompt,
      effectivePrompt: params.effectivePrompt,
      identitySafeMode: true,
      protectionMode: params.protectionMode,
      intentReport: params.intentReport,
      durationSeconds: params.durationSeconds,
      inputMimeType: params.mimeType,
      inputOriginalMimeType: params.originalMimeType,
      inputSha256: sha256(params.imageBuffer),
      inputSizeBytes: params.imageBuffer.length,
      inputPreprocess: params.inputPreprocess,
      providerStorageUri: providerStorageUri(taskId, 1),
      providerAttempt: 1,
      identityRetryCount: 0,
      identityQaModel: params.protectionMode === 'IDENTITY' ? IDENTITY_QA_MODEL : null,
      sceneQaModel: params.protectionMode === 'SCENE' ? SCENE_QA_MODEL : null,
      identityReport: null,
      firstAttemptIdentityReport: null,
      sceneReport: null,
      retryReason: null,
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

function classifySubmitFailure(error: unknown): { status: 'FAILED' | 'SUBMISSION_OUTCOME_UNKNOWN'; detail: any } {
  if (error instanceof ProviderHttpError) {
    if (error.httpStatus === 429 || error.providerStatus === 'RESOURCE_EXHAUSTED') return { status: 'FAILED', detail: { code: 'RATE_LIMITED', stage: 'submit', message: error.message, retryable: true, recommendedAction: '稍后创建新任务；本任务未获得 Operation Name。', providerHttpStatus: error.httpStatus, providerStatus: error.providerStatus, technicalMessage: error.rawBody } };
    if ([400, 401, 403, 404].includes(error.httpStatus)) {
      const code = [401, 403].includes(error.httpStatus) ? 'AUTH_FAILED' : 'REQUEST_REJECTED';
      return { status: 'FAILED', detail: { code, stage: code === 'AUTH_FAILED' ? 'auth' : 'submit', message: error.message, retryable: false, recommendedAction: code === 'AUTH_FAILED' ? '检查 Cloud Run Runtime Service Account / IAM。' : '检查输入、模型和 Vertex 路由配置。', providerHttpStatus: error.httpStatus, providerStatus: error.providerStatus, technicalMessage: error.rawBody } };
    }
  }
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  return { status: 'SUBMISSION_OUTCOME_UNKNOWN', detail: { code: 'SUBMISSION_OUTCOME_UNKNOWN', stage: 'submit', message, retryable: false, recommendedAction: '不要重新提交同一任务；先恢复当前 attempt 的任务专属 GCS 前缀。', technicalMessage: message } };
}

async function completeFromBuffer(task: ProtectedTask, buffer: Buffer, identityReport: MvpIdentityQaReport | null = null, sceneReport: MvpSceneQaReport | null = null): Promise<ProtectedTask> {
  await updateTask(task.taskId, { status: 'SAVING', stage: 'artifact_persist', error: null, identityReport: identityReport ?? task.identityReport ?? null, sceneReport: sceneReport ?? task.sceneReport ?? null });
  try {
    const artifact = await persistCanonicalArtifact(task.taskId, buffer);
    const candidate: ProtectedTask = {
      ...task,
      ...artifact,
      status: 'COMPLETED',
      stage: 'ready',
      identityReport: identityReport ?? task.identityReport ?? null,
      sceneReport: sceneReport ?? task.sceneReport ?? null,
      artifactPersisted: true,
      artifactVerified: true,
      error: null,
      completedAt: now(),
      updatedAt: now(),
    };
    assertProtectedCompletion(candidate);
    return updateTask(task.taskId, candidate);
  } catch (error: any) {
    const message = redactSecrets(error?.message || String(error));
    return updateTask(task.taskId, { status: 'FAILED', stage: 'artifact_persist', artifactPersisted: false, artifactVerified: false, error: { code: 'OUTPUT_PERSIST_FAILED', stage: 'artifact_persist', message, retryable: true, recommendedAction: '检查 GCS 权限/配额后恢复或重新生成。', technicalMessage: message } });
  }
}

async function inspectForQa(task: ProtectedTask, buffer: Buffer) {
  const inspection = await VideoInspector.inspectAndExtractFrames(buffer);
  if (!inspection.valid || inspection.extractedFrames.length < 5) {
    const message = inspection.issueReason || '真实视频抽帧不足，无法执行保护性 QA。';
    return { ok: false as const, task: await updateTask(task.taskId, { status: 'FAILED', stage: task.protectionMode === 'SCENE' ? 'scene_qa' : 'identity_qa', error: { code: 'OUTPUT_INVALID', stage: task.protectionMode === 'SCENE' ? 'scene_qa' : 'identity_qa', message, retryable: false, recommendedAction: '保留当前失败证据并检查生成视频/ffmpeg；未完成适用 QA 的视频不能标记为成功。' } }) };
  }
  if (!task.inputBucket || !task.inputObjectPath) {
    return { ok: false as const, task: await updateTask(task.taskId, { status: 'FAILED', stage: task.protectionMode === 'SCENE' ? 'scene_qa' : 'identity_qa', error: { code: task.protectionMode === 'SCENE' ? 'SCENE_QA_UNAVAILABLE' : 'IDENTITY_QA_UNAVAILABLE', stage: task.protectionMode === 'SCENE' ? 'scene_qa' : 'identity_qa', message: '缺失持久化参考锚点。', retryable: false, recommendedAction: '重新创建受保护任务；不得跳过适用 QA。' } }) };
  }
  return { ok: true as const, inspection, referenceImage: await exactDownload(task.inputBucket, task.inputObjectPath) };
}

async function processGeneratedBuffer(task: ProtectedTask, buffer: Buffer, allowIdentityRetry: boolean): Promise<ProtectedTask> {
  const mode: ProtectionMode = task.protectionMode || 'IDENTITY';
  task = await updateTask(task.taskId, { status: 'QUALITY_CHECKING', stage: mode === 'SCENE' ? 'scene_qa' : 'identity_qa', error: null });
  const prepared = await inspectForQa(task, buffer);
  if (!prepared.ok) return prepared.task;

  if (mode === 'SCENE') {
    let report: MvpSceneQaReport;
    try {
      report = await qaVideoSceneAgainstInput({ projectId: PROJECT_ID, location: REGION, model: task.sceneQaModel || SCENE_QA_MODEL, referenceImage: prepared.referenceImage, referenceMimeType: task.inputMimeType, frames: prepared.inspection.extractedFrames });
    } catch (error: any) {
      const message = redactSecrets(error?.message || String(error));
      return updateTask(task.taskId, { status: 'FAILED', stage: 'scene_qa', error: { code: 'SCENE_QA_UNAVAILABLE', stage: 'scene_qa', message, retryable: true, recommendedAction: 'Scene QA 本身失败；保留当前视频但不得标记 COMPLETED，修复 QA 后重新质检。', technicalMessage: message } });
    }
    task = await updateTask(task.taskId, { sceneReport: report });
    if (report.pass && report.gateStatus === 'pass') return completeFromBuffer(task, buffer, null, report);
    await persistAttemptAuditArtifact(task.taskId, task.providerAttempt || 1, buffer, 'SCENE');
    return updateTask(task.taskId, { status: 'FAILED', stage: 'scene_qa', error: { code: 'SCENE_DRIFT', stage: 'scene_qa', message: `Scene QA 未通过：gate=${report.gateStatus}, scene=${report.sceneSimilarityScore}, composition=${report.compositionConsistencyScore}, subjects=${report.subjectContinuityScore}, temporal=${report.temporalConsistencyScore}.`, retryable: false, recommendedAction: '保持同一场景母板/构图，收敛大幅场景变化后创建新任务。', technicalMessage: report.summary } });
  }

  const attempt = task.providerAttempt || 1;
  let report: MvpIdentityQaReport;
  try {
    report = await qaVideoIdentityAgainstInput({ projectId: PROJECT_ID, location: REGION, model: task.identityQaModel || IDENTITY_QA_MODEL, referenceImage: prepared.referenceImage, referenceMimeType: task.inputMimeType, frames: prepared.inspection.extractedFrames });
  } catch (error: any) {
    const message = redactSecrets(error?.message || String(error));
    return updateTask(task.taskId, { status: 'FAILED', stage: 'identity_qa', error: { code: 'IDENTITY_QA_UNAVAILABLE', stage: 'identity_qa', message, retryable: true, recommendedAction: '身份 QA 本身失败；保留当前视频但不得标记 COMPLETED，修复 QA 后重新质检。', technicalMessage: message } });
  }
  task = await updateTask(task.taskId, { identityReport: report, firstAttemptIdentityReport: attempt === 1 ? report : task.firstAttemptIdentityReport || null });
  if (report.pass && report.gateStatus === 'pass') return completeFromBuffer(task, buffer, report, null);
  await persistAttemptAuditArtifact(task.taskId, attempt, buffer, 'IDENTITY');

  if (allowIdentityRetry && shouldRetryIdentity(report, attempt)) {
    const retryPrompt = buildIdentitySafePrompt(task.prompt, true);
    task = await updateTask(task.taskId, { status: 'RETRYING', stage: 'submit', providerAttempt: 2, identityRetryCount: 1, retryReason: `IDENTITY_DRIFT: min=${report.minimumFaceSimilarityScore}, mean=${report.meanFaceSimilarityScore}, temporal=${report.temporalConsistencyScore}`, effectivePrompt: retryPrompt, providerStorageUri: providerStorageUri(task.taskId, 2), operationName: null, error: null, identityReport: null });
    try {
      const operationName = await submitVeoWithSafeRateRetry({ prompt: retryPrompt, imageBuffer: prepared.referenceImage, mimeType: task.inputMimeType, durationSeconds: task.durationSeconds, taskId: task.taskId, attempt: 2 });
      return updateTask(task.taskId, { status: 'GENERATING', stage: 'polling', operationName, error: null });
    } catch (error) {
      const classified = classifySubmitFailure(error);
      if (classified.status === 'SUBMISSION_OUTCOME_UNKNOWN') return updateTask(task.taskId, { status: classified.status, stage: 'submit', error: classified.detail });
      return updateTask(task.taskId, { status: 'FAILED', stage: 'submit', error: { code: 'IDENTITY_RETRY_FAILED', stage: 'submit', message: classified.detail.message, retryable: classified.detail.retryable, recommendedAction: '身份保守重试提交失败；不要自动进行第二次身份重试。', technicalMessage: classified.detail.technicalMessage } });
    }
  }

  return updateTask(task.taskId, { status: 'FAILED', stage: 'identity_qa', error: { code: 'IDENTITY_DRIFT', stage: 'identity_qa', message: `身份 QA 未通过：gate=${report.gateStatus}, min=${report.minimumFaceSimilarityScore}, mean=${report.meanFaceSimilarityScore}, temporal=${report.temporalConsistencyScore}, visible=${report.visibleFrameRatio}.`, retryable: false, recommendedAction: attempt >= 2 ? '已完成唯一一次保守自动重试；请更换更清晰/更正面的身份锚点。' : '恢复流程不允许自动重新提交；请从正常生成入口重新创建任务。', technicalMessage: report.summary } });
}

async function recoverFromProviderPrefix(task: ProtectedTask): Promise<{ task: ProtectedTask; found: boolean }> {
  const attempt = task.providerAttempt || 1;
  const [files] = await storage.bucket(OUTPUT_BUCKET).getFiles({ prefix: providerPrefix(task.taskId, attempt) });
  const candidates: string[] = [];
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.mp4')) continue;
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size || 0) >= 1000) candidates.push(file.name);
  }
  if (candidates.length === 0) return { task, found: false };
  if (candidates.length > 1) return { task: await updateTask(task.taskId, { error: { code: 'OUTPUT_MISSING', stage: 'output_fetch', message: `当前 attempt-${attempt} 发现 ${candidates.length} 个视频，无法安全绑定。`, retryable: false, recommendedAction: '人工核实 GCS 产物；恢复接口绝不自动重新提交 Veo。', technicalMessage: candidates.join(', ') } }), found: false };
  const buffer = await exactDownload(OUTPUT_BUCKET, candidates[0]);
  if (!VideoGenerator.isMp4Valid(buffer)) return { task, found: false };
  return { task: await processGeneratedBuffer(task, buffer, false), found: true };
}

function renderMvpPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>造境 Identity Safe v0.2.2</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#09090b;color:#fafafa;margin:0;padding:20px}main{max-width:820px;margin:auto}section{background:#18181b;border:1px solid #27272a;border-radius:16px;padding:20px;margin:16px 0}input,textarea,select,button{font:inherit}textarea,select,input[type=file]{width:100%;box-sizing:border-box;margin:8px 0 16px;background:#09090b;color:#fafafa;border:1px solid #3f3f46;border-radius:10px;padding:10px}textarea{min-height:150px}button{background:#7c3aed;color:white;border:0;border-radius:10px;padding:12px 18px;font-weight:700;cursor:pointer;margin-right:8px;margin-top:6px}button.secondary{background:#27272a}button:disabled{opacity:.45}.ok{color:#34d399}.bad{color:#fb7185}.warn{color:#fbbf24}.info{color:#93c5fd}.muted{color:#a1a1aa;font-size:13px}.badge{display:inline-block;padding:4px 8px;border-radius:99px;background:#312e81;color:#c7d2fe;font-size:12px}.hint{padding:10px 12px;border:1px solid #3f3f46;border-radius:10px;margin:10px 0;background:#111113}.hidden{display:none}pre{white-space:pre-wrap;word-break:break-word;background:#09090b;padding:12px;border-radius:10px;border:1px solid #27272a;max-height:620px;overflow:auto}video{width:100%;border-radius:12px;background:black}</style></head><body><main>
<h1>造境 <span class="badge">Identity Safe v0.2.2</span></h1><p class="muted">保护路由：自动尺寸修复 → 自动判断 IDENTITY / SCENE → 单人走严格身份 QA，群像/场景走 Scene Consistency QA → Veo AUTO 横竖屏 → 通过适用 QA 后持久化。</p>
<section><label>首帧参考图（小图自动等比例增强；不会 AI 重绘或裁剪）</label><input id="image" type="file" accept="image/jpeg,image/png,image/webp"/><label>场景 / 动作 Prompt</label><textarea id="prompt"></textarea><label>时长</label><select id="duration"><option value="4">4s（优先）</option><option value="6">6s</option><option value="8">8s（压力测试）</option></select><button id="go">受保护生成</button><button id="resume" class="secondary hidden">恢复最近任务</button></section>
<section><div id="headline">尚未开始</div><div id="hint" class="hint hidden"></div><pre id="status">{}</pre><button id="recover" class="secondary hidden">恢复当前 Attempt 产物（不重新提交 Veo）</button></section><section id="videoBox" class="hidden"><video id="video" controls></video><p><a id="download" style="color:#c4b5fd" download>下载通过适用 QA 的视频</a></p></section>
<script>const $=id=>document.getElementById(id),K='zaojing.mvp.v022.key',T='zaojing.mvp.v022.task';let taskId=sessionStorage.getItem(T)||null,key=sessionStorage.getItem(K)||null,timer=null;const terminal=new Set(['COMPLETED','FAILED','SUBMISSION_OUTCOME_UNKNOWN']);function hint(t,c='info'){$('hint').textContent=t;$('hint').className='hint '+c;$('hint').classList.remove('hidden')}function show(d){$('status').textContent=JSON.stringify(d,null,2);let q=d.protectionMode==='SCENE'?d.sceneReport:d.identityReport;$('headline').textContent=(d.status?'状态：'+d.status:'状态未知')+(d.protectionMode?' | 保护：'+d.protectionMode:'')+(q?' | QA：'+q.gateStatus:'');$('headline').className=d.status==='COMPLETED'?'ok':d.status==='FAILED'?'bad':['QUALITY_CHECKING','RETRYING'].includes(d.status)?'warn':'info';$('recover').classList.toggle('hidden',d.status!=='SUBMISSION_OUTCOME_UNKNOWN');if(d.inputPreprocess?.autoEnhanced)hint('图片已自动等比例优化：'+d.inputPreprocess.originalWidth+'×'+d.inputPreprocess.originalHeight+' → '+d.inputPreprocess.processedWidth+'×'+d.inputPreprocess.processedHeight+'；方向 '+d.inputPreprocess.orientation,'info');if(d.error?.recommendedAction)hint(d.error.recommendedAction,'warn');if(d.videoUrl){$('videoBox').classList.remove('hidden');$('video').src=d.videoUrl;$('download').href=d.videoUrl+'?download=1'}}async function json(r){const t=await r.text();return JSON.parse(t)}function save(d,k){if(k){key=k;sessionStorage.setItem(K,k);$('resume').classList.remove('hidden')}if(d?.taskId){taskId=d.taskId;sessionStorage.setItem(T,taskId)}}async function lookup(){if(!key)return null;const r=await fetch('/api/mvp/videos/lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idempotencyKey:key})});if(r.status===404)return null;return json(r)}async function poll(){if(!taskId)return;try{const r=await fetch('/api/mvp/videos/'+encodeURIComponent(taskId),{cache:'no-store'}),d=await json(r);show(d);if(!terminal.has(d.status))timer=setTimeout(poll,4500);else $('go').disabled=false}catch(e){hint('网络暂时中断，继续查询同一 taskId，不会重复提交。','warn');timer=setTimeout(poll,7000)}}$('go').onclick=async()=>{const image=$('image').files[0],prompt=$('prompt').value.trim(),duration=$('duration').value;if(!image||!prompt){alert('请选择图片并填写 Prompt');return}$('go').disabled=true;$('videoBox').classList.add('hidden');key=crypto.randomUUID();sessionStorage.setItem(K,key);const fd=new FormData();fd.append('image',image);fd.append('prompt',prompt);fd.append('durationSeconds',duration);fd.append('identitySafeMode','true');try{const r=await fetch('/api/mvp/videos/start',{method:'POST',headers:{'x-idempotency-key':key},body:fd}),d=await json(r);save(d,key);show(d);if(d.taskId&&!terminal.has(d.status))timer=setTimeout(poll,2500);else $('go').disabled=false}catch(e){hint('生成请求连接中断。请点击【恢复最近任务】，系统会用同一 idempotency key 查询，不重复提交。','warn');$('resume').classList.remove('hidden');$('go').disabled=false}};$('resume').onclick=async()=>{try{const d=await lookup();if(!d){hint('当前 key 暂未找到任务。','info');return}save(d,key);show(d);if(!terminal.has(d.status))timer=setTimeout(poll,1000)}catch(e){hint('恢复查询失败，请稍后再试。','warn')}};$('recover').onclick=async()=>{if(!taskId)return;const r=await fetch('/api/mvp/videos/'+encodeURIComponent(taskId)+'/recover',{method:'POST'}),d=await json(r);show(d)};if(key){$('resume').classList.remove('hidden');lookup().then(d=>{if(d){save(d,key);show(d);if(!terminal.has(d.status))timer=setTimeout(poll,1000)}}).catch(()=>{})}</script></main></body></html>`;
}

export async function createMvpAppV022() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/', (_req, res) => res.type('html').send(renderMvpPage()));
  app.get('/api/mvp/client-health', (_req, res) => res.json({ status: 'ok', clientVersion: CLIENT_VERSION, identitySafeVersion: PROTECTION_VERSION, sceneSafeVersion: SCENE_SAFE_VERSION, networkRecovery: true, idempotencyLookup: true, protectionRouting: true, autoPreprocess: true }));
  app.get('/api/mvp/benchmark/catalog', (_req, res) => res.json({ version: 'identity-stability-benchmark-v1', cases: IDENTITY_STABILITY_BENCHMARK_V1 }));
  app.get('/api/mvp/health', (_req, res) => res.json({ status: 'ok', mode: 'MVP_IDENTITY_SAFE_V022', identitySafeVersion: PROTECTION_VERSION, sceneSafeVersion: SCENE_SAFE_VERSION, provider: MVP_PROVIDER, model: MVP_VIDEO_MODEL, identityQaModel: IDENTITY_QA_MODEL, protectionRouterModel: PROTECTION_ROUTER_MODEL, sceneQaModel: SCENE_QA_MODEL, projectId: PROJECT_ID, region: REGION, outputBucketConfigured: Boolean(OUTPUT_BUCKET), commitSha: process.env.K_REVISION || process.env.COMMIT_SHA || null }));
  app.get('/api/mvp/readiness', async (_req, res) => {
    const result: any = { ready: false, mode: 'MVP_IDENTITY_SAFE_V022', identitySafeVersion: PROTECTION_VERSION, sceneSafeVersion: SCENE_SAFE_VERSION, provider: MVP_PROVIDER, model: MVP_VIDEO_MODEL, identityQaModel: IDENTITY_QA_MODEL, protectionRouterModel: PROTECTION_ROUTER_MODEL, sceneQaModel: SCENE_QA_MODEL, projectId: PROJECT_ID, region: REGION, outputBucket: OUTPUT_BUCKET || null, auth: 'unknown', firestore: 'unknown', gcs: 'unknown', ffmpeg: 'configured', vertexRoute: 'unknown', commitSha: process.env.K_REVISION || process.env.COMMIT_SHA || null };
    try {
      if (!OUTPUT_BUCKET) throw new Error('VEO_OUTPUT_BUCKET is missing.');
      const token = await getAccessToken(); result.auth = 'ok';
      const db = getFirestoreInstance(); if (!db) throw new Error('Firestore unavailable.');
      await db.collection('_mvp_health').doc('identity-safe-v022').get(); result.firestore = 'ok';
      await storage.bucket(OUTPUT_BUCKET).file('_mvp_identity_readiness_probe_nonexistent').exists(); result.gcs = 'ok';
      const routeRes = await fetchWithTimeout(submitEndpoint(), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ instances: [] }) }, 15_000);
      result.vertexRoute = routeRes.status === 400 ? 'ok' : `http_${routeRes.status}`;
      result.ready = result.auth === 'ok' && result.firestore === 'ok' && result.gcs === 'ok' && result.vertexRoute === 'ok';
      return res.status(result.ready ? 200 : 503).json(result);
    } catch (error: any) { result.error = redactSecrets(error?.message || String(error)); return res.status(503).json(result); }
  });

  app.post('/api/mvp/videos/lookup', async (req, res) => {
    try {
      const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
      if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) return res.status(400).json({ error: { code: 'IDEMPOTENCY_KEY_INVALID', message: 'Invalid idempotency key.' } });
      const db = getFirestoreInstance(); if (!db) return res.status(503).json({ error: { code: 'FIRESTORE_UNAVAILABLE', message: 'Firestore unavailable.' } });
      const idemSnap = await db.collection(IDEMPOTENCY_COLLECTION).doc(sha256(idempotencyKey)).get();
      if (!idemSnap.exists) return res.status(404).json({ error: { code: 'TASK_NOT_FOUND', message: 'No task exists for this idempotency key yet.' } });
      const task = await getTask(String(idemSnap.data()?.taskId || ''));
      if (!task) return res.status(404).json({ error: { code: 'TASK_NOT_FOUND', message: 'Task record is missing.' } });
      return res.json(publicTask(task));
    } catch (error: any) { return res.status(500).json({ error: { code: 'LOOKUP_FAILED', message: String(error?.message || error) } }); }
  });

  app.post('/api/mvp/chatgpt/keys', async (_req, res) => {
    try {
      const db = getFirestoreInstance(); if (!db) return res.status(503).json({ error: { code: 'FIRESTORE_UNAVAILABLE', message: 'Firestore unavailable.' } });
      const apiKey = 'zjg_' + crypto.randomBytes(32).toString('base64url');
      await db.collection(CHATGPT_KEY_COLLECTION).doc(sha256(apiKey)).create({ createdAt: now(), revokedAt: null, purpose: 'chatgpt-actions-v1' });
      return res.status(201).json({ apiKey, createdAt: now(), warning: 'This key is shown once.' });
    } catch (error: any) { return res.status(500).json({ error: { code: 'CHATGPT_KEY_CREATE_FAILED', message: String(error?.message || error) } }); }
  });

  app.post('/api/mvp/videos/start', upload.single('image'), async (req, res) => {
    try {
      if (!OUTPUT_BUCKET) return res.status(503).json({ status: 'FAILED', error: { code: 'STORAGE_CONFIG_INVALID', stage: 'artifact_persist', message: 'VEO_OUTPUT_BUCKET is missing.' } });
      const file = req.file;
      const prompt = String(req.body?.prompt || '').trim();
      const durationSeconds = Number(req.body?.durationSeconds || 4);
      const idempotencyKey = String(req.header('x-idempotency-key') || '').trim() || crypto.randomUUID();
      if (!file || !isSupportedImage(file.buffer, file.mimetype)) return res.status(400).json({ status: 'FAILED', error: inputError('INPUT_IMAGE_INVALID', '图片必须是有效 JPG/PNG/WebP。') });
      if (!prompt || prompt.length > 12_000) return res.status(400).json({ status: 'FAILED', error: inputError('PROMPT_INVALID', 'Prompt 不能为空且长度不得超过 12000 字符。') });
      if (!(MVP_ALLOWED_DURATIONS as readonly number[]).includes(durationSeconds)) return res.status(400).json({ status: 'FAILED', error: inputError('PROMPT_INVALID', 'durationSeconds 仅允许 4、6、8。') });

      let preprocess: ImagePreprocessResult;
      try { preprocess = await preprocessVeoImage(file.buffer); }
      catch (error: any) { return res.status(400).json({ status: 'FAILED', error: inputError('INPUT_IMAGE_INVALID', '无法读取图片尺寸。', String(error?.message || error)) }); }

      let intent: IdentityIntentReport;
      try {
        intent = await classifyIdentityIntent({ projectId: PROJECT_ID, location: REGION, model: PROTECTION_ROUTER_MODEL, imageBuffer: preprocess.buffer, mimeType: file.mimetype, prompt });
      } catch (error: any) {
        intent = failClosedIdentityIntent(`Protection router unavailable; strict identity mode selected: ${redactSecrets(error?.message || String(error))}`);
      }
      const protectionMode = intent.mode;
      if (protectionMode === 'IDENTITY') {
        const safeCheck = await validateIdentitySafeInput({ imageBuffer: preprocess.buffer, prompt });
        if (!safeCheck.pass) return res.status(400).json({ status: 'FAILED', protectionMode, intentReport: intent, inputPreprocess: { originalWidth: preprocess.originalWidth, originalHeight: preprocess.originalHeight, processedWidth: preprocess.processedWidth, processedHeight: preprocess.processedHeight, orientation: preprocess.orientation, autoEnhanced: preprocess.autoEnhanced }, error: inputError('IDENTITY_INPUT_UNSAFE', safeCheck.issues[0]?.message || 'Identity Safe 输入不满足要求。', JSON.stringify(safeCheck)) });
      }
      const effectivePrompt = protectionMode === 'IDENTITY' ? buildIdentitySafePrompt(prompt, false) : buildSceneSafePrompt(prompt);
      const preprocessPublic: InputPreprocessPublic = { originalWidth: preprocess.originalWidth, originalHeight: preprocess.originalHeight, processedWidth: preprocess.processedWidth, processedHeight: preprocess.processedHeight, orientation: preprocess.orientation, autoEnhanced: preprocess.autoEnhanced };
      const created = await createTaskIdempotently({ idempotencyKey, prompt, effectivePrompt, durationSeconds, imageBuffer: preprocess.buffer, mimeType: file.mimetype, originalMimeType: file.mimetype, protectionMode, intentReport: intent, inputPreprocess: preprocessPublic });
      if (created.existing) return res.status(200).json(publicTask(created.task));
      let task = created.task;
      try {
        const objectPath = await persistInputReference(task.taskId, preprocess.buffer, file.mimetype, protectionMode);
        task = await updateTask(task.taskId, { inputBucket: OUTPUT_BUCKET, inputObjectPath: objectPath, status: 'SUBMITTING', stage: 'submit' });
      } catch (error: any) {
        const message = redactSecrets(error?.message || String(error));
        task = await updateTask(task.taskId, { status: 'FAILED', stage: 'artifact_persist', error: { code: 'OUTPUT_PERSIST_FAILED', stage: 'artifact_persist', message: `参考锚点持久化失败: ${message}`, retryable: true, recommendedAction: '检查 GCS 权限后重新创建任务；不允许在没有持久化参考锚点时提交受保护视频。', technicalMessage: message } });
        return res.status(502).json(publicTask(task));
      }
      try {
        const operationName = await submitVeoWithSafeRateRetry({ prompt: effectivePrompt, imageBuffer: preprocess.buffer, mimeType: file.mimetype, durationSeconds, taskId: task.taskId, attempt: 1 });
        task = await updateTask(task.taskId, { status: 'GENERATING', stage: 'polling', operationName, error: null });
        return res.status(202).json(publicTask(task));
      } catch (error) {
        const classified = classifySubmitFailure(error);
        task = await updateTask(task.taskId, { status: classified.status, stage: 'submit', error: classified.detail });
        return res.status(classified.status === 'FAILED' ? 502 : 202).json(publicTask(task));
      }
    } catch (error: any) { return res.status(500).json({ status: 'FAILED', error: { code: 'INTERNAL_ERROR', stage: 'internal', message: redactSecrets(error?.message || String(error)), retryable: false, recommendedAction: '检查 Cloud Run / Firestore 日志。' } }); }
  });

  app.get('/api/mvp/videos/:taskId', async (req, res) => {
    try {
      let task = await getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: 'task_not_found' });
      if (['COMPLETED', 'FAILED', 'SUBMISSION_OUTCOME_UNKNOWN'].includes(task.status)) return res.json(publicTask(task));
      if (!task.operationName) {
        task = await updateTask(task.taskId, { status: 'SUBMISSION_OUTCOME_UNKNOWN', stage: 'submit', error: { code: 'SUBMISSION_OUTCOME_UNKNOWN', stage: 'submit', message: '任务没有 durable operationName，无法安全轮询。', retryable: false, recommendedAction: '先恢复当前 attempt 的任务专属 GCS 产物，不要重新提交 Veo。' } });
        return res.json(publicTask(task));
      }
      let providerResponse: any;
      try { providerResponse = await pollProvider(task.operationName); }
      catch (error: any) {
        const status = error instanceof ProviderHttpError ? error.httpStatus : null;
        if (status === 401 || status === 403 || status === 404) {
          task = await updateTask(task.taskId, { status: 'FAILED', stage: status === 401 || status === 403 ? 'auth' : 'polling', error: { code: status === 401 || status === 403 ? 'AUTH_FAILED' : 'GENERATION_FAILED', stage: status === 401 || status === 403 ? 'auth' : 'polling', message: redactSecrets(error?.message || String(error)), retryable: false, recommendedAction: status === 404 ? '核对 Operation Name、区域和模型。' : '检查 Runtime Service Account IAM。', providerHttpStatus: status, providerStatus: error.providerStatus || null } });
          return res.status(502).json(publicTask(task));
        }
        task = await updateTask(task.taskId, { pollAttempt: (task.pollAttempt || 0) + 1, error: { code: 'GENERATION_TIMEOUT', stage: 'polling', message: redactSecrets(error?.message || String(error)), retryable: true, recommendedAction: '继续轮询同一 Operation；不要重新提交 Veo。', providerHttpStatus: status, providerStatus: error?.providerStatus || null } });
        return res.status(503).json(publicTask(task));
      }
      task = await updateTask(task.taskId, { pollAttempt: (task.pollAttempt || 0) + 1, error: null });
      if (!providerResponse?.done) return res.status(202).json(publicTask(task));
      if (providerResponse.error) {
        const safety = VideoGenerator.checkSafetyBlock(null, providerResponse.error);
        const normalized = normalizeProviderFailureReason({ failureReason: safety.isBlocked ? 'output_rai_filtered' : 'upstream_failed', message: safety.reason || redactSecrets(JSON.stringify(providerResponse.error)), providerStatus: providerResponse?.error?.status || null, httpStatus: providerResponse?.error?.code || null });
        task = await updateTask(task.taskId, { status: 'FAILED', stage: normalized.stage, error: normalized }); return res.status(502).json(publicTask(task));
      }
      const responseBody = providerResponse.response || providerResponse;
      const safety = VideoGenerator.checkSafetyBlock(responseBody);
      if (safety.isBlocked) {
        const normalized = normalizeProviderFailureReason({ failureReason: 'output_rai_filtered', message: safety.reason || 'Vertex AI safety filtering removed the generated media.' });
        task = await updateTask(task.taskId, { status: 'FAILED', stage: normalized.stage, error: normalized }); return res.status(422).json(publicTask(task));
      }
      await updateTask(task.taskId, { status: 'SAVING', stage: 'output_fetch' });
      let buffer: Buffer;
      try { buffer = await downloadProviderArtifact(task.taskId, task.providerAttempt || 1, responseBody); }
      catch (error: any) {
        const normalized = normalizeProviderFailureReason({ failureReason: 'upstream_empty_response', message: redactSecrets(error?.message || String(error)) });
        task = await updateTask(task.taskId, { status: 'FAILED', stage: normalized.stage, error: normalized }); return res.status(502).json(publicTask(task));
      }
      task = await processGeneratedBuffer(task, buffer, true);
      return res.status(task.status === 'COMPLETED' ? 200 : task.status === 'GENERATING' ? 202 : 502).json(publicTask(task));
    } catch (error: any) { return res.status(500).json({ error: redactSecrets(error?.message || String(error)) }); }
  });

  app.post('/api/mvp/videos/:taskId/recover', async (req, res) => {
    try {
      const task = await getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: 'task_not_found' });
      if (task.status === 'COMPLETED') return res.json(publicTask(task));
      const recovered = await recoverFromProviderPrefix(task);
      if (!recovered.found) return res.status(404).json(publicTask(recovered.task));
      return res.json(publicTask(recovered.task));
    } catch (error: any) { return res.status(500).json({ error: redactSecrets(error?.message || String(error)) }); }
  });

  app.get('/api/mvp/videos/:taskId/stream', async (req, res) => {
    try {
      const task = await getTask(req.params.taskId);
      if (!task || task.status !== 'COMPLETED') return res.status(404).json({ error: 'video_not_ready' });
      assertProtectedCompletion(task);
      const buffer = await exactDownload(task.outputBucket!, task.outputObjectPath!);
      if (!VideoGenerator.isMp4Valid(buffer)) return res.status(500).json({ error: 'persisted_video_invalid' });
      const isDownload = req.query.download === '1' || req.query.download === 'true';
      const range = req.headers.range;
      res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Type', 'video/mp4');
      if (isDownload) res.setHeader('Content-Disposition', `attachment; filename="zaojing_protected_${task.taskId}.mp4"`);
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range); if (!match) return res.status(416).end();
        const start = match[1] ? Number(match[1]) : 0; const end = match[2] ? Number(match[2]) : buffer.length - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= buffer.length) { res.setHeader('Content-Range', `bytes */${buffer.length}`); return res.status(416).end(); }
        res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${buffer.length}`); res.setHeader('Content-Length', String(end - start + 1)); return res.end(buffer.subarray(start, end + 1));
      }
      res.setHeader('Content-Length', String(buffer.length)); return res.end(buffer);
    } catch (error: any) { return res.status(500).json({ error: redactSecrets(error?.message || String(error)) }); }
  });

  return app;
}

export async function startMvpServerV022() {
  const app = await createMvpAppV022();
  return app.listen(PORT, '0.0.0.0', () => console.log(`[MVP_IDENTITY_SAFE_V022] listening on :${PORT}; provider=${MVP_PROVIDER}; model=${MVP_VIDEO_MODEL}; identityQa=${IDENTITY_QA_MODEL}; sceneQa=${SCENE_QA_MODEL}; router=${PROTECTION_ROUTER_MODEL}; project=${PROJECT_ID}; region=${REGION}; bucket=${OUTPUT_BUCKET || 'MISSING'}`));
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) void startMvpServerV022();
