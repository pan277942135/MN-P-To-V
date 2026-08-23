import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { GoogleGenAI, Type } from '@google/genai';
import { getFirestoreInstance } from '../server/db/firestore';
import { durableCharacterService } from '../server/services/durableCharacterService';
import { redactSecrets } from '../utils/redactSecrets';
import {
  DEFAULT_TARGET_HEAD_BODY_RATIO,
  HEAD_ONLY_IMAGE_VERSION,
  buildHeadOnlyEditPrompt,
  evaluateHeadOnlyQaGate,
  type HeadOnlyQaReport,
} from './headOnlyImagePolicy';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || 'xp-vertex-project';
const REGION = process.env.VERTEX_LOCATION || process.env.GCP_REGION || 'us-central1';
const OUTPUT_BUCKET = String(process.env.VEO_OUTPUT_BUCKET || '').replace(/^gs:\/\//, '').replace(/\/+$/, '');
const IMAGE_MODEL = process.env.HEAD_SWAP_IMAGE_MODEL || process.env.IMAGE_MODEL || 'gemini-3.1-flash-image';
const QA_MODEL = process.env.HEAD_SWAP_QA_MODEL || process.env.IDENTITY_QA_MODEL || 'gemini-3.6-flash';
const TASK_COLLECTION = 'mvp_image_tasks';
const IDEMPOTENCY_COLLECTION = 'mvp_image_idempotency';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
const storage = new Storage();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

type ImageTaskStatus = 'PROCESSING' | 'COMPLETED' | 'QA_FAILED' | 'FAILED';

type ImageTaskRecord = {
  taskId: string;
  status: ImageTaskStatus;
  mode: 'HEAD_ONLY_CHARACTER_SWAP';
  version: string;
  characterId: string;
  characterName: string;
  targetHeadBodyRatio: number;
  imageModel: string;
  qaModel: string;
  inputBucket?: string;
  inputObjectPath?: string;
  inputMimeType?: string;
  outputBucket?: string;
  outputObjectPath?: string;
  outputMimeType?: string;
  sizeBytes?: number;
  artifactPersisted: boolean;
  artifactVerified: boolean;
  generatorAttempt: number;
  qaReport?: (HeadOnlyQaReport & { pass: boolean; failedChecks: string[] }) | null;
  firstAttemptQaReport?: (HeadOnlyQaReport & { pass: boolean; failedChecks: string[] }) | null;
  error?: { code: string; stage: string; message: string; retryable: boolean; recommendedAction?: string } | null;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

function now() { return Date.now(); }
function sha256(value: Buffer | string) { return crypto.createHash('sha256').update(value).digest('hex'); }
function inputExtension(mime: string) { return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'; }
function outputExtension(mime: string) { return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'; }
function inputObjectPath(taskId: string, mime: string) { return `images/${taskId}/input/source.${inputExtension(mime)}`; }
function outputObjectPath(taskId: string, mime: string) { return `images/${taskId}/output/head-only.${outputExtension(mime)}`; }

function isSupportedImage(buffer: Buffer, mimeType: string): boolean {
  if (!buffer || buffer.length < 12 || buffer.length > MAX_IMAGE_BYTES) return false;
  const mime = String(mimeType || '').toLowerCase();
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  const webp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return (mime === 'image/jpeg' && jpeg) || (mime === 'image/png' && png) || (mime === 'image/webp' && webp);
}

async function validateSourceImage(buffer: Buffer): Promise<{ width: number; height: number }> {
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height) throw new Error('SOURCE_IMAGE_DIMENSIONS_INVALID');
  if (Math.min(width, height) < 512) throw new Error('SOURCE_IMAGE_SHORT_EDGE_BELOW_512');
  return { width, height };
}

async function getAccessToken(): Promise<string> {
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  const token = typeof result === 'string' ? result : result?.token;
  if (!token) throw new Error('ADC_ACCESS_TOKEN_UNAVAILABLE');
  return token;
}

async function getAiClient(): Promise<GoogleGenAI> {
  const token = await getAccessToken();
  return new GoogleGenAI({
    vertexai: true,
    project: PROJECT_ID,
    location: REGION,
    httpOptions: { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'zaojing-head-only-uat' } },
  });
}

async function exactDownload(bucket: string, objectPath: string): Promise<Buffer> {
  const [bytes] = await storage.bucket(bucket).file(objectPath).download();
  return Buffer.from(bytes);
}

async function persistInput(taskId: string, buffer: Buffer, mimeType: string): Promise<string> {
  if (!OUTPUT_BUCKET) throw new Error('VEO_OUTPUT_BUCKET_MISSING');
  const path = inputObjectPath(taskId, mimeType);
  await storage.bucket(OUTPUT_BUCKET).file(path).save(buffer, {
    resumable: false,
    metadata: { contentType: mimeType, metadata: { purpose: 'head-only-source' } },
  });
  const verified = await exactDownload(OUTPUT_BUCKET, path);
  if (!verified.equals(buffer)) throw new Error('SOURCE_IMAGE_PERSIST_VERIFY_FAILED');
  return path;
}

async function persistOutput(taskId: string, buffer: Buffer, mimeType: string) {
  if (!OUTPUT_BUCKET) throw new Error('VEO_OUTPUT_BUCKET_MISSING');
  const path = outputObjectPath(taskId, mimeType);
  const file = storage.bucket(OUTPUT_BUCKET).file(path);
  await file.save(buffer, { resumable: false, metadata: { contentType: mimeType, metadata: { purpose: 'qa-passed-head-only-output' } } });
  const [exists] = await file.exists();
  if (!exists) throw new Error('OUTPUT_IMAGE_PERSIST_VERIFY_FAILED');
  const exact = await exactDownload(OUTPUT_BUCKET, path);
  if (exact.length < 10 * 1024) throw new Error('OUTPUT_IMAGE_TOO_SMALL_AFTER_PERSIST');
  const metadata = await sharp(exact).metadata();
  if (!metadata.width || !metadata.height) throw new Error('OUTPUT_IMAGE_DECODE_VERIFY_FAILED');
  return { outputBucket: OUTPUT_BUCKET, outputObjectPath: path, outputMimeType: mimeType, sizeBytes: exact.length };
}

async function createTaskIdempotently(params: { idempotencyKey: string; characterId: string; characterName: string; targetHeadBodyRatio: number }): Promise<{ task: ImageTaskRecord; existing: boolean }> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('FIRESTORE_UNAVAILABLE');
  const keyHash = sha256(params.idempotencyKey);
  const idemRef = db.collection(IDEMPOTENCY_COLLECTION).doc(keyHash);
  const taskId = `img_${crypto.randomUUID()}`;
  const taskRef = db.collection(TASK_COLLECTION).doc(taskId);
  const createdAt = now();
  return db.runTransaction(async (tx) => {
    const idemSnap = await tx.get(idemRef);
    if (idemSnap.exists) {
      const existingTaskId = String(idemSnap.data()?.taskId || '');
      if (!existingTaskId) throw new Error('IDEMPOTENCY_RECORD_INVALID');
      const existingSnap = await tx.get(db.collection(TASK_COLLECTION).doc(existingTaskId));
      if (!existingSnap.exists) throw new Error('IDEMPOTENT_TASK_MISSING');
      return { task: existingSnap.data() as ImageTaskRecord, existing: true };
    }
    const task: ImageTaskRecord = {
      taskId,
      status: 'PROCESSING',
      mode: 'HEAD_ONLY_CHARACTER_SWAP',
      version: HEAD_ONLY_IMAGE_VERSION,
      characterId: params.characterId,
      characterName: params.characterName,
      targetHeadBodyRatio: params.targetHeadBodyRatio,
      imageModel: IMAGE_MODEL,
      qaModel: QA_MODEL,
      artifactPersisted: false,
      artifactVerified: false,
      generatorAttempt: 0,
      qaReport: null,
      firstAttemptQaReport: null,
      error: null,
      createdAt,
      updatedAt: createdAt,
    };
    tx.create(taskRef, task);
    tx.create(idemRef, { taskId, createdAt, characterId: params.characterId });
    return { task, existing: false };
  });
}

async function updateTask(taskId: string, patch: Partial<ImageTaskRecord>): Promise<ImageTaskRecord> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('FIRESTORE_UNAVAILABLE');
  const ref = db.collection(TASK_COLLECTION).doc(taskId);
  await ref.update({ ...patch, updatedAt: now() });
  const snap = await ref.get();
  if (!snap.exists) throw new Error('TASK_DISAPPEARED');
  return snap.data() as ImageTaskRecord;
}

