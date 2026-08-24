import express from 'express';
import { Storage } from '@google-cloud/storage';
import { getFirestoreInstance } from './src/server/db/firestore';
import { isIdentitySafeCompletionSatisfied, type MvpVideoTask } from './src/mvp/mvpContract';

const TASK_COLLECTION = 'mvp_video_tasks';
const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600;
const MIN_SIGNED_URL_TTL_SECONDS = 300;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;

function signedUrlTtlSeconds(): number {
  const configured = Number(process.env.ZAOJING_VIDEO_SIGNED_URL_TTL_SECONDS || DEFAULT_SIGNED_URL_TTL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_SIGNED_URL_TTL_SECONDS;
  return Math.max(MIN_SIGNED_URL_TTL_SECONDS, Math.min(MAX_SIGNED_URL_TTL_SECONDS, Math.floor(configured)));
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

export function createChatGptVideoArtifactRouter() {
  const router = express.Router();
  const storage = new Storage();

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
      const common = {
        version: 'v4' as const,
        action: 'read' as const,
        expires: expiresAtMs,
        responseType: contentType,
      };
      const [videoUrl] = await file.getSignedUrl(common);
      const [downloadUrl] = await file.getSignedUrl({
        ...common,
        responseDisposition: `attachment; filename="${safeDownloadName(taskId)}"`,
      });

      return res.status(200).json({
        ok: true,
        taskId,
        status: task.status,
        videoReady: true,
        videoUrl,
        downloadUrl,
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
        error: 'signed_url_generation_failed',
        retryable: true,
        detail: String(error?.message || error),
      }));
    }
  });

  return router;
}
