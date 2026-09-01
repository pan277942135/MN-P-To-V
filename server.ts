Warning: truncated output (original token count: 42758)
Total output lines: 4035

import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import { CredentialService } from './src/services/google/credentialService';
import { VertexClient } from './src/services/google/vertexClient';
import { IdentityBuilder } from './src/services/character/identityBuilder';
import { IdentityLockService } from './src/services/character/identityLockService';
import { SceneAnalyzer } from './src/services/scene/sceneAnalyzer';
import { FirstFrameGenerator } from './src/services/image/firstFrameGenerator';
import { VisualQaService } from './src/services/qa/visualQaService';
import { VideoGenerator } from './src/services/video/videoGenerator';
import { VideoInspector } from './src/services/video/videoInspector';
import { DurableVideoIdentityQaService } from './src/server/services/durableVideoIdentityQaService';
import { VideoFailureDiagnosisService } from './src/services/qa/videoFailureDiagnosisService';
import { VideoRetryPolicyService } from './src/services/qa/videoRetryPolicyService';
import { DurableVideoRetryService } from './src/server/services/durableVideoRetryService';
import { GeminiClientFactory } from './src/services/google/geminiClient';
import { ModelRouter } from './src/services/google/modelRouter';
import { PromptCompiler } from './src/services/prompt/PromptCompiler';
import { FirstFrameChecker } from './src/services/image/firstFrameCheck';
import { redactSecrets, sanitizeError, createStructuredError } from './src/utils/redactSecrets';
import { callWithRetry } from './src/utils/retryHelper';
import type { IdentitySpec, ServerVideoTaskRecord, TaskStatus, AuditTaskStatus, TaskSubmissionState } from './src/types';
import { firestoreTaskRepository } from './src/server/repositories/firestoreTaskRepository';
import { durableCharacterService } from './src/server/services/durableCharacterService';
import { taskStateMachineService, InvalidStateTransitionError } from './src/server/services/taskStateMachineService';
import { isProviderTaskDeletionSafe } from './src/server/services/providerAdmissionPolicy';
import { evaluateProviderOperationLinkage } from './src/server/services/providerOperationRecoveryPolicy';
import { getStorageAuthority } from './src/server/db/firestore';
import {
  createDefaultS01ProductionService,
  type S01ProductionServiceLike,
} from './src/server/services/s01ProductionService';
import { gcsArtifactStore, resolveVeoOutputBucket, resolveVeoStorageUri, getVeoBucketName, getVeoStorageUri, assertProductionStorageConfig, EXPECTED_PRODUCTION_VEO_BUCKET } from './src/server/storage/gcsArtifactStore';

// Server Video Task Store & Ephemeral In-Memory Cache
export const ephemeralImageStore = new Map<string, { buffer: Buffer; mimeType: string }>();
export const ephemeralVideoStore = new Map<string, Buffer>();

function saveImageBufferToFile(taskId: string, buffer: Buffer, mimeType = 'image/jpeg'): string {
  ephemeralImageStore.set(taskId, { buffer, mimeType });
  return `/api/videos/image/${taskId}`;
}

function saveVideoBufferToFile(taskId: string, buffer: Buffer): { videoUrl: string; sizeBytes: number } {
  ephemeralVideoStore.set(taskId, buffer);
  const rec = serverVideoTaskStore.get(taskId);
  if (rec) {
    rec.sizeBytes = buffer.length;
    rec.videoDataUrl = `/api/videos/stream/${taskId}`;
  }
  return {
    videoUrl: `/api/videos/stream/${taskId}`,
    sizeBytes: buffer.length,
  };
}

function saveTasksToDisk(_map?: Map<string, ServerVideoTaskRecord>) {
  // No-op: Local filesystem persistence is disabled in production. Firestore is sole metadata authority.
}

function getStatusRank(status: string): number {
  switch (status) {
    case 'submitting': return 1;
    case 'submitted': return 2;
    case 'polling':
    case 'processing': return 3;
    case 'polling_timeout': return 3.5;
    case 'completed':
    case 'failed': return 5;
    default: return 0;
  }
}

async function safeUpdateTaskRecord(taskId: string, updates: Partial<ServerVideoTaskRecord>): Promise<ServerVideoTaskRecord> {
  if (!firestoreTaskRepository.isAvailable()) {
    throw new Error(`[safeUpdateTaskRecord] Firestore is unavailable. Cannot update task ${taskId}.`);
  }

  const currentRecord = await firestoreTaskRepository.getTask(taskId);
  if (!currentRecord) {
    throw new Error(`[safeUpdateTaskRecord] Task ${taskId} does not exist in Firestore.`);
  }

  if (updates.status && updates.status !== currentRecord.status) {
    try {
      const updated = await taskStateMachineService.transitionTask({
        taskId,
        toStatus: updates.status,
        expectedStateVersion: updates.stateVersion,
        executionId: updates.executionId,
        patch: updates,
      });
      serverVideoTaskStore.set(taskId, updated);
      return updated;
    } catch (err: any) {
      if (err instanceof InvalidStateTransitionError) {
        console.error(`[Task State Machine] Illegal production transition for Task ${taskId}: ${err.message}`);
      }
      throw err;
    }
  }

  const currentVer = currentRecord.stateVersion ?? currentRecord.statusVersion ?? 1;
  const nextUpdates: Partial<ServerVideoTaskRecord> = {
    ...updates,
    stateVersion: currentVer + 1,
    statusVersion: currentVer + 1,
    updatedAt: Date.now(),
    evidenceSource: 'firestore',
  };

  const updatedRecord = await firestoreTaskRepository.updateTask(taskId, nextUpdates);
  if (!updatedRecord) {
    throw new Error(`[safeUpdateTaskRecord] Firestore updateTask failed for task ${taskId}.`);
  }

  serverVideoTaskStore.set(taskId, updatedRecord);
  return updatedRecord;
}

export const serverVideoTaskStore = new Map<string, ServerVideoTaskRecord>();