async function getTask(taskId: string): Promise<ImageTaskRecord | null> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('FIRESTORE_UNAVAILABLE');
  const snap = await db.collection(TASK_COLLECTION).doc(taskId).get();
  return snap.exists ? (snap.data() as ImageTaskRecord) : null;
}

function publicTask(task: ImageTaskRecord) {
  return {
    taskId: task.taskId,
    status: task.status,
    mode: task.mode,
    version: task.version,
    characterId: task.characterId,
    characterName: task.characterName,
    targetHeadBodyRatio: task.targetHeadBodyRatio,
    imageModel: task.imageModel,
    qaModel: task.qaModel,
    generatorAttempt: task.generatorAttempt,
    repairAttempts: Math.max(0, (task.generatorAttempt || 1) - 1),
    qaPassed: task.status === 'COMPLETED' && task.qaReport?.pass === true,
    qaReport: task.qaReport || null,
    firstAttemptQaReport: task.firstAttemptQaReport || null,
    artifactPersisted: task.artifactPersisted,
    artifactVerified: task.artifactVerified,
    sizeBytes: task.sizeBytes || null,
    imageUrl: task.status === 'COMPLETED' ? `/api/mvp/images/${task.taskId}/stream` : null,
    error: task.error || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt || null,
  };
}

