import express from 'express';
import crypto from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { getFirestoreInstance } from './src/server/db/firestore';
import { isIdentitySafeCompletionSatisfied, type MvpVideoTask } from './src/mvp/mvpContract';

const TASK_COLLECTION = 'mvp_video_tasks';
const ACCESS_TOKEN_COLLECTION = 'mvp_chatgpt_video_artifact_access';
const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600;
const MIN_SIGNED_URL_TTL_SECONDS = 300;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;

function signedUrlTtlSeconds(): number {
  const configured = Number(process.env.ZAOJING_VIDEO_SIGNED_URL_TTL_SECONDS || DEFAULT_SIGNED_URL_TTL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_SIGNED_URL_TTL_SECONDS;
  return Math.max(MIN_SIGNED_URL_TTL_SECONDS, Math.min(MAX_SIGNED_URL_TTL_SECONDS, Math.floor(configured)));
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

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

function parseSingleRange(raw: string | undefined, sizeBytes: number): { start: number; end: number } | null {
  if (!raw) return null;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(raw.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : sizeBytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= sizeBytes || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, sizeBytes - 1) };
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