async function settlePersistedVideoThroughQa(params: {
  taskId: string;
  videoBuffer: Buffer;
  artifactMeta: {
    outputBucket: string;
    outputObjectPath: string;
    videoUri: string;
    sizeBytes: number;
    contentType: string;
    artifactPersistedAt: number;
  };
  session: any;
  ai: any;
  analysisModel: string;
  patch?: Partial<ServerVideoTaskRecord>;
}): Promise<ServerVideoTaskRecord> {
  const { taskId, videoBuffer, artifactMeta, session, ai, analysisModel, patch = {} } = params;

  const qaPendingTask = await taskStateMachineService.persistArtifactForQa({
    taskId,
    outputBucket: artifactMeta.outputBucket,
    outputObjectPath: artifactMeta.outputObjectPath,
    videoUri: artifactMeta.videoUri,
    sizeBytes: artifactMeta.sizeBytes,
    contentType: artifactMeta.contentType,
    artifactPersistedAt: artifactMeta.artifactPersistedAt,
    patch: {
      ...patch,
      identityQaStatus: 'not_run',
    },
  });

  let qaReport;
  try {
    qaReport = await DurableVideoIdentityQaService.run({
      task: qaPendingTask,
      videoBuffer,
      ai,
      analysisModel,
      session,
    });
  } catch (qaErr: any) {
    const currentQaAttempt = qaPendingTask.qaAttempt || 1;
    const canReQa = currentQaAttempt < 2;
    const retryHistoryForQaError = [...(qaPendingTask.retryHistory || [])];
    if ((qaPendingTask.providerAttempt || 1) > 1) {
      for (let i = retryHistoryForQaError.length - 1; i >= 0; i--) {
        if (retryHistoryForQaError[i].providerAttempt === (qaPendingTask.providerAttempt || 1)) {
          retryHistoryForQaError[i] = {
            ...retryHistoryForQaError[i],
            state: canReQa ? 'qa_retry' : 'manual_review',
          };
          break;
        }
      }
    }
    const qaError = {
      code: 'VIDEO_IDENTITY_QA_EXECUTION_FAILED',
      message: qaErr?.message || String(qaErr),
      stage: 'qa_video',
      retryable: canReQa,
      timestamp: Date.now(),
    };
    return await taskStateMachineService.transitionTask({
      taskId,
      toStatus: 'qa_pending',
      patch: {
        structuredError: qaError,
        error: qaError.message,
        identityQaStatus: canReQa ? 'not_run' : 'review',
        qaAttempt: canReQa ? currentQaAttempt + 1 : currentQaAttempt,
        retryHistory: retryHistoryForQaError,
        automaticRetryPlan: {
          version: 'm2-4-v1',
          action: canReQa ? 'REQA_SAME_ARTIFACT' : 'MANUAL_REVIEW',
          reasonCode: canReQa ? 'QA_EXECUTION_FAILED_REQA' : 'QA_EXECUTION_RETRY_EXHAUSTED',
          automatic: canReQa,
          consumesProviderAttempt: false,
          nextProviderAttempt: qaPendingTask.providerAttempt || 1,
          nextQaAttempt: canReQa ? currentQaAttempt + 1 : currentQaAttempt,
          preserveCurrentArtifact: true,
          requiresHumanReview: !canReQa,
        },
      },
    });
  }

  const failureDiagnosis = VideoFailureDiagnosisService.diagnose(qaReport);
  const retryDecision = VideoRetryPolicyService.decide({
    taskId,
    qaReport,
    diagnosis: failureDiagnosis,
    providerAttempt: qaPendingTask.providerAttempt || 1,
    qaAttempt: qaPendingTask.qaAttempt || 1,
    artifactObjectPath: artifactMeta.outputObjectPath,
  });
  const diagnosedQaReport = failureDiagnosis
    ? { ...qaReport, failureDiagnosis, retryDecision }
    : { ...qaReport, retryDecision };

  const retryHistoryForOutcome = [...(qaPendingTask.retryHistory || [])];
  if ((qaPendingTask.providerAttempt || 1) > 1) {
    const retryOutcomeState =
      qaReport.gateStatus === 'pass'
        ? 'completed'
        : retryDecision.action === 'REQA_SAME_ARTIFACT'
          ? 'qa_retry'
          : (qaReport.gateStatus === 'review' || retryDecision.action === 'MANUAL_REVIEW')
            ? 'manual_review'
            : 'failed';
    for (let i = retryHistoryForOutcome.length - 1; i >= 0; i--) {
      if (retryHistoryForOutcome[i].providerAttempt === (qaPendingTask.providerAttempt || 1)) {
        retryHistoryForOutcome[i] = {
          ...retryHistoryForOutcome[i],
          state: retryOutcomeState,
        };
        break;
      }
    }
  }

  if (qaReport.gateStatus === 'pass') {
    return await taskStateMachineService.completeAfterQa({
      taskId,
      qaReport: diagnosedQaReport,
      patch: {
        ...patch,
        retryHistory: retryHistoryForOutcome,
      },
    });
  }

  const commonQaPatch: Partial<ServerVideoTaskRecord> = {
    ...patch,
    retryHistory: retryHistoryForOutcome,
    qaReport: diagnosedQaReport,
    identityQaReport: diagnosedQaReport,
    identityQaStatus: qaReport.gateStatus,
    identityFrameScores: qaReport.frameReports.map((frame) => frame.identityScore),
    identityDriftDetected: qaReport.identityDriftDetected,
    worstFrameTimestamp: qaReport.worstFrameTimestamp,
  };

  if (retryDecision.action === 'MANUAL_REVIEW' || qaReport.gateStatus === 'review') {
    return await taskStateMachineService.transitionTask({
      taskId,
      toStatus: 'qa_pending',
      patch: {
        ...commonQaPatch,
        automaticRetryPlan: retryDecision,
      },
    });
  }

  if (retryDecision.action === 'REQA_SAME_ARTIFACT') {
    return await taskStateMachineService.transitionTask({
      taskId,
      toStatus: 'qa_pending',
      patch: {
        ...commonQaPatch,
        identityQaStatus: 'not_run',
        qaAttempt: retryDecision.nextQaAttempt,
        automaticRetryPlan: retryDecision,
      },
    });
  }

  if (retryDecision.action === 'REGENERATE_VIDEO' && retryDecision.idempotencyKey) {
    const retryProviderStorageTaskKey = DurableVideoRetryService.getAttemptTaskKey(
      taskId,
      retryDecision.nextProviderAttempt
    );
    const retryExpectedProviderStorageUri = resolveVeoStorageUri(retryProviderStorageTaskKey);
    const reservation = await taskStateMachineService.reserveAutomaticProviderRetry({
      taskId,
      decision: retryDecision,
      diagnosisCode: failureDiagnosis?.primaryCode,
      providerStorageTaskKey: retryProviderStorageTaskKey,
      expectedProviderStorageUri: retryExpectedProviderStorageUri,
    });
    if (!reservation.reserved) return reservation.task;

    let preparedRetry;
    try {
      preparedRetry = await DurableVideoRetryService.prepare({
        task: reservation.task,
        decision: retryDecision,
        session,
      });
    } catch (preparationErr: any) {
      const message = `自动重试 Provider 输入准备失败，Veo 尚未进入调用窗口: ${preparationErr?.message || preparationErr}`;
      return await taskStateMachineService.failAutomaticRetryBeforeProvider({
        taskId,
        idempotencyKey: retryDecision.idempotencyKey,
        message,
      });
    }

    let authorizedRetryTask: ServerVideoTaskRecord;
    try {
      authorizedRetryTask = await taskStateMachineService.authorizeAutomaticProviderRetry({
        taskId,
        idempotencyKey: retryDecision.idempotencyKey,
      });
    } catch (authorizationErr: any) {
      const message = `自动重试 Provider 调用授权失败，Veo 尚未进入调用窗口: ${authorizationErr?.message || authorizationErr}`;
      return await taskStateMachineService.failAutomaticRetryBeforeProvider({
        taskId,
        idempotencyKey: retryDecision.idempotencyKey,
        message,
      });
    }

    try {
      const retryStart = await DurableVideoRetryService.launch({
        task: authorizedRetryTask,
        decision: retryDecision,
        session,
        ai,
        prepared: preparedRetry,
      });

      if (retryStart.operationName) {
        return await taskStateMachineService.markAutomaticRetrySubmitted({
          taskId,
          idempotencyKey: retryDecision.idempotencyKey,
          operationName: retryStart.operationName,
          diagnostics: retryStart.diagnostics,
        });
      }

      if (retryStart.videoBuffer) {
        const attemptTaskKey = DurableVideoRetryService.getAttemptTaskKey(
          taskId,
          retryDecision.nextProviderAttempt
        );
        const retryArtifactMeta = await gcsArtifactStore.uploadVideoArtifact({
          taskId: attemptTaskKey,
          videoBuffer: retryStart.videoBuffer,
          contentType: 'video/mp4',
        });
        return await settlePersistedVideoThroughQa({
          taskId,
          videoBuffer: retryStart.videoBuffer,
          artifactMeta: retryArtifactMeta,
          session,
          ai,
          analysisModel,
          patch: {
            diagnostics: retryStart.diagnostics,
            providerAttempt: retryDecision.nextProviderAttempt,
            retrySubmissionState: 'submitted',
          },
        });
      }

      return await taskStateMachineService.markAutomaticRetryOutcomeUnknown({
        taskId,
        idempotencyKey: retryDecision.idempotencyKey,
        message: 'Automatic provider retry returned neither operationName nor videoBuffer.',
      });
    } catch (retryErr: any) {
      return await taskStateMachineService.markAutomaticRetryOutcomeUnknown({
        taskId,
        idempotencyKey: retryDecision.idempotencyKey,
        message: `Automatic provider retry submission outcome is unknown: ${retryErr?.message || retryErr}`,
      });
    }
  }

  return await taskStateMachineService.transitionTask({
    taskId,
    toStatus: 'failed',
    patch: {
      ...commonQaPatch,
      automaticRetryPlan: retryDecision,
      failureReason: 'artifact_invalid',
      retryMode: failureDiagnosis?.retryRecommended === false ? 'NO_RETRY' : 'SAFE_TO_REGENERATE',
      error: `视频身份一致性质检失败 [${failureDiagnosis?.primaryCode || 'UNKNOWN_VIDEO_QA_FAILURE'}]: ${qaReport.summary}`,
      structuredError: {
        code: `VIDEO_IDENTITY_QA_${failureDiagnosis?.primaryCode || 'UNKNOWN_VIDEO_QA_FAILURE'}`,
        message: qaReport.summary,
        stage: 'qa_video',
        retryable: true,
        timestamp: Date.now(),
        details: {
          minimumIdentityScore: qaReport.minimumIdentityScore,
          worstFrameTimestamp: qaReport.worstFrameTimestamp,
          failureDiagnosis,
        },
      },
    },
  });
}