async function generateCandidate(params: {
  ai: GoogleGenAI;
  sourceBuffer: Buffer;
  sourceMimeType: string;
  characterName: string;
  identityLockPromptEnglish?: string;
  masters: Array<{ buffer: Buffer; mimeType: string; angle?: string }>;
  targetHeadBodyRatio: number;
  repairInstruction?: string;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  const parts: any[] = [
    { inlineData: { mimeType: params.sourceMimeType, data: params.sourceBuffer.toString('base64') } },
    { text: '[ORIGINAL_SOURCE_IMAGE]: Immutable scene/body source. Edit only the head region defined by the instructions.' },
  ];
  params.masters.slice(0, 4).forEach((master, index) => {
    parts.push({ inlineData: { mimeType: master.mimeType, data: master.buffer.toString('base64') } });
    parts.push({ text: `[TARGET_CHARACTER_MASTER_${index + 1}]: Identity authority, angle=${master.angle || 'reference'}.` });
  });
  parts.push({ text: buildHeadOnlyEditPrompt({
    characterName: params.characterName,
    identityLockPromptEnglish: params.identityLockPromptEnglish,
    targetHeadBodyRatio: params.targetHeadBodyRatio,
    repairInstruction: params.repairInstruction,
  }) });

  const response = await params.ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: [{ role: 'user', parts }],
  });
  for (const candidate of response.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      const inline = (part as any).inlineData || (part as any).inline_data;
      const b64 = inline?.data || inline?.bytesBase64Encoded;
      if (!b64) continue;
      const buffer = Buffer.from(b64, 'base64');
      if (buffer.length < 10 * 1024) continue;
      const metadata = await sharp(buffer).metadata();
      if (!metadata.width || !metadata.height) continue;
      const mimeType = metadata.format === 'png' ? 'image/png' : metadata.format === 'webp' ? 'image/webp' : 'image/jpeg';
      return { buffer, mimeType };
    }
  }
  throw new Error('IMAGE_MODEL_RETURNED_NO_VALID_IMAGE');
}

async function runHeadOnlyQa(params: {
  ai: GoogleGenAI;
  sourceBuffer: Buffer;
  sourceMimeType: string;
  candidateBuffer: Buffer;
  candidateMimeType: string;
  masters: Array<{ buffer: Buffer; mimeType: string; angle?: string }>;
  identitySpec: any;
  targetHeadBodyRatio: number;
}): Promise<HeadOnlyQaReport & { pass: boolean; failedChecks: string[] }> {
  const parts: any[] = [
    { inlineData: { mimeType: params.sourceMimeType, data: params.sourceBuffer.toString('base64') } },
    { text: '[ORIGINAL_SOURCE_IMAGE]' },
  ];
  params.masters.slice(0, 4).forEach((master, index) => {
    parts.push({ inlineData: { mimeType: master.mimeType, data: master.buffer.toString('base64') } });
    parts.push({ text: `[TARGET_CHARACTER_MASTER_${index + 1}]` });
  });
  parts.push({ inlineData: { mimeType: params.candidateMimeType, data: params.candidateBuffer.toString('base64') } });
  parts.push({ text: '[CANDIDATE_HEAD_ONLY_OUTPUT]' });
  parts.push({ text: `
You are the final forensic QA gate for a HEAD-ONLY identity replacement image. Compare the candidate against the ORIGINAL SOURCE IMAGE and all TARGET CHARACTER MASTER references.
IdentitySpec: ${JSON.stringify(params.identitySpec || {})}
Target full-body proportion: approximately 1:${params.targetHeadBodyRatio} head-to-body when full body is visible.

Score 0-100 with these strict meanings:
- identityScore: target-character facial identity accuracy. Pass >=95.
- sourceIdentityResidualScore: residual original-person facial identity. Pass <=5.
- headOnlyPreservationScore: pixel-semantic preservation outside head/minimal neck seam. Pass >=97.
- bodyPreservationScore: shoulders and every body region below neck unchanged. Pass >=97.
- outfitPreservationScore: clothing/shoes/jewelry/accessories unchanged. Pass >=97.
- backgroundPreservationScore: background/props/camera/crop/light/perspective unchanged. Pass >=95.
- posePreservationScore: body and limb pose unchanged. Pass >=97.
- headBodyProportionScore: head scale/placement is harmonious with an approximately ${params.targetHeadBodyRatio}-head-tall adult. Pass >=92. If crop prevents exact measurement, judge perspective-consistent head scale without penalizing the crop itself.
- anatomyScore: natural face/head/neck seam and anatomy. Pass >=90.

Set alteredOutsideHead=true if ANY meaningful change is visible below the base of the neck or in immutable scene regions, even if aesthetically attractive. This alone is a hard failure.
Set fullBodyVisible accurately. If full body is visible, estimatedHeadBodyRatio is the estimated number of head-heights in the full figure. If not measurable, return 0.
Issues must identify only observable failures and give a precise repairInstruction. Any body/outfit/pose/background alteration should be severity critical.
Do not reward beautification or scene improvement. The goal is minimal edit, target identity, correct head scale, and otherwise unchanged source.
Return strict JSON only.` });

  const response = await params.ai.models.generateContent({
    model: QA_MODEL,
    contents: [{ role: 'user', parts }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          identityScore: { type: Type.INTEGER },
          sourceIdentityResidualScore: { type: Type.INTEGER },
          headOnlyPreservationScore: { type: Type.INTEGER },
          bodyPreservationScore: { type: Type.INTEGER },
          outfitPreservationScore: { type: Type.INTEGER },
          backgroundPreservationScore: { type: Type.INTEGER },
          posePreservationScore: { type: Type.INTEGER },
          headBodyProportionScore: { type: Type.INTEGER },
          anatomyScore: { type: Type.INTEGER },
          fullBodyVisible: { type: Type.BOOLEAN },
          estimatedHeadBodyRatio: { type: Type.NUMBER },
          alteredOutsideHead: { type: Type.BOOLEAN },
          issues: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                code: { type: Type.STRING },
                severity: { type: Type.STRING },
                description: { type: Type.STRING },
                repairInstruction: { type: Type.STRING },
              },
              required: ['code', 'severity', 'description', 'repairInstruction'],
            },
          },
          summary: { type: Type.STRING },
        },
        required: [
          'identityScore', 'sourceIdentityResidualScore', 'headOnlyPreservationScore', 'bodyPreservationScore',
          'outfitPreservationScore', 'backgroundPreservationScore', 'posePreservationScore', 'headBodyProportionScore',
          'anatomyScore', 'fullBodyVisible', 'estimatedHeadBodyRatio', 'alteredOutsideHead', 'issues', 'summary',
        ],
      },
    },
  });
  const parsed = JSON.parse(response.text?.trim() || '{}');
  const report: HeadOnlyQaReport = {
    identityScore: Number(parsed.identityScore),
    sourceIdentityResidualScore: Number(parsed.sourceIdentityResidualScore),
    headOnlyPreservationScore: Number(parsed.headOnlyPreservationScore),
    bodyPreservationScore: Number(parsed.bodyPreservationScore),
    outfitPreservationScore: Number(parsed.outfitPreservationScore),
    backgroundPreservationScore: Number(parsed.backgroundPreservationScore),
    posePreservationScore: Number(parsed.posePreservationScore),
    headBodyProportionScore: Number(parsed.headBodyProportionScore),
    anatomyScore: Number(parsed.anatomyScore),
    fullBodyVisible: parsed.fullBodyVisible === true,
    estimatedHeadBodyRatio: parsed.fullBodyVisible === true && Number(parsed.estimatedHeadBodyRatio) > 0 ? Number(parsed.estimatedHeadBodyRatio) : null,
    alteredOutsideHead: parsed.alteredOutsideHead === true,
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    summary: String(parsed.summary || ''),
  };
  const numericFields = [
    report.identityScore, report.sourceIdentityResidualScore, report.headOnlyPreservationScore,
    report.bodyPreservationScore, report.outfitPreservationScore, report.backgroundPreservationScore,
    report.posePreservationScore, report.headBodyProportionScore, report.anatomyScore,
  ];
  if (numericFields.some((value) => !Number.isFinite(value))) throw new Error('HEAD_ONLY_QA_PARSE_FAILED');
  const gate = evaluateHeadOnlyQaGate(report);
  return { ...report, ...gate };
}