export async function createApp(dependencies: { s01ProductionService?: S01ProductionServiceLike } = {}) {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  const upload = multer({
    limits: { fileSize: 50 * 1024 * 1024, files: 10 },
  });

  const s01ProductionService =
    dependencies.s01ProductionService || createDefaultS01ProductionService();

  // EP001 S01 production entrypoint. The service owns the keyframe gate, durable
  // Shot state transitions, runner idempotency and final artifact write-back.
  app.post('/api/episodes/:episodeId/shots/:shotId/run', async (req, res) => {
    const episodeId = String(req.params.episodeId || '').trim();
    const shotId = String(req.params.shotId || '').trim();
    const rawHeaderKey = req.headers['x-idempotency-key'];
    const headerKey = Array.isArray(rawHeaderKey) ? rawHeaderKey[0] : rawHeaderKey;
    const idempotencyKey = String(headerKey || req.body?.idempotencyKey || '').trim();
    const openaiFileRef = req.body?.openaiFileRef ?? req.body?.openaiFileIdRef;
    const projectId = String(req.body?.projectId || '').trim();

    if (!openaiFileRef) {
      return res.status(400).json({
        ok: false,
        error: 'OPENAI_FILE_REF_REQUIRED',
        episodeId,
        shotId,
      });
    }
    if (!idempotencyKey) {
      return res.status(400).json({
        ok: false,
        error: 'IDEMPOTENCY_KEY_REQUIRED',
        episodeId,
        shotId,
      });
    }

    try {
      const result = await s01ProductionService.run({
        ...(projectId ? { projectId } : {}),
        episodeId,
        shotId,
        openaiFileRef,
        idempotencyKey,
        prompt: typeof req.body?.prompt === 'string' ? req.body.prompt : undefined,
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (err: any) {
      const statusCode = Number(err?.statusCode);
      const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 502;
      const errorCode =
        typeof err?.code === 'string' && err.code.trim()
          ? err.code.trim()
          : String(err?.message || 'S01_PRODUCTION_FAILED').split(':')[0];
      const { redactedMessage } = sanitizeError(err);
      return res.status(status).json({
        ok: false,
        error: errorCode,
        message: redactedMessage || 'S01 生产请求失败。',
        episodeId,
        shotId,
      });
    }
  });

  // Health Check
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      hasServerSecret: CredentialService.hasServerEnvironmentSecret(),
    });
  });

  // Environment & System Info Endpoint
  app.get('/api/system/environment', (_req, res) => {
    const kService = process.env.K_SERVICE || '';
    const isPreview = !kService || kService.startsWith('ais-dev-');
    const isCloudRun = !isPreview;
    const environment = isPreview ? 'ai_studio_preview' : 'cloud_run';
    const actualPrincipalEmail = isCloudRun
      ? 'zaojing-video-runtime@xp-vertex-project.iam.gserviceaccount.com'
      : 'adc-runtime-account@cloud.google';

    const veoBucket = resolveVeoOutputBucket();

    res.json({
      environment,
      isCloudRun,
      actualPrincipalEmail,
      K_SERVICE: process.env.K_SERVICE || null,
      K_REVISION: process.env.K_REVISION || null,
      K_CONFIGURATION: process.env.K_CONFIGURATION || null,
      VEO_OUTPUT_BUCKET: veoBucket || null,
      gcsEnabled: Boolean(veoBucket),
      resolvedStorageUriPrefix: veoBucket ? `gs://${veoBucket}/veo/` : null,
      buildVersion: '9.0.0-v9.0-cinema',
      buildTimestamp: '2026-08-05T19:00:00Z',
      commitHash: 'v2.0-cinema-release',
      schemaVersion: 'v2.0-stable',
    });
  });

  // Connection Status
  app.get('/api/connections/status', (req, res) => {
    const connectionId = req.headers['x-connection-id'] as string;
    const session = connectionId ? CredentialService.getSession(connectionId) : undefined;

    res.json({
      hasServerSecret: CredentialService.hasServerEnvironmentSecret(),
      isConnected: Boolean(session),
      sessionInfo: session
        ? {
            connectionId: session.connectionId,
            type: session.type,
            credentialSource: session.credentialSource,
            projectId: session.projectId,
            location: session.location,
            region: session.region || session.location,
            requestedModel: session.requestedModel,
            actualModel: session.actualModel,
            analysisModel: session.analysisModel,
            imageModel: session.imageModel,
            videoModel: session.videoModel,
            serviceAccountEmail: session.serviceAccountEmail,
            hasServerSecret: CredentialService.hasServerEnvironmentSecret(),
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
          }
        : null,
    });
  });

  // Test & Connect
  app.post('/api/connections/test', async (req, res) => {
    try {
      const { type } = req.body;
      if (type === 'gemini_api_key') {
        const info = await CredentialService.connectWithApiKey(req.body);
        return res.json({ success: true, info });
      }
      if (type === 'vertex_ai') {
        const info = await CredentialService.connectWithServiceAccount(req.body);
        return res.json({ success: true, info });
      }
      if (type === 'server_env_secret') {
        const info = await CredentialService.connectWithServerSecret(req.body);
        return res.json({ success: true, info });
      }
      return res.status(400).json({ error: '未知的连接类型' });
    } catch (err: unknown) {
      const { redactedMessage } = sanitizeError(err);
      return res.status(400).json({ error: redactedMessage });
    }
  });

  // Zero-Cost Pre-Flight Routing Test Route ({ "instances": [] })
  app.post('/api/connections/routing-test', async (req, res) => {
    try {
      const info = await CredentialService.connectWithServiceAccount(req.body);
      const session = CredentialService.getSession(info.connectionId);
      if (!session) {
        return res.status(400).json({ error: '无法建立凭据会话' });
      }
      const accessToken = await VertexClient.getAccessToken(session);
      const testResult = await VertexClient.testRouting(
        accessToken,
        session.projectId || 'xp-vertex-project',
        session.region || session.location || 'us-central1',
        session.actualModel || 'veo-3.1-fast-generate-001',
        session.serviceAccountEmail || 'adc-runtime-account@cloud.google'
      );
      return res.json({ success: true, testResult, info });
    } catch (err: unknown) {
      const { redactedMessage } = sanitizeError(err);
      return res.status(400).json({ error: redactedMessage });
    }
  });

  // Disconnect
  app.delete('/api/connections/:connectionId', (req, res) => {
    const { connectionId } = req.params;
    const deleted = CredentialService.deleteSession(connectionId);
    res.json({ success: deleted });
  });

  // Server Character Store
  interface ServerCharacter {
    id: string;
    name: string;
    description: string;
    identitySpec: IdentitySpec;
    referenceImages: Array<{
      id: string;
      buffer: Buffer;
      mimeType: string;
      width: number;
      height: number;
      angle?: string;
    }>;
    updatedAt: string;
  }

  const CHARACTERS_FILE_PATH = path.join(process.cwd(), 'data', 'characters.json');

  function loadCharactersFromDisk(): Map<string, ServerCharacter> {
    const map = new Map<string, ServerCharacter>();
    try {
      if (fs.existsSync(CHARACTERS_FILE_PATH)) {
        const content = fs.readFileSync(CHARACTERS_FILE_PATH, 'utf-8');
        const list: any[] = JSON.parse(content);
        for (const item of list) {
          if (item.id) {
            const refImages = (item.referenceImages || []).map((img: any) => ({
              id: img.id,
              buffer: Buffer.isBuffer(img.buffer)
                ? img.buffer
                : typeof img.buffer === 'string'
                ? Buffer.from(img.buffer, 'base64')
                : Buffer.from(img.base64Data || '', 'base64'),
              mimeType: img.mimeType || 'image/jpeg',
              width: img.width || 1080,
              height: img.height || 1080,
              angle: img.angle || 'front',
            }));
            map.set(item.id, {
              id: item.id,
              name: item.name || '未命名角色',
              description: item.description || '',
              identitySpec: item.identitySpec || { lockedTraits: [] },
              referenceImages: refImages,
              updatedAt: item.updatedAt || new Date().toISOString(),
            });
          }
        }
      }
    } catch (err) {
      console.warn('[Disk Store] Warning: Could not load characters from disk:', err);
    }
    return map;
  }

  function saveCharactersToDisk(map: Map<string, ServerCharacter>) {
    try {
      const dir = path.dirname(CHARACTERS_FILE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const list = Array.from(map.values()).map((char) => ({
        id: char.id,
        name: char.name,
        description: char.description,
        identitySpec: char.identitySpec,
        referenceImages: char.referenceImages.map((img) => ({
          id: img.id,
          buffer: img.buffer.toString('base64'),
          mimeType: img.mimeType,
          width: img.width,
          height: img.height,
          angle: img.angle,
        })),
        updatedAt: char.updatedAt,
      }));
      fs.writeFileSync(CHARACTERS_FILE_PATH, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[Disk Store] Warning: Could not save characters to disk:', err);
    }
  }

  const serverCharacterStore = new Map<string, ServerCharacter>();

  // Durable Character Library: Firestore metadata + GCS master-image authority.
  app.get('/api/characters/list', async (_req, res) => {
    try {
      if (!durableCharacterService.isAvailable()) {
        return res.status(503).json({ characters: [], storageAuthority: 'unavailable', error: '角色云端存储不可用' });
      }
      const records = await durableCharacterService.listMetadata();
      const characters = records.map((record) => ({
        id: record.id,
        name: record.name,
        description: record.description,
        identitySpec: record.identitySpec,
        status: 'ready' as const,
        adultConfirmed: record.adultConfirmed,
        rightsConfirmed: record.rightsConfirmed,
        referenceImages: [...(record.referenceImages || [])]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((ref) => ({
            id: ref.id,
            url: '/api/characters/' + encodeURIComponent(record.id) + '/reference/' + encodeURIComponent(ref.id),
            width: ref.width || 1080,
            height: ref.height || 1080,
            angle: ref.angle || 'other',
            mimeType: ref.mimeType || 'image/jpeg',
          })),
        createdAt: new Date(record.createdAt).toISOString(),
        updatedAt: new Date(record.updatedAt).toISOString(),
        evidenceSource: 'firestore',
      }));
      return res.json({ characters, storageAuthority: 'firestore', artifactAuthority: 'gcs' });
    } catch (err: any) {
      console.error('[Durable Character List Error]:', err);
      return res.status(503).json({ characters: [], storageAuthority: 'firestore', error: err?.message || '读取角色库失败' });
    }
  });

  app.get('/api/characters/:id/reference/:referenceId', async (req, res) => {
    try {
      if (!durableCharacterService.isAvailable()) {
        return res.status(503).json({ error: '角色云端存储不可用', storageAuthority: 'unavailable' });
      }
      const artifact = await durableCharacterService.getReferenceBuffer(req.params.id, req.params.referenceId);
      if (!artifact) return res.status(404).json({ error: '角色母板不存在', storageAuthority: 'firestore' });
      res.setHeader('Content-Type', artifact.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.send(artifact.buffer);
    } catch (err: any) {
      return res.status(503).json({ error: err?.message || '读取角色母板失败', storageAuthority: 'gcs' });
    }
  });

  // Store character profile endpoint
  app.post('/api/characters/store', upload.array('masterPhotos', 8), async (req, res) => {
    try {
      if (!durableCharacterService.isAvailable()) {
        return res.status(503).json({ success: false, storageAuthority: 'unavailable', error: '角色云端存储不可用' });
      }
      const id = req.body.id || ('char_' + crypto.randomUUID().slice(0, 8));
      const name = req.body.name || '未命名角色';
      const description = req.body.description || '';
      const identitySpec = req.body.identitySpec ? JSON.parse(req.body.identitySpec) : { lockedTraits: [] };
      const files = (req.files as Express.Multer.File[]) || [];
      const images = files.map((file, index) => ({
        buffer: file.buffer,
        mimeType: file.mimetype || 'image/jpeg',
        width: 1080,
        height: 1080,
        angle: index === 0 ? 'front' : 'other',
      }));

      const record = await durableCharacterService.save({
        id, name, description, identitySpec,
        images: images.length ? images : undefined,
        adultConfirmed: req.body.adultConfirmed !== 'false',
        rightsConfirmed: req.body.rightsConfirmed !== 'false',
      });
      const hydrated = await durableCharacterService.hydrate(record);
      serverCharacterStore.set(id, hydrated);
      return res.json({
        success: true,
        storageAuthority: 'firestore',
        artifactAuthority: 'gcs',
        character: { ...record, referenceImages: record.referenceImages.length },
      });
    } catch (err: any) {
      console.error('[Durable Character Store Error]:', err);
      return res.status(503).json({ success: false, storageAuthority: 'firestore', error: err?.message || '角色云端持久化失败' });
    }
  });

  // Delete character endpoint
  app.delete('/api/characters/:id', async (req, res) => {
    try {
      if (!durableCharacterService.isAvailable()) {
        return res.status(503).json({ success: false, storageAuthority: 'unavailable', error: '角色云端存储不可用' });
      }
      const deleted = await durableCharacterService.delete(req.params.id);
      serverCharacterStore.delete(req.params.id);
      return res.json({ success: deleted, storageAuthority: 'firestore', artifactAuthority: 'gcs' });
    } catch (err: any) {
      return res.status(503).json({ success: false, storageAuthority: 'firestore', error: err?.message || '删除角色失败' });
    }
  });

  // Get character profile endpoint
  app.get('/api/characters/:id', async (req, res) => {
    try {
      if (!durableCharacterService.isAvailable()) {
        return res.status(503).json({ error: '角色云端存储不可用', storageAuthority: 'unavailable' });
      }
      const record = await durableCharacterService.getMetadata(req.params.id);
      if (!record) {
        const errObj = createStructuredError({
          source: 'character_api', failureStage: 'internal_api', httpStatus: 404,
          customUserMessage: '角色资料不存在或已被删除。',
          endpointPathRedacted: '/api/characters/' + req.params.id,
        });
        return res.status(404).json(errObj);
      }
      return res.json({
        id: record.id, name: record.name, description: record.description, identitySpec: record.identitySpec,
        adultConfirmed: record.adultConfirmed, rightsConfirmed: record.rightsConfirmed, status: record.status,
        referenceImages: [...(record.referenceImages || [])].sort((a, b) => a.sortOrder - b.sortOrder).map((ref) => ({
          id: ref.id,
          url: '/api/characters/' + encodeURIComponent(record.id) + '/reference/' + encodeURIComponent(ref.id),
          width: ref.width || 1080, height: ref.height || 1080, angle: ref.angle || 'other', mimeType: ref.mimeType || 'image/jpeg',
        })),
        createdAt: new Date(record.createdAt).toISOString(), updatedAt: new Date(record.updatedAt).toISOString(),
        evidenceSource: 'firestore',
      });
    } catch (err: any) {
      return res.status(503).json({ error: err?.message || '读取角色资料失败', storageAuthority: 'firestore' });
    }
  });

  // Update character profile description and re-analyze identitySpec
  app.put('/api/characters/:id', upload.array('masterPhotos', 8), async (req, res) => {
    try {
      const connectionId = req.headers['x-connection-id'] as string;
      const session = CredentialService.getSession(connectionId);
      const { id } = req.params;
      const name = req.body.name;
      const description = req.body.description;

      let char = serverCharacterStore.get(id);
      if (!char && durableCharacterService.isAvailable()) {
        const durableChar = await durableCharacterService.getHydrated(id);
        if (durableChar) { char = durableChar; serverCharacterStore.set(id, durableChar); }
      }

      const files = (req.files as Express.Multer.File[]) || [];
      const imagesInput = files.map((f) => ({
        buffer: f.buffer,
        mimeType: f.mimetype || 'image/jpeg',
      }));

      if (session && description) {
        const ai = await GeminiClientFactory.getClientForSession(session);
        const models = ModelRouter.getEffectiveModels(session);
        // Use existing images if none provided in PUT request
        const inputImages = imagesInput.length > 0 ? imagesInput : (char?.referenceImages.map((r) => ({ buffer: r.buffer, mimeType: r.mimeType })) || []);
        if (inputImages.length >= 1) {
          const result = await IdentityBuilder.analyzeCharacterProfile(
            ai,
            name || char?.name || '未命名角色',
            description,
            true,
            true,
            inputImages,
            models.analysisModel
          );

          if (result.status === 'ready') {
            const newChar: ServerCharacter = {
              id,
              name: name || char?.name || '未命名角色',
              description,
              identitySpec: result.identitySpec,
              referenceImages: imagesInput.length > 0 ? imagesInput.map((f, i) => ({
                id: `ref_${i}`,
                buffer: f.buffer,
                mimeType: f.mimeType,
                width: 1080,
                height: 1080,
              })) : (char?.referenceImages || []),
              updatedAt: new Date().toISOString(),
            };
            const durableRecord = await durableCharacterService.save({
              id, name: newChar.name, description: newChar.description, identitySpec: newChar.identitySpec,
              images: imagesInput.length > 0 ? imagesInput : undefined, adultConfirmed: true, rightsConfirmed: true,
            });
            const hydrated = await durableCharacterService.hydrate(durableRecord);
            serverCharacterStore.set(id, hydrated);
            return res.json({ success: true, storageAuthority: 'firestore', character: { ...durableRecord, referenceImages: durableRecord.referenceImages.length } });
          }
        }
      }

      if (char) {
        if (name) char.name = name;
        if (description) char.description = description;
        char.updatedAt = new Date().toISOString();
        const durableRecord = await durableCharacterService.save({
          id, name: char.name, description: char.description, identitySpec: char.identitySpec, adultConfirmed: true, rightsConfirmed: true,
        });
        const hydrated = await durableCharacterService.hydrate(durableRecord);
        serverCharacterStore.set(id, hydrated);
        return res.json({ success: true, storageAuthority: 'firestore', character: { ...durableRecord, referenceImages: durableRecord.referenceImages.length } });
      }

      return res.status(404).json({ error: '角色不存在' });
    } catch (err: unknown) {
      const { redactedMessage } = sanitizeError(err);
      return res.status(500).json({ error: redactedMessage });
    }
  });

  // Character Analyze Endpoint
  app.post('/api/characters/analyze', upload.array('masterPhotos', 8), async (req, res) => {
    try {
      const connectionId = req.headers['x-connection-id'] as string;
      const session = connectionId ? CredentialService.getSession(connectionId) : undefined;

      if (!session) {
        return res.status(401).json({
          error: '算力连接未建立或已失效。当前未激活 Google Cloud 赠金通道 (Vertex AI xp-vertex-project)。系统禁止自动静默切换计费通道，请先在「算力设置」中完成算力凭据连接。',
        });
      }

      const files = req.files as Express.Multer.File[];
      if (!files || files.length < 3 || files.length > 8) {
        return res.status(400).json({ error: '请上传 3～8 张角色多角度母板照片' });
      }

      const name = req.body.name || '未命名角色';
      const description = req.body.description || '';
      const adultConfirmed = req.body.adultConfirmed === 'true' || req.body.adultConfirmed === true;
      const rightsConfirmed = req.body.rightsConfirmed === 'true' || req.body.rightsConfirmed === true;

      const ai = await GeminiClientFactory.getClientForSession(session);
      const models = ModelRouter.getEffectiveModels(session);

      const imagesInput = files.map((f) => ({
        buffer: f.buffer,
        mimeType: f.mimetype,
      }));

      const result = await IdentityBuilder.analyzeCharacterProfile(
        ai,
        name,
        description,
        adultConfirmed,
        rightsConfirmed,
        imagesInput,
        models.analysisModel
      );

      if (result.status === 'ready') {
        const charId = req.body.id || `char_${crypto.randomUUID().slice(0, 8)}`;
        const serverChar: ServerCharacter = {
          id: charId,
          name,
          description,
          identitySpec: result.identitySpec,
          referenceImages: files.map((f, i) => ({
            id: `ref_${i}`,
            buffer: f.buffer,
            mimeType: f.mimetype || 'image/jpeg',
            width: 1080,
            height: 1080,
          })),
          updatedAt: new Date().toISOString(),
        };
        const durableRecord = await durableCharacterService.save({
          id: charId, name, description, identitySpec: result.identitySpec, images: imagesInput, adultConfirmed, rightsConfirmed,
        });
        const hydrated = await durableCharacterService.hydrate(durableRecord);
        serverCharacterStore.set(charId, hydrated);
        return res.json({ ...result, characterId: charId, storageAuthority: 'firestore', artifactAuthority: 'gcs' });
      }

      return res.json(result);
    } catch (err: unknown) {
      const { redactedMessage } = sanitizeError(err);
      return res.status(500).json({ error: redactedMessage });
    }
  });

  // Scene Analyze Endpoint
  app.post('/api/scenes/analyze', upload.single('sceneImage'), async (req, res) => {
    try {
      const connectionId = req.headers['x-connection-id'] as string;
      const session = CredentialService.getSession(connectionId);
      if (!session) {
        return res.status(401).json({ error: '算力连接已失效，请重新连接' });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: '请上传一张场景图' });
      }

      const ai = await GeminiClientFactory.getClientForSession(session);
      const models = ModelRouter.getEffectiveModels(session);
      const analysis = await SceneAnalyzer.analyzeSceneImage(
        ai,
        file.buffer,
        file.mimetype || 'image/jpeg',
        models.analysisModel
      );

      return res.json({ analysis });
    } catch (err: unknown) {
      const { redactedMessage } = sanitizeError(err);
      return res.status(500).json({ error: …22758 tokens truncated…rded from a completed cloud operation, try directly re-fetching video stream first
      if (record.videoUri) {
        try {
          let accessToken: string | undefined;
          if (session.type === 'vertex_ai') {
            accessToken = await VertexClient.getAccessToken(session);
          }
          const apiKey = session.apiKey || process.env.GEMINI_API_KEY;
          const reFetchBuf = await VideoGenerator.fetchGcsVideoBuffer(record.videoUri, accessToken, apiKey);
          if (reFetchBuf && reFetchBuf.length > 0) {
            let artifactMeta;
            try {
              const artifactTaskKey = DurableVideoRetryService.getAttemptTaskKey(
                taskId,
                record.providerAttempt || 1
              );
              artifactMeta = await gcsArtifactStore.uploadVideoArtifact({
                taskId: artifactTaskKey,
                videoBuffer: reFetchBuf,
                contentType: 'video/mp4',
              });
            } catch (uploadErr) {
              artifactMeta = await gcsArtifactStore.migrateArtifactToGcs({
                taskId: DurableVideoRetryService.getAttemptTaskKey(taskId, record.providerAttempt || 1),
                videoUri: record.videoUri,
                accessToken,
                apiKey,
              });
            }

            ephemeralVideoStore.set(taskId, reFetchBuf);
            const settledTask = await settlePersistedVideoThroughQa({
              taskId,
              videoBuffer: reFetchBuf,
              artifactMeta,
              session,
              ai: await GeminiClientFactory.getClientForSession(session),
              analysisModel: session.analysisModel || 'gemini-3.6-flash',
              patch: { pollHttpStatus: 200, pollAttempt: record.pollAttempt },
            });
            serverVideoTaskStore.set(taskId, settledTask);

            return res.json({
              status: settledTask.status,
              videoDataUrl: settledTask.videoDataUrl || `/api/videos/stream/${taskId}`,
              sizeBytes: settledTask.sizeBytes,
              durationSeconds: settledTask.durationSeconds,
              qaReport: settledTask.qaReport,
              identityQaStatus: settledTask.identityQaStatus,
              requiresManualApproval: settledTask.status === 'qa_pending' && settledTask.identityQaStatus === 'review',
              diagnostics: settledTask.diagnostics,
              outputBucket: settledTask.outputBucket,
              outputObjectPath: settledTask.outputObjectPath,
              artifactPersisted: settledTask.artifactPersisted,
            });
          }
        } catch (reFetchErr) {
          console.warn(`[Re-Fetch Video Stream Warning] Direct re-fetch with videoUri ${record.videoUri} failed:`, reFetchErr);
        }
      }

      const ai = await GeminiClientFactory.getClientForSession(session);
      const pollRes = await VideoGenerator.pollVeoOperation(ai, session, record.operationName!);

      record.pollHttpStatus = 200;
      if (pollRes.videoUri) {
        record.videoUri = pollRes.videoUri;
      }

      if (!pollRes.done) {
        const elapsedSeconds = Math.floor((Date.now() - record.createdAt) / 1000);
        if (elapsedSeconds > 1800) {
          const updates: Partial<ServerVideoTaskRecord> = {
            status: 'polling_timeout',
            pollHttpStatus: 200,
            pollAttempt: record.pollAttempt,
            updatedAt: Date.now(),
            ...(pollRes.videoUri ? { videoUri: pollRes.videoUri } : {}),
          };

          try {
            await safeUpdateTaskRecord(taskId, updates);
          } catch (updateErr) {
            console.error(`[Firestore Status Timeout Update Error] Task ${taskId}:`, updateErr);
            const saveErrObj = createStructuredError({
              source: 'internal_api',
              failureStage: 'internal_api',
              httpStatus: 500,
              customUserMessage: '无法在 Firestore 持久化任务超时状态',
              endpointPathRedacted: `/api/videos/status/${taskId}`,
            });
            return res.status(500).json({
              storageAuthority: 'firestore',
              status: 'failed',
              error: '存储服务更新失败',
              structuredError: saveErrObj,
            });
          }

          Object.assign(record, updates);
          serverVideoTaskStore.set(taskId, record);
          saveTasksToDisk(serverVideoTaskStore);

          return res.json({
            status: 'polling_timeout',
            elapsedSeconds,
            pollAttempt: record.pollAttempt,
            operationName: record.operationName,
            message: '云端视频渲染时间较长（已超过30分钟），任务仍保留在 Google 云端。您可以随时点击「继续查询」获取最新进展。',
          });
        }

        const prevStatus = record.status;
        const prevVideoUri = record.videoUri;
        const newVideoUri = pollRes.videoUri;

        const statusChanged = prevStatus !== 'polling';
        const videoUriChanged = Boolean(newVideoUri && newVideoUri !== prevVideoUri);

        const updates: Partial<ServerVideoTaskRecord> = {
          status: 'polling',
          pollHttpStatus: 200,
          pollAttempt: record.pollAttempt,
          updatedAt: Date.now(),
          ...(newVideoUri ? { videoUri: newVideoUri } : {}),
        };

        try {
          await safeUpdateTaskRecord(taskId, updates);
        } catch (updateErr) {
          console.error(`[Firestore Status Polling Update Error] Task ${taskId}:`, updateErr);
          const saveErrObj = createStructuredError({
            source: 'internal_api',
            failureStage: 'internal_api',
            httpStatus: 500,
            customUserMessage: '无法在 Firestore 持久化任务轮询状态',
            endpointPathRedacted: `/api/videos/status/${taskId}`,
          });
          return res.status(500).json({
            storageAuthority: 'firestore',
            status: 'failed',
            error: '存储服务更新失败',
            structuredError: saveErrObj,
          });
        }

        Object.assign(record, updates);
        serverVideoTaskStore.set(taskId, record);
        saveTasksToDisk(serverVideoTaskStore);

        return res.json({
          status: 'polling',
          elapsedSeconds,
          pollAttempt: record.pollAttempt,
        });
      }

      if (pollRes.error) {
        const failureReason = pollRes.failureReason || (pollRes.isSafetyBlock ? 'output_rai_filtered' : 'unknown');
        const retryMode = pollRes.retryMode || (failureReason === 'output_rai_filtered' ? 'REWRITE_INPUT_THEN_REGENERATE' : 'SAFE_TO_REGENERATE');

        const errObj = createStructuredError({
          source: 'vertex_polling',
          failureStage: 'polling',
          httpStatus: 500,
          customUserMessage: pollRes.error,
          endpointPathRedacted: `/api/videos/status/${taskId}`,
        });

        const updates: Partial<ServerVideoTaskRecord> = {
          status: 'failed',
          error: pollRes.error,
          failureReason,
          retryMode,
          raiStatus: pollRes.raiStatus || (failureReason === 'output_rai_filtered' ? 'filtered' : 'not_filtered'),
          raiMediaFilteredCount: pollRes.raiMediaFilteredCount ?? null,
          raiMediaFilteredReasons: pollRes.raiMediaFilteredReasons ?? null,
          structuredError: errObj,
          pollHttpStatus: 200,
          pollAttempt: record.pollAttempt,
          updatedAt: Date.now(),
          videoDataUrl: null,
          sizeBytes: null,
          ...(pollRes.videoUri ? { videoUri: pollRes.videoUri } : {}),
        };

        try {
          await safeUpdateTaskRecord(taskId, updates);
        } catch (updateErr) {
          console.error(`[Firestore Status Failed Update Error] Task ${taskId}:`, updateErr);
          const saveErrObj = createStructuredError({
            source: 'internal_api',
            failureStage: 'internal_api',
            httpStatus: 500,
            customUserMessage: '无法在 Firestore 持久化任务失败状态',
            endpointPathRedacted: `/api/videos/status/${taskId}`,
          });
          return res.status(500).json({
            storageAuthority: 'firestore',
            status: 'failed',
            error: '存储服务更新失败',
            structuredError: saveErrObj,
          });
        }

        Object.assign(record, updates);
        serverVideoTaskStore.set(taskId, record);
        saveTasksToDisk(serverVideoTaskStore);

        return res.json({
          status: 'failed',
          error: pollRes.error,
          failureReason,
          retryMode,
          raiStatus: record.raiStatus,
          raiMediaFilteredCount: record.raiMediaFilteredCount,
          raiMediaFilteredReasons: record.raiMediaFilteredReasons,
          structuredError: errObj,
        });
      }

      if (!pollRes.videoBuffer && !pollRes.videoUri && !record.videoUri) {
        const failureReason = pollRes.failureReason || (pollRes.isSafetyBlock ? 'output_rai_filtered' : 'upstream_empty_response');
        const retryMode = pollRes.retryMode || (failureReason === 'output_rai_filtered' ? 'REWRITE_INPUT_THEN_REGENERATE' : 'SAFE_TO_REGENERATE');
        const userErrMsg = pollRes.error || (failureReason === 'output_rai_filtered'
          ? '视频生成结果被 Google Vertex AI 安全策略过滤，未生成可下载的视频。请调整输入图片或提示词后重新生成。'
          : '云端 Veo 任务已完成，但未返回可用的视频数据。');

        const errObj = createStructuredError({
          source: failureReason === 'output_rai_filtered' ? 'vertex_polling' : 'output_download',
          failureStage: 'polling',
          httpStatus: 200,
          customUserMessage: userErrMsg,
          endpointPathRedacted: `/api/videos/status/${taskId}`,
        });

        const updates: Partial<ServerVideoTaskRecord> = {
          status: 'failed',
          error: userErrMsg,
          failureReason,
          retryMode,
          raiStatus: pollRes.raiStatus || (failureReason === 'output_rai_filtered' ? 'filtered' : 'not_filtered'),
          raiMediaFilteredCount: pollRes.raiMediaFilteredCount ?? null,
          raiMediaFilteredReasons: pollRes.raiMediaFilteredReasons ?? null,
          structuredError: errObj,
          pollHttpStatus: 200,
          pollAttempt: record.pollAttempt,
          updatedAt: Date.now(),
          videoDataUrl: null,
          sizeBytes: null,
          ...(pollRes.videoUri ? { videoUri: pollRes.videoUri } : {}),
        };

        try {
          await safeUpdateTaskRecord(taskId, updates);
        } catch (updateErr) {
          console.error(`[Firestore Status Failed Update Error] Task ${taskId}:`, updateErr);
          const saveErrObj = createStructuredError({
            source: 'internal_api',
            failureStage: 'internal_api',
            httpStatus: 500,
            customUserMessage: '无法在 Firestore 持久化任务失败状态',
            endpointPathRedacted: `/api/videos/status/${taskId}`,
          });
          return res.status(500).json({
            storageAuthority: 'firestore',
            status: 'failed',
            error: '存储服务更新失败',
            structuredError: saveErrObj,
          });
        }

        Object.assign(record, updates);
        serverVideoTaskStore.set(taskId, record);
        saveTasksToDisk(serverVideoTaskStore);

        return res.json({
          status: 'failed',
          error: record.error,
          failureReason,
          retryMode,
          raiStatus: record.raiStatus,
          raiMediaFilteredCount: record.raiMediaFilteredCount,
          raiMediaFilteredReasons: record.raiMediaFilteredReasons,
          structuredError: errObj,
        });
      }

      let videoBuf = pollRes.videoBuffer;
      if ((!videoBuf || videoBuf.length === 0) && (pollRes.videoUri || record.videoUri)) {
        try {
          const targetUri = pollRes.videoUri || record.videoUri!;
          let accessToken: string | undefined;
          if (session.type === 'vertex_ai') {
            accessToken = await VertexClient.getAccessToken(session);
          }
          const apiKey = session.apiKey || process.env.GEMINI_API_KEY;
          videoBuf = await VideoGenerator.fetchGcsVideoBuffer(targetUri, accessToken, apiKey);
        } catch (fetchErr) {
          console.error(`[Artifact Fetch Error] Task ${taskId}:`, fetchErr);
        }
      }

      if (!videoBuf || videoBuf.length === 0) {
        const errObj = createStructuredError({
          source: 'artifact_persist',
          failureStage: 'artifact_persist',
          httpStatus: 500,
          customUserMessage: 'Veo 渲染完成，但未能获取视频产物 Buffer 存储至 Cloud Storage。',
          endpointPathRedacted: `/api/videos/status/${taskId}`,
        });
        const failUpdates: Partial<ServerVideoTaskRecord> = {
          status: 'failed',
          error: 'Veo 渲染完成，但未能获取视频产物 Buffer 存储至 Cloud Storage。',
          structuredError: errObj,
          updatedAt: Date.now(),
        };
        await safeUpdateTaskRecord(taskId, failUpdates);
        Object.assign(record, failUpdates);
        serverVideoTaskStore.set(taskId, record);
        return res.status(500).json({
          storageAuthority: 'firestore',
          status: 'artifact_persist_failed',
          error: failUpdates.error,
          structuredError: errObj,
        });
      }

      // P0-5 canonical artifact persistence state: the provider has completed,
      // but the task cannot become completed until the owned GCS object is persisted.
      await safeUpdateTaskRecord(taskId, {
        status: 'generation_succeeded',
        pollHttpStatus: 200,
        pollAttempt: record.pollAttempt,
        ...(pollRes.videoUri ? { videoUri: pollRes.videoUri } : {}),
      });
      await safeUpdateTaskRecord(taskId, { status: 'artifact_persisting' });

      // Persist to GCS and verify existence & non-zero size
      let artifactMeta;
      try {
        artifactMeta = await gcsArtifactStore.uploadVideoArtifact({
          taskId: DurableVideoRetryService.getAttemptTaskKey(taskId, record.providerAttempt || 1),
          videoBuffer: videoBuf,
          contentType: 'video/mp4',
        });
      } catch (persistErr: any) {
        console.error(`[Cloud Storage Persist Error] Task ${taskId}:`, persistErr);
        const errObj = createStructuredError({
          source: 'artifact_persist',
          failureStage: 'artifact_persist',
          httpStatus: 500,
          customUserMessage: `视频产物写入 Cloud Storage 失败: ${persistErr?.message || persistErr}`,
          endpointPathRedacted: `/api/videos/status/${taskId}`,
        });
        const failUpdates: Partial<ServerVideoTaskRecord> = {
          status: 'artifact_persist_failed',
          error: `视频产物写入 Cloud Storage 失败: ${persistErr?.message || persistErr}`,
          structuredError: errObj,
          updatedAt: Date.now(),
        };
        await safeUpdateTaskRecord(taskId, failUpdates);
        Object.assign(record, failUpdates);
        serverVideoTaskStore.set(taskId, record);
        return res.status(500).json({
          storageAuthority: 'firestore',
          status: 'artifact_persist_failed',
          error: failUpdates.error,
          structuredError: errObj,
        });
      }
      // Cache is optional only; durable GCS + Firestore remain the authorities.
      saveVideoBufferToFile(taskId, videoBuf);
      const settledTask = await settlePersistedVideoThroughQa({
        taskId,
        videoBuffer: videoBuf,
        artifactMeta,
        session,
        ai,
        analysisModel: session.analysisModel || 'gemini-3.6-flash',
        patch: { pollHttpStatus: 200, pollAttempt: record.pollAttempt },
      });
      serverVideoTaskStore.set(taskId, settledTask);

      return res.json({
        status: settledTask.status,
        videoDataUrl: settledTask.videoDataUrl || `/api/videos/stream/${taskId}`,
        sizeBytes: settledTask.sizeBytes,
        durationSeconds: settledTask.durationSeconds,
        qaReport: settledTask.qaReport,
        identityQaStatus: settledTask.identityQaStatus,
        requiresManualApproval: settledTask.status === 'qa_pending' && settledTask.identityQaStatus === 'review',
        diagnostics: settledTask.diagnostics,
        outputBucket: settledTask.outputBucket,
        outputObjectPath: settledTask.outputObjectPath,
        artifactPersisted: settledTask.artifactPersisted,
      });
    } catch (err: unknown) {
      const httpStatus = (err as any)?.httpStatus || 500;
      const source = (err as any)?.source || 'vertex_polling';
      const failureStage = (err as any)?.failureStage || 'polling';
      const endpointHost = (err as any)?.endpointHost || null;
      const endpointPathRedacted = (err as any)?.endpointPathRedacted || null;

      const errObj = createStructuredError({
        source,
        failureStage,
        httpStatus,
        rawError: err,
        endpointHost,
        endpointPathRedacted: endpointPathRedacted || `/api/videos/status/${req.params.taskId}`,
      });
      return res.status(httpStatus).json(errObj);
    }
  });

  // Scene Image Streaming Endpoint
  app.get('/api/videos/image/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const cached = ephemeralImageStore.get(taskId);
      if (cached) {
        res.setHeader('Content-Type', cached.mimeType || 'image/jpeg');
        return res.send(cached.buffer);
      }

      // Check in-memory task record fallback
      const rec = serverVideoTaskStore.get(taskId);
      if (rec?.sceneImageUrl && rec.sceneImageUrl.startsWith('data:image/')) {
        const matches = rec.sceneImageUrl.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
        if (matches) {
          const contentType = matches[1];
          const buffer = Buffer.from(matches[2], 'base64');
          res.setHeader('Content-Type', contentType);
          return res.send(buffer);
        }
      }

      return res.status(404).send('Image not found');
    } catch (err) {
      console.error(`[Scene Image] Error serving image for ${req.params.taskId}:`, err);
      return res.status(500).send('Error serving image');
    }
  });

  // M2-5 Durable Human Review Endpoint
  app.post('/api/videos/review/:taskId', async (req, res) => {
    try {
      const taskId = String(req.params.taskId || '').trim();
      const decisionRaw = String(req.body?.decision || '').trim().toLowerCase();
      const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
      if (!taskId) return res.status(400).json({ error: 'taskId is required' });
      if (decisionRaw !== 'accepted' && decisionRaw !== 'rejected') {
        return res.status(400).json({ error: 'decision must be accepted or rejected' });
      }

      const reviewerHeader = String(req.headers['x-reviewer-id'] || 'studio-workbench').trim();
      const reviewedTask = await taskStateMachineService.resolveHumanReview({
        taskId,
        decision: decisionRaw as 'accepted' | 'rejected',
        reviewerId: reviewerHeader || 'studio-workbench',
        note,
      });
      serverVideoTaskStore.set(taskId, reviewedTask);

      return res.json({
        status: reviewedTask.status,
        taskId,
        stateVersion: reviewedTask.stateVersion,
        humanReviewDecision: reviewedTask.humanReviewDecision,
        humanReviewRecord: reviewedTask.humanReviewRecord,
        identityQaStatus: reviewedTask.identityQaStatus,
        qaReport: reviewedTask.qaReport,
        artifactPersisted: reviewedTask.artifactPersisted,
        videoDataUrl: reviewedTask.videoDataUrl || `/api/videos/stream/${taskId}`,
        error: reviewedTask.error,
      });
    } catch (err: any) {
      const message = err?.message || String(err);
      const status = message.includes('HUMAN_REVIEW_DECISION_CONFLICT') ? 409
        : message.includes('HUMAN_REVIEW_NOT_ELIGIBLE') ? 422
        : message.includes('HUMAN_REVIEW_REVIEWER_REQUIRED') ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  // Recover Video Artifact Endpoint (Does NOT resubmit Veo generation)
  app.post('/api/videos/recover/:taskId', async (req, res) => {
    const { taskId } = req.params;
    console.log(`[Video Recover] Requesting artifact recovery for task ${taskId}...`);
    try {
      if (!firestoreTaskRepository.isAvailable()) {
        return res.status(503).json({
          success: false,
          storageAuthority: 'unavailable',
          error: 'Firestore unavailable; artifact recovery cannot proceed safely.',
        });
      }

      const rec = await firestoreTaskRepository.getTask(taskId);
      if (!rec) {
        return res.status(404).json({ error: '任务不存在，无法恢复视频产物', storageAuthority: 'firestore' });
      }

      // A completed task is allowed to stream only its authoritative owned GCS artifact.
      // If that object vanished, do not silently repair a ghost-completed task from an
      // external URI or stale process state; surface the integrity failure explicitly.
      if (rec.status === 'completed') {
        if (!rec.outputBucket || !rec.outputObjectPath || rec.artifactPersisted !== true) {
          return res.status(409).json({
            error: 'completed_invariant_violation',
            storageAuthority: 'firestore',
          });
        }
        const existing = await gcsArtifactStore.checkArtifactExists(rec.outputBucket, rec.outputObjectPath);
        if (!existing.exists || (existing.sizeBytes || 0) <= 0) {
          return res.status(404).json({
            error: 'artifact_not_found',
            storageAuthority: 'gcs',
            outputBucket: rec.outputBucket,
            outputObjectPath: rec.outputObjectPath,
          });
        }
        return res.json({
          success: true,
          status: 'completed',
          message: '视频产物已在 Cloud Storage 中确认就绪',
          videoDataUrl: `/api/videos/stream/${taskId}`,
          storageAuthority: 'gcs',
        });
      }

      // 0. submission_outcome_unknown can lose operationName even when Veo accepted the
      // request. Because every submission uses an exact task/attempt-specific storageUri,
      // a valid MP4 already present under that prefix is sufficient task-linkage evidence.
      // This path only lists/downloads GCS; it never calls predictLongRunning.
      if (rec.status === 'submission_outcome_unknown' && !rec.outputObjectPath) {
        const requestedConnectionId = req.headers['x-connection-id'] as string;
        const recoverySession =
          CredentialService.getSession(requestedConnectionId || rec.connectionId) ||
          CredentialService.getSession(rec.connectionId) ||
          CredentialService.getSession();
        const providerAttempt = Math.max(1, Number(rec.providerAttempt) || 1);
        const derivedRecoveryTaskKey = DurableVideoRetryService.getAttemptTaskKey(taskId, providerAttempt);
        const persistedStorageTaskKey = String(rec.providerStorageTaskKey || '').trim();
        const persistedExpectedStorageUri = String(rec.expectedProviderStorageUri || '').trim();
        const hasAnyPersistedStorageIntent = Boolean(persistedStorageTaskKey || persistedExpectedStorageUri);
        const hasCompletePersistedStorageIntent = Boolean(persistedStorageTaskKey && persistedExpectedStorageUri);
        const recoveryTaskKey = persistedStorageTaskKey || derivedRecoveryTaskKey;
        const derivedExpectedStorageUri = resolveVeoStorageUri(recoveryTaskKey);

        if (
          (hasAnyPersistedStorageIntent && !hasCompletePersistedStorageIntent) ||
          (persistedStorageTaskKey && persistedStorageTaskKey !== derivedRecoveryTaskKey) ||
          (persistedExpectedStorageUri && persistedExpectedStorageUri !== derivedExpectedStorageUri)
        ) {
          return res.status(409).json({
            success: false,
            providerTaskLinked: false,
            failureReason: 'provider_storage_intent_mismatch',
            status: 'submission_outcome_unknown',
            providerAttempt,
            persistedStorageTaskKey: persistedStorageTaskKey || null,
            persistedExpectedStorageUri: persistedExpectedStorageUri || null,
            derivedRecoveryTaskKey,
            derivedExpectedStorageUri,
            predictLongRunningCalls: 0,
            error: 'Provider 存储意图与当前任务/配置不一致。为避免扫描错误路径或误绑定其他产物，任务继续锁定。',
            storageAuthority: 'firestore',
          });
        }

        const discovery = await gcsArtifactStore.discoverTaskPrefixVideo({
          taskKey: recoveryTaskKey,
          session: recoverySession,
        });

        if (discovery.status === 'ambiguous') {
          return res.status(409).json({
            success: false,
            providerTaskLinked: false,
            failureReason: 'task_gcs_artifact_ambiguous',
            status: 'submission_outcome_unknown',
            expectedStoragePrefix: discovery.expectedStoragePrefix,
            candidateCount: discovery.candidates.length,
            predictLongRunningCalls: 0,
            error: '任务专属 GCS 前缀下发现多个有效视频，无法安全判断本次 Provider 尝试对应哪一个产物；任务继续锁定。',
            storageAuthority: 'firestore',
          });
        }

        if (discovery.status === 'found' && discovery.artifact && discovery.videoBuffer) {
          ephemeralVideoStore.set(taskId, discovery.videoBuffer);
          const recoveredTask = await taskStateMachineService.persistArtifactForQa({
            taskId,
            outputBucket: discovery.artifact.outputBucket,
            outputObjectPath: discovery.artifact.outputObjectPath,
            videoUri: discovery.artifact.videoUri,
            sizeBytes: discovery.artifact.sizeBytes,
            contentType: discovery.artifact.contentType,
            artifactPersistedAt: discovery.artifact.artifactPersistedAt,
            patch: {
              failureReason: null as any,
              retryMode: 'NO_RETRY',
              error: '',
              structuredError: null as any,
            },
          });
          serverVideoTaskStore.set(taskId, recoveredTask);
          return res.json({
            success: true,
            status: recoveredTask.status,
            recoveredBy: 'task_gcs_prefix',
            providerTaskLinked: true,
            providerAttempt,
            expectedStoragePrefix: discovery.expectedStoragePrefix,
            videoDataUrl: `/api/videos/stream/${taskId}`,
            predictLongRunningCalls: 0,
            message: '已从本次 Provider 尝试专属 GCS 前缀找回有效视频，并进入身份质检；未发起新的 Veo 生成。',
            storageAuthority: 'gcs',
          });
        }

        if (!rec.operationName && !rec.videoUri) {
          return res.status(404).json({
            success: false,
            providerTaskLinked: false,
            failureReason: 'task_gcs_artifact_not_found',
            status: 'submission_outcome_unknown',
            expectedStoragePrefix: discovery.expectedStoragePrefix,
            predictLongRunningCalls: 0,
            error: '本次 Provider 尝试的专属 GCS 前缀暂未发现有效视频。任务继续锁定，可稍后再次自动检查或使用 Operation Name 核实。',
            storageAuthority: 'gcs',
          });
        }
      }

      // 1. Reconcile an already-owned GCS object without resubmitting the provider.
      if (rec.outputBucket && rec.outputObjectPath) {
        const existing = await gcsArtifactStore.checkArtifactExists(rec.outputBucket, rec.outputObjectPath);
        if (existing.exists && (existing.sizeBytes || rec.sizeBytes || 0) > 0) {
          const completedTask = await taskStateMachineService.persistArtifactForQa({
            taskId,
            outputBucket: rec.outputBucket,
            outputObjectPath: rec.outputObjectPath,
            videoUri: rec.videoUri || `gs://${rec.outputBucket}/${rec.outputObjectPath}`,
            sizeBytes: existing.sizeBytes || rec.sizeBytes,
            contentType: rec.contentType || 'video/mp4',
            artifactPersistedAt: rec.artifactPersistedAt || Date.now(),
          });
          serverVideoTaskStore.set(taskId, completedTask);
          return res.json({
            success: true,
            status: 'qa_pending',
            message: '已恢复 Cloud Storage 产物，等待视频身份质检',
            videoDataUrl: `/api/videos/stream/${taskId}`,
            storageAuthority: 'gcs',
          });
        }
      }

      // 2. Migrate a provider URI into owned GCS. CredentialService.getSession can
      // reconstruct an ADC-backed Vertex session after a Cloud Run process restart.
      if (rec.videoUri && !rec.videoUri.startsWith('gs://')) {
        const session = CredentialService.getSession(rec.connectionId) || CredentialService.getSession();
        let accessToken: string | undefined;
        if (session?.type === 'vertex_ai') {
          accessToken = await VertexClient.getAccessToken(session);
        }
        const apiKey = session?.apiKey || process.env.GEMINI_API_KEY;
        const artifactMeta = await gcsArtifactStore.migrateArtifactToGcs({
          taskId,
          videoUri: rec.videoUri,
          accessToken,
          apiKey,
        });
        const completedTask = await taskStateMachineService.persistArtifactForQa({
          taskId,
          outputBucket: artifactMeta.outputBucket,
          outputObjectPath: artifactMeta.outputObjectPath,
          videoUri: artifactMeta.videoUri,
          sizeBytes: artifactMeta.sizeBytes,
          contentType: artifactMeta.contentType,
          artifactPersistedAt: artifactMeta.artifactPersistedAt,
        });
        serverVideoTaskStore.set(taskId, completedTask);
        return res.json({
          success: true,
          status: 'qa_pending',
          message: '已从 Provider URI 持久化视频产物，等待视频身份质检',
          videoDataUrl: `/api/videos/stream/${taskId}`,
          storageAuthority: 'gcs',
        });
      }

      // 3. Resume a durable provider operation and migrate its result. No new generation
      // is created here; this only polls the operationName already stored in Firestore.
      if (rec.operationName) {
        const session = CredentialService.getSession(rec.connectionId) || CredentialService.getSession();
        if (!session || session.type !== 'vertex_ai') {
          return res.status(503).json({
            error: 'provider_session_unavailable',
            storageAuthority: 'firestore',
          });
        }
        const pollRes = await VertexClient.pollOperation(session, rec.operationName);
        if (!pollRes.done) {
          return res.status(202).json({
            success: true,
            status: rec.status,
            operationName: rec.operationName,
            message: 'Provider operation is still running; no resubmission was performed.',
          });
        }
        if (pollRes.error) {
          return res.status(502).json({ error: pollRes.error, status: 'failed' });
        }
        const extracted = pollRes.response ? VideoGenerator.extractVideoData(pollRes.response) : {} as any;
        if (extracted.uri) {
          const accessToken = await VertexClient.getAccessToken(session);
          const artifactMeta = await gcsArtifactStore.migrateArtifactToGcs({
            taskId,
            videoUri: extracted.uri,
            accessToken,
            apiKey: session.apiKey || process.env.GEMINI_API_KEY,
          });
          const completedTask = await taskStateMachineService.persistArtifactForQa({
            taskId,
            outputBucket: artifactMeta.outputBucket,
            outputObjectPath: artifactMeta.outputObjectPath,
            videoUri: artifactMeta.videoUri,
            sizeBytes: artifactMeta.sizeBytes,
            contentType: artifactMeta.contentType,
            artifactPersistedAt: artifactMeta.artifactPersistedAt,
          });
          serverVideoTaskStore.set(taskId, completedTask);
          return res.json({
            success: true,
            status: 'qa_pending',
            message: '已从 durable Veo Operation 恢复并持久化视频产物，等待视频身份质检',
            videoDataUrl: `/api/videos/stream/${taskId}`,
            storageAuthority: 'gcs',
          });
        }
      }

      return res.status(400).json({
        error: '当前任务不存在可恢复的 GCS 产物、Provider URI 或 durable OperationName。',
        storageAuthority: 'firestore',
      });
    } catch (err: any) {
      console.error(`[Video Recover Error] Task ${taskId}:`, err);
      return res.status(500).json({
        error: `恢复视频产物失败: ${err?.message || err}`,
        storageAuthority: 'firestore',
      });
    }
  });

  // Physical Video Streaming & Download Endpoint
  app.get('/api/videos/stream/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const isDownload = req.query.download === 'true' || req.query.download === '1';

      if (!firestoreTaskRepository.isAvailable()) {
        return res.status(503).json({
          error: 'task_metadata_authority_unavailable',
          storageAuthority: 'unavailable',
        });
      }

      // Firestore must validate the task before an ephemeral cache hit can be served.
      const rec = await firestoreTaskRepository.getTask(taskId);
      if (!rec) {
        return res.status(404).json({ error: 'task_not_found', storageAuthority: 'firestore' });
      }
      if (!rec.outputBucket || !rec.outputObjectPath || rec.artifactPersisted !== true) {
        return res.status(404).json({
          error: 'artifact_not_persisted',
          storageAuthority: 'firestore',
        });
      }

      let videoBuffer: Buffer | null = ephemeralVideoStore.get(taskId) || null;
      if (!videoBuffer || videoBuffer.length < 1000) {
        try {
          videoBuffer = await gcsArtifactStore.fetchArtifactBuffer(rec.outputBucket, rec.outputObjectPath);
          console.log(`[Video Stream] GCS authority read gs://${rec.outputBucket}/${rec.outputObjectPath} (${videoBuffer.length} bytes)`);
        } catch (gcsErr) {
          console.error(`[Video Stream] Authoritative GCS artifact missing for ${taskId}:`, (gcsErr as any)?.message || gcsErr);
          return res.status(404).json({
            error: 'artifact_not_found',
            storageAuthority: 'gcs',
            outputBucket: rec.outputBucket,
            outputObjectPath: rec.outputObjectPath,
          });
        }

        if (!videoBuffer || videoBuffer.length < 1000) {
          return res.status(404).json({
            error: 'artifact_not_found',
            storageAuthority: 'gcs',
          });
        }
        ephemeralVideoStore.set(taskId, videoBuffer);
      }

      const fileSize = videoBuffer.length;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (!Number.isFinite(start) || start < 0 || end < start || end >= fileSize) {
          res.setHeader('Content-Range', `bytes */${fileSize}`);
          return res.status(416).end();
        }
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': rec.contentType || 'video/mp4',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(videoBuffer.subarray(start, end + 1));
      }

      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': rec.contentType || 'video/mp4',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
        ...(isDownload ? { 'Content-Disposition': `attachment; filename="zaojing_${taskId}.mp4"` } : {}),
      });
      return res.end(videoBuffer);
    } catch (err) {
      console.error('Error streaming video:', err);
      return res.status(500).json({ error: '读取视频流或下载失败' });
    }
  });

  // Legacy synchronous generation endpoint is disabled because it bypasses
  // Firestore/GCS authority and durable post-artifact Identity QA.
  app.post('/api/videos/generate-and-qa', (_req, res) => {
    return res.status(410).json({
      error: 'legacy_video_generation_disabled',
      useEndpoint: '/api/videos/start',
    });
  });

  // Fallback 404 handler for unmatched /api/* routes to prevent serving HTML
  app.all('/api/*', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const errObj = createStructuredError({
      source: 'internal_api',
      failureStage: 'internal_api',
      httpStatus: 404,
      customUserMessage: '应用服务接口不存在或部署版本不匹配。',
      endpointPathRedacted: req.originalUrl,
    });
    res.status(404).json(errObj);
  });

  // Global error handler for API routes
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Express API error:', err);
    const { redactedMessage } = sanitizeError(err);
    res.setHeader('Content-Type', 'application/json');
    res.status(err.status || err.statusCode || 500).json({ error: redactedMessage || '服务器内部异常' });
  });

  // Vite middleware for dev
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return app;
}

export async function startServer() {
  const app = await createApp();
  const configuredPort = Number(process.env.PORT || 3000);
  const PORT = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 3000;

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);

    // P0-5 Cloud Run rule: startup recovery must read durable Firestore state,
    // never enumerate process-local task memory and never write terminal state directly.
    // Local Docker smoke can explicitly disable cloud recovery because GitHub runners
    // have no ADC; the real Cloud Run certification must leave this flag unset.
    if (process.env.P0_DISABLE_STARTUP_RECOVERY === '1') {
      console.log('[Recovery Engine] Startup recovery disabled for local runtime smoke.');
      return;
    }

    void taskStateMachineService
      .recoverAbandonedTasks()
      .then(({ recoveredCount, evaluatedCount }) => {
        console.log(
          `[Recovery Engine] Durable startup scan complete: evaluated=${evaluatedCount}, recovered=${recoveredCount}.`
        );
      })
      .catch((err) => {
        // Recovery failure must not prevent the HTTP service from becoming healthy.
        // Firestore/status/recover routes remain fail-closed and can retry explicitly.
        console.error('[Recovery Engine Initialization Error]:', err);
      });
  });

  return server;
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startServer();
}