function repairFromQa(report: HeadOnlyQaReport & { failedChecks: string[] }): string {
  const issueInstructions = (report.issues || []).map((issue) => issue.repairInstruction).filter(Boolean);
  const immutableReminder = report.alteredOutsideHead
    ? 'Restore every pixel-semantic detail below the base of the neck and all background/pose/outfit regions to the ORIGINAL SOURCE IMAGE; do not reconstruct the body.'
    : '';
  return [...issueInstructions, immutableReminder, `Failed QA checks: ${(report.failedChecks || []).join(', ')}`].filter(Boolean).join(' ');
}

export function createHeadOnlyImageRouter() {
  const router = express.Router();

  router.post('/head-swap', upload.single('image'), async (req, res) => {
    let task: ImageTaskRecord | null = null;
    try {
      if (!OUTPUT_BUCKET) return res.status(503).json({ status: 'FAILED', error: { code: 'STORAGE_CONFIG_INVALID', stage: 'input', message: 'VEO_OUTPUT_BUCKET is missing.' } });
      const file = req.file;
      const characterId = String(req.body?.characterId || '').trim();
      const idempotencyKey = String(req.header('x-idempotency-key') || req.body?.idempotencyKey || '').trim();
      const targetHeadBodyRatio = Number(req.body?.targetHeadBodyRatio || DEFAULT_TARGET_HEAD_BODY_RATIO);
      if (!file || !isSupportedImage(file.buffer, file.mimetype)) return res.status(400).json({ status: 'FAILED', error: { code: 'INPUT_IMAGE_INVALID', stage: 'input', message: 'Exactly one valid JPG/PNG/WebP image is required.' } });
      if (!characterId) return res.status(400).json({ status: 'FAILED', error: { code: 'CHARACTER_ID_REQUIRED', stage: 'input', message: 'characterId is required.' } });
      if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) return res.status(400).json({ status: 'FAILED', error: { code: 'IDEMPOTENCY_KEY_INVALID', stage: 'input', message: 'A stable idempotency key of 16-200 characters is required.' } });
      if (targetHeadBodyRatio !== DEFAULT_TARGET_HEAD_BODY_RATIO) return res.status(400).json({ status: 'FAILED', error: { code: 'HEAD_BODY_RATIO_INVALID', stage: 'input', message: 'UAT currently requires targetHeadBodyRatio=9.' } });
      await validateSourceImage(file.buffer);

      const metadata = await durableCharacterService.getMetadata(characterId);
      if (!metadata || metadata.status !== 'ready') return res.status(404).json({ status: 'FAILED', error: { code: 'CHARACTER_NOT_READY', stage: 'character_resolve', message: 'Character package not found or not ready.' } });
      if (metadata.adultConfirmed !== true || metadata.rightsConfirmed !== true) return res.status(422).json({ status: 'FAILED', error: { code: 'CHARACTER_RIGHTS_NOT_CONFIRMED', stage: 'character_resolve', message: 'Character adult/rights confirmation is required.' } });

      const created = await createTaskIdempotently({ idempotencyKey, characterId, characterName: metadata.name, targetHeadBodyRatio });
      task = created.task;
      if (created.existing) return res.status(task.status === 'PROCESSING' ? 202 : 200).json({ ...publicTask(task), idempotentReuse: true });

      const inputPath = await persistInput(task.taskId, file.buffer, file.mimetype);
      task = await updateTask(task.taskId, { inputBucket: OUTPUT_BUCKET, inputObjectPath: inputPath, inputMimeType: file.mimetype });

      const hydrated = await durableCharacterService.getHydrated(characterId);
      if (!hydrated || hydrated.referenceImages.length === 0) throw new Error('CHARACTER_MASTERS_UNAVAILABLE');
      const masters = hydrated.referenceImages.slice(0, 4).map((ref) => ({ buffer: ref.buffer, mimeType: ref.mimeType, angle: ref.angle }));
      const ai = await getAiClient();

      let lastQa: (HeadOnlyQaReport & { pass: boolean; failedChecks: string[] }) | null = null;
      let firstQa: (HeadOnlyQaReport & { pass: boolean; failedChecks: string[] }) | null = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        task = await updateTask(task.taskId, { generatorAttempt: attempt, error: null });
        const candidate = await generateCandidate({
          ai,
          sourceBuffer: file.buffer,
          sourceMimeType: file.mimetype,
          characterName: hydrated.name,
          identityLockPromptEnglish: hydrated.identitySpec?.identityLockPromptEnglish,
          masters,
          targetHeadBodyRatio,
          repairInstruction: attempt === 2 && lastQa ? repairFromQa(lastQa) : undefined,
        });
        const qa = await runHeadOnlyQa({
          ai,
          sourceBuffer: file.buffer,
          sourceMimeType: file.mimetype,
          candidateBuffer: candidate.buffer,
          candidateMimeType: candidate.mimeType,
          masters,
          identitySpec: hydrated.identitySpec,
          targetHeadBodyRatio,
        });
        lastQa = qa;
        if (attempt === 1) firstQa = qa;
        task = await updateTask(task.taskId, { qaReport: qa, firstAttemptQaReport: firstQa });
        if (!qa.pass) continue;

        const artifact = await persistOutput(task.taskId, candidate.buffer, candidate.mimeType);
        task = await updateTask(task.taskId, {
          ...artifact,
          status: 'COMPLETED',
          artifactPersisted: true,
          artifactVerified: true,
          qaReport: qa,
          firstAttemptQaReport: firstQa,
          completedAt: now(),
          error: null,
        });
        return res.status(200).json(publicTask(task));
      }

      task = await updateTask(task.taskId, {
        status: 'QA_FAILED',
        artifactPersisted: false,
        artifactVerified: false,
        qaReport: lastQa,
        firstAttemptQaReport: firstQa,
        error: {
          code: 'HEAD_ONLY_QA_FAILED',
          stage: 'qa_image',
          message: `Head-only QA failed after one repair attempt: ${(lastQa?.failedChecks || []).join(', ')}`,
          retryable: false,
          recommendedAction: 'Do not expose the failed candidate. Use a clearer reference photo or review the failed QA checks before creating a new intent.',
        },
      });
      return res.status(200).json(publicTask(task));
    } catch (error: any) {
      const message = redactSecrets(error?.message || String(error));
      if (task?.taskId) {
        try {
          task = await updateTask(task.taskId, {
            status: 'FAILED',
            artifactPersisted: false,
            artifactVerified: false,
            error: { code: 'HEAD_ONLY_IMAGE_EXECUTION_FAILED', stage: 'internal', message, retryable: true, recommendedAction: 'Inspect the failure stage and retry with a new intent only after the cause is resolved.' },
          });
          return res.status(500).json(publicTask(task));
        } catch {}
      }
      return res.status(500).json({ status: 'FAILED', error: { code: 'HEAD_ONLY_IMAGE_EXECUTION_FAILED', stage: 'internal', message, retryable: true } });
    }
  });

  router.get('/:taskId', async (req, res) => {
    try {
      const task = await getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: 'task_not_found' });
      return res.status(task.status === 'PROCESSING' ? 202 : 200).json(publicTask(task));
    } catch (error: any) {
      return res.status(500).json({ error: { code: 'IMAGE_TASK_READ_FAILED', message: redactSecrets(error?.message || String(error)) } });
    }
  });

  router.get('/:taskId/stream', async (req, res) => {
    try {
      const task = await getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: 'task_not_found' });
      if (task.status !== 'COMPLETED' || task.qaReport?.pass !== true || !task.artifactPersisted || !task.artifactVerified || !task.outputBucket || !task.outputObjectPath) {
        return res.status(404).json({ error: 'qa_passed_artifact_not_available' });
      }
      const buffer = await exactDownload(task.outputBucket, task.outputObjectPath);
      if (!buffer.length) return res.status(404).json({ error: 'artifact_not_found' });
      const download = req.query.download === '1' || req.query.download === 'true';
      res.setHeader('Content-Type', task.outputMimeType || 'image/jpeg');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'private, max-age=300');
      if (download) res.setHeader('Content-Disposition', `attachment; filename="zaojing_${task.taskId}.${outputExtension(task.outputMimeType || 'image/jpeg')}"`);
      return res.send(buffer);
    } catch (error: any) {
      return res.status(500).json({ error: { code: 'IMAGE_STREAM_FAILED', message: redactSecrets(error?.message || String(error)) } });
    }
  });

  return router;
}
