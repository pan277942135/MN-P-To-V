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
      return res.status(500).json({ error: redactedMessage });
    }
  });

  // Normalize Prompt Endpoint
  app.post('/api/prompts/normalize', async (req, res) => {
    try {
      const connectionId = req.headers['x-connection-id'] as string;
      const session = CredentialService.getSession(connectionId);
      if (!session) {
        return res.status(401).json({ error: '算力连接已失效，请重新连接' });
      }

      const {
        userPromptChinese,
        sceneAnalysis,
        identityLockEnglish,
        primaryStyle,
        secondaryStyle,
        styleStrength,
      } = req.body;

      const ai = await GeminiClientFactory.getClientForSession(session);
      const models = ModelRouter.getEffectiveModels(session);
      const normalized = await SceneAnalyzer.normalizePrompt(
        ai,
        userPromptChinese || '动作姿态演化',
        sceneAnalysis,
        identityLockEnglish || '',
        primaryStyle || '照片级写实',
        secondaryStyle || '',
        styleStrength ?? 0.5,
        models.analysisModel
      );

      return res.json(normalized);
    } catch (err: unknown) {
      const { redactedMessage } = sanitizeError(err);
      return res.status(500).json({ error: redactedMessage });
    }
  });

  // First Frame Generation & QA Endpoint
  app.post('/api/first-frames/generate-and-qa', upload.fields([
    { name: 'sceneImage', maxCount: 1 },
    { name: 'masterImages', maxCount: 4 },
    { name: 'masterImage', maxCount: 1 },
    { name: 'refImages', maxCount: 4 },
  ]), async (req, res) => {
    try {
      const connectionId = req.headers['x-connection-id'] as string;
      const session = CredentialService.getSession(connectionId);
      if (!session) {
        return res.status(401).json({ error: '算力连接已失效，请重新连接' });
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const sceneFile = files['sceneImage']?.[0];
      const masterFiles = [
        ...(files['masterImages'] || []),
        ...(files['masterImage'] || []),
      ];

      if (!sceneFile || masterFiles.length === 0) {
        return res.status(400).json({ error: '缺少场景图或角色母板图 (masterImages)' });
      }

      const identitySpec = JSON.parse(req.body.identitySpec || '{}');
      const actionPose = req.body.actionPose || '';
      const sceneMode = req.body.sceneMode || 'replace_primary_person';

      const ai = await GeminiClientFactory.getClientForSession(session);
      const models = ModelRouter.getEffectiveModels(session);

      const refFiles = files['refImages'] || [];
      const references = (refFiles.length > 0 ? refFiles : masterFiles).slice(0, 4).map((f, i) => ({
        id: `ref_${i}`,
        blob: new Blob([f.buffer], { type: f.mimetype }),
        mimeType: f.mimetype,
        width: 1080,
        height: 1080,
        angle: (i === 0 ? 'front' : i === 1 ? '45_degree' : 'full_body') as any,
        qualityScore: 90,
        qualityIssues: [],
        sortOrder: i,
      }));

      const masterBuffers = masterFiles.slice(0, 4).map((f) => f.buffer);
      const masterMimeTypes = masterFiles.slice(0, 4).map((f) => f.mimetype || 'image/jpeg');

      const candidates = await FirstFrameGenerator.generateFirstFrameCandidates(
        ai,
        models.imageModel,
        sceneFile.buffer,
        sceneFile.mimetype || 'image/jpeg',
        identitySpec,
        references,
        actionPose,
        undefined,
        masterBuffers,
        masterMimeTypes,
        sceneMode
      );

      const candidate = candidates[0];
      const candidateBuf = Buffer.from(await candidate.blob.arrayBuffer());

      const qaReport = await VisualQaService.qaFirstFrame(
        ai,
        models.analysisModel,
        masterFiles[0].buffer,
        masterFiles[0].mimetype || 'image/jpeg',
        sceneFile.buffer,
        sceneFile.mimetype || 'image/jpeg',
        candidateBuf,
        candidate.mimeType,
        identitySpec,
        sceneMode
      );

      const candidateBase64 = candidateBuf.toString('base64');
      const dataUrl = `data:${candidate.mimeType};base64,${candidateBase64}`;

      return res.json({
        candidateId: candidate.id,
        dataUrl,
        qaReport,
      });
    } catch (err: unknown) {
      const { redactedMessage } = sanitizeError(err);
      return res.status(500).json({ error: redactedMessage });
    }
  });

  // Prompt Suggestion Endpoint based on uploaded image and character master reference
  app.post('/api/prompts/suggest', upload.fields([
    { name: 'sceneImage', maxCount: 1 },
    { name: 'characterImage', maxCount: 1 },
  ]), async (req, res) => {
    try {
      const connectionId = req.headers['x-connection-id'] as string;
      const session = CredentialService.getSession(connectionId);
      if (!session) {
        return res.status(401).json({ error: '算力连接已失效或未建立，请重新连接算力服务' });
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
      const sceneImageFile = files?.['sceneImage']?.[0];
      let characterImageFile = files?.['characterImage']?.[0];

      const {
        characterId,
        durationSeconds,
        motionIntensity,
        primaryStyle,
        secondaryStyle,
        cameraPreset,
        userPrompt,
      } = req.body;

      let charImageBuffer: Buffer | null = characterImageFile ? characterImageFile.buffer : null;
      let charMimeType: string = characterImageFile ? (characterImageFile.mimetype || 'image/jpeg') : 'image/jpeg';

      if (!charImageBuffer && characterId) {
        let storedChar = serverCharacterStore.get(characterId);
      if (!storedChar && characterId && durableCharacterService.isAvailable()) {
        const durableChar = await durableCharacterService.getHydrated(characterId);
        if (durableChar) { storedChar = durableChar; serverCharacterStore.set(characterId, durableChar); }
      }
        if (storedChar && storedChar.referenceImages.length > 0) {
          charImageBuffer = storedChar.referenceImages[0].buffer;
          charMimeType = storedChar.referenceImages[0].mimeType || 'image/jpeg';
        }
      }

      // We must have at least a scene image or character image
      if (!sceneImageFile && !charImageBuffer) {
        return res.status(400).json({ error: '未接收到有效参考图片，请先上传场景图或选择包含母板图的角色' });
      }

      const ai = await GeminiClientFactory.getClientForSession(session);
      const modelName = session.analysisModel || 'gemini-2.5-flash';

      const requestedDuration = durationSeconds ? `${durationSeconds}` : '8';
      const requestedStyle = [primaryStyle, secondaryStyle].filter(Boolean).join(', ') || 'Cinematic, Realistic Photography';
      const requestedMotion = motionIntensity === 'minimal'
        ? 'micro-movements only (subtle breathing, eye blink, soft hair sway)'
        : motionIntensity === 'expressive'
        ? 'larger expressiveness (noticeable head tilt, expressive gaze, hand gesture)'
        : 'natural motion (gentle head sway, subtle eye gaze shift, gentle hand gesture)';
      const requestedCamera = cameraPreset === 'slow_push'
        ? 'slow smooth camera push-in towards subject'
        : cameraPreset === 'slow_pull'
        ? 'slow smooth camera pull-back revealing background depth'
        : cameraPreset === 'subtle_pan'
        ? 'subtle smooth horizontal camera pan'
        : cameraPreset === 'vertical_boom'
        ? 'smooth vertical camera pedestal motion'
        : cameraPreset === 'subtle_orbit'
        ? 'gentle slow arc orbit camera movement around subject'
        : cameraPreset === 'tracking_shot'
        ? 'smooth parallel tracking camera motion'
        : cameraPreset === 'close_up'
        ? 'tight close-up portrait framing with eye focus'
        : 'locked camera, stable framing, no zoom, no pan';

      const userMotionContext = userPrompt && userPrompt.trim()
        ? `【用户额外指定的特定动作与氛围需求】：${userPrompt.trim()}`
        : '';

      const promptSystemInstruction = `你是一个专门为 Image-to-Video 生成稳定 vlog 提示词的专家助手。
你的任务是根据“输入图片内容 + 目标视频时长”生成一个合理、稳定、高通过率、低漂移的图生视频提示词。

请严格遵循以下原则与推理步骤：

1. 先分析图片：
   - 观察人物视角（正脸 / 三分之二侧脸 / 侧脸）、景别（近景 / 中近景 / 半身 / 全身）、是否看镜头。
   - 确认当前姿势是否已经完整成立，手部、头部、手机、头发、配饰是否有明显固定位置。
   - 判断背景适合静态 vlog 还是轻微动态 vlog。

2. 锁定不可改变的内容（高优先级）：
   - 锁定人脸身份 (Maintain character identity)
   - 锁定构图与景别 (Keep original framing and camera angle)
   - 锁定服装与饰品 (Maintain exact clothing and accessories)
   - 锁定背景环境与灯光 (Keep background scene and lighting)
   - 锁定手部位置 (Keep hand positions stable, zero hand drifting)
   - 锁定身体朝向 (Maintain torso orientation, do NOT turn body)
   - 不主动转正脸 (If side-profile, do NOT force face to turn frontal)
   - 不主动重新摆姿势 (Do NOT re-pose; original pose is final pose)

3. 动作密度必须匹配目标视频时长 (${requestedDuration}秒)：
   - 4秒：仅允许 1 个极轻微主动态（如轻柔呼吸、眼神微调或极轻表情变幻）。
   - 8秒：允许 1–2 个连续轻动作（如倾听微颔首 + 微弱发丝/眼神轻移）。
   - 10–12秒：允许 2 个连贯轻动作（如微颔首 + 眼神缓和回归镜头）。
   - 15–30秒：拆成多段，每段只做 1 个轻动作，动作间自然平滑衔接。

4. 动作必须服从原图姿势：
   - 原始姿势即为最终姿势，只允许在原姿势上叠加微小动态。禁止写成重新摆 pose、走动、转身或夸张体态变幻。

5. 默认 Vlog 真实日常风格：
   - 优先真实生活感 (Authentic everyday vlog)、自然人像摄影感 (Natural portrait photography)、轻松日常，绝不带有夸张表演感、舞蹈感或广告摆拍感。

6. 默认稳定性优先：
   - 宁可动作幅度极微，也绝不出现脸漂、手漂、姿势漂、身体扭转或换脸现象。

【用户选定参数】:
- 目标视频时长: ${requestedDuration} 秒
- 动作幅度: ${requestedMotion}
- 视觉风格: ${requestedStyle}
- 运镜轨迹: ${requestedCamera}
${userMotionContext ? `- ${userMotionContext}` : ''}

【输出格式】
直接生成一条符合上述规则的英文提示词纯文本 (English Prompt)：
- 开头："Create a ${requestedDuration}-second realistic vlog portrait video based on the uploaded image."
- 中段描述：描述原始姿势、视觉焦点、锁定要素（identity, pose, outfit, background），以及符合时长 (${requestedDuration}s) 的微弱自然动作（${requestedMotion}）。
- 结尾："Authentic vlog style, natural portrait photography, ${requestedCamera}, ${requestedStyle}, steady posture, consistent lighting, smooth motion, high quality."

必须仅输出最终英文提示词文本，不要包含 Markdown 标记、标签列表或解释说明。`;

      const contentsParts: any[] = [];

      // Primary scene image
      if (sceneImageFile) {
        contentsParts.push({
          inlineData: {
            mimeType: sceneImageFile.mimetype || 'image/jpeg',
            data: sceneImageFile.buffer.toString('base64'),
          },
        });
        contentsParts.push({ text: '【主参考图：场景与动作画面】' });
      }

      // Secondary character master image
      if (charImageBuffer) {
        contentsParts.push({
          inlineData: {
            mimeType: charMimeType,
            data: charImageBuffer.toString('base64'),
          },
        });
        contentsParts.push({ text: '【身份参考图：角色母板】' });
      }

      contentsParts.push({ text: promptSystemInstruction });

      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          {
            role: 'user',
            parts: contentsParts,
          },
        ],
      });

      const suggestedPrompt = response.text ? response.text.trim().replace(/^["'“‘`]+|["'”’`]+$/g, '') : '';
      if (!suggestedPrompt) {
        throw new Error('模型未能生成有效提示词，请稍后重试');
      }

      return res.json({ prompt: suggestedPrompt });
    } catch (err: unknown) {
      const { redactedMessage } = sanitizeError(err);
      return res.status(500).json({ error: redactedMessage });
    }
  });

  // Async Video Task Start Endpoint
  app.post('/api/videos/start', upload.fields([
    { name: 'firstFrame', maxCount: 1 },
    { name: 'sceneImage', maxCount: 1 },
    { name: 'masterImages', maxCount: 4 },
    { name: 'masterImage', maxCount: 1 },
  ]), async (req, res) => {
    try {
      const connectionId = req.headers['x-connection-id'] as string;
      const session = CredentialService.getSession(connectionId);
      if (!session) {
        return res.status(401).json({ error: '算力连接已失效，请重新连接' });
      }

      const storageConfig = assertProductionStorageConfig();
      if (!storageConfig.valid) {
        const isDrift = storageConfig.bucketDriftDetected;
        const failureReason = isDrift ? 'storage_configuration_drift' : 'storage_configuration_missing';
        const httpStatus = isDrift ? 503 : 400;
        const customUserMessage = isDrift
          ? `存储服务 Bucket 配置漂移：VEO_OUTPUT_BUCKET (${storageConfig.environmentBucket}) 与预期生产 Bucket (${storageConfig.expectedBucket}) 不一致。`
          : '存储服务配置缺失：未在环境变量中配置 VEO_OUTPUT_BUCKET。';

        console.error(`[Video Start] 拒绝启动 Veo 任务：Storage config invalid (${failureReason}), env: "${storageConfig.environmentBucket}", expected: "${storageConfig.expectedBucket}"`);
        const errObj = createStructuredError({
          source: 'internal_api',
          failureStage: 'submit',
          httpStatus,
          customUserMessage,
          endpointPathRedacted: '/api/videos/start',
        });
        return res.status(httpStatus).json({
          accepted: false,
          serverPersisted: false,
          status: 'failed',
          submissionState: 'not_submitted',
          failureReason,
          error: isDrift
            ? `Storage configuration drift: VEO_OUTPUT_BUCKET (${storageConfig.environmentBucket}) does not match expected production bucket (${storageConfig.expectedBucket}).`
            : 'Storage configuration missing: VEO_OUTPUT_BUCKET environment variable is required.',
          predictLongRunningCalls: 0,
          structuredError: errObj,
        });
      }

      const requestedTaskId = req.body.taskId;

      // P0-5: Firestore is the idempotency authority across Cloud Run instances.
      // Always check the durable task before consulting the process-local cache.
      if (requestedTaskId && firestoreTaskRepository.isAvailable()) {
        const durableExisting = await firestoreTaskRepository.getTask(requestedTaskId);
        if (durableExisting) {
          serverVideoTaskStore.set(requestedTaskId, durableExisting);
          if (['submitting', 'submitted', 'polling', 'polling_timeout', 'generation_succeeded', 'artifact_persisting', 'artifact_persisted', 'qa_pending', 'submission_outcome_unknown'].includes(durableExisting.status as string)) {
            return res.json({
              accepted: true,
              serverPersisted: true,
              taskId: durableExisting.taskId,
              status: durableExisting.status,
              submissionState: durableExisting.status === 'submission_outcome_unknown'
                ? 'outcome_unknown'
                : (durableExisting.operationName ? 'submitted' : 'submitting'),
              operationNamePresent: Boolean(durableExisting.operationName),
              isIdempotentReuse: true,
              createdAt: durableExisting.createdAt,
              updatedAt: durableExisting.updatedAt,
              engine: durableExisting.modelId,
              operationName: durableExisting.operationName,
            });
          }
          if (durableExisting.status === 'completed' && durableExisting.artifactPersisted) {
            return res.json({
              accepted: true,
              serverPersisted: true,
              taskId: durableExisting.taskId,
              status: 'completed',
              submissionState: 'submitted',
              operationNamePresent: Boolean(durableExisting.operationName),
              isIdempotentReuse: true,
              createdAt: durableExisting.createdAt,
              updatedAt: durableExisting.updatedAt,
              engine: durableExisting.modelId,
              videoDataUrl: durableExisting.videoDataUrl || `/api/videos/stream/${durableExisting.taskId}`,
              sizeBytes: durableExisting.sizeBytes,
              durationSeconds: durableExisting.durationSeconds,
              qaReport: durableExisting.qaReport,
              diagnostics: durableExisting.diagnostics,
            });
          }
        }
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const ffFile = files['firstFrame']?.[0];
      const sceneFile = files['sceneImage']?.[0];
      const masterFiles = [
        ...(files['masterImages'] || []),
        ...(files['masterImage'] || []),
      ];

      if (!ffFile && !sceneFile) {
        return res.status(400).json({ error: '缺少首帧图或场景输入图' });
      }

      const characterId = req.body.characterId || '';
      let characterDescription = req.body.characterDescription || '';
      let identitySpec = req.body.identitySpec ? JSON.parse(req.body.identitySpec || '{}') : { lockedTraits: [] };

      let storedChar = serverCharacterStore.get(characterId);
      if (!storedChar && characterId && durableCharacterService.isAvailable()) {
        const durableChar = await durableCharacterService.getHydrated(characterId);
        if (durableChar) { storedChar = durableChar; serverCharacterStore.set(characterId, durableChar); }
      }
      if (storedChar) {
        characterDescription = storedChar.description;
        identitySpec = storedChar.identitySpec;
      }

      const rawUserPrompt = req.body.rawUserPrompt || req.body.normalizedPrompt || '';
      const compiledPrompt = req.body.compiledPrompt || req.body.normalizedPrompt || '';
      const promptCompilerVersion = req.body.promptCompilerVersion || PromptCompiler.VERSION;
      const motionIntensity = req.body.motionIntensity || 'natural';
      const visualStyle = req.body.visualStyle || 'photorealistic';
      const cameraPreset = req.body.cameraPreset || 'locked_camera';

      // Clean negative prompt blocks and bracket tags before sending to Veo
      const normalizedPrompt = PromptCompiler.cleanUserMotionPrompt(compiledPrompt || rawUserPrompt);
      const sceneMode = req.body.sceneMode || 'replace_primary_person';
      const durationSeconds = Number(req.body.durationSeconds) || 4;
      const aspectRatio = req.body.aspectRatio || '9:16';
      const resolution = req.body.resolution || '720p';
      const generateAudio = req.body.generateAudio === 'true' || req.body.generateAudio === true;

      const ai = await GeminiClientFactory.getClientForSession(session);
      const models = ModelRouter.getEffectiveModels(session);

      let masterBuffers = masterFiles.slice(0, 3).map((f) => f.buffer);
      let masterMimeTypes = masterFiles.slice(0, 3).map((f) => f.mimetype || 'image/jpeg');

      if (masterBuffers.length === 0 && storedChar && storedChar.referenceImages.length > 0) {
        masterBuffers = storedChar.referenceImages.slice(0, 3).map((r) => r.buffer);
        masterMimeTypes = storedChar.referenceImages.slice(0, 3).map((r) => r.mimeType || 'image/jpeg');
      }


      const imageIsTargetCharacter = req.body.imageIsTargetCharacter === 'true' || req.body.imageIsTargetCharacter === true || req.body.isTargetCharacter === 'true' || req.body.isTargetCharacter === true;
      const manualApproved = req.body.manualApproved === 'true' || req.body.manualApproved === true;

      // Identity Lock Step 1: Determine Identity Source Mode
      const sourceMode = IdentityLockService.determineIdentitySourceMode({
        sceneMode,
        imageIsTargetCharacter,
      });

      // M2-1/M2-2 fail closed: every identity mode requires at least one durable master reference.
      if (masterBuffers.length === 0) {
        console.warn(`[Video Start] 拒绝启动 Veo: 缺失目标角色母板图 (identity_reference_missing)`);
        const errObj = createStructuredError({
          source: 'internal_api',
          failureStage: 'submit',
          httpStatus: 400,
          customUserMessage: '未提供目标角色母板图 (master image)，无法执行强制角色身份质检。',
          endpointPathRedacted: '/api/videos/start',
        });

        return res.status(400).json({
          accepted: false,
          serverPersisted: false,
          status: 'failed',
          submissionState: 'not_submitted',
          failureReason: 'identity_reference_missing',
          error: errObj.userMessage,
          predictLongRunningCalls: 0,
          structuredError: errObj,
        });
      }

      const rawSceneBuf = sceneFile ? sceneFile.buffer : ffFile!.buffer;
      const rawSceneMime = sceneFile ? (sceneFile.mimetype || 'image/jpeg') : (ffFile!.mimetype || 'image/jpeg');

      // Identity Lock Step 2: Rebuild First Frame if required
      let approvedFirstFrameBuf = rawSceneBuf;
      let approvedFirstFrameMime = rawSceneMime;
      let rebuildExecuted = false;

      if (sourceMode === 'IDENTITY_REBUILD_REQUIRED') {
        const rebuildResult = await IdentityLockService.rebuildFirstFrame({
          ai,
          imageModelName: models.imageModel || 'gemini-3.1-flash-image',
          sceneImageBuffer: rawSceneBuf,
          sceneMimeType: rawSceneMime,
          identitySpec,
          masterBuffers,
          masterMimeTypes,
          sceneMode,
          userPrompt: rawUserPrompt || compiledPrompt,
          imageIsTargetCharacter,
        });
        approvedFirstFrameBuf = Buffer.from(await rebuildResult.candidateFirstFrame.blob.arrayBuffer());
        approvedFirstFrameMime = rebuildResult.candidateFirstFrame.mimeType;
        rebuildExecuted = rebuildResult.rebuildExecuted;
      }

      // First frame local rules inspection
      const ffCheck = FirstFrameChecker.checkBuffer(approvedFirstFrameBuf, approvedFirstFrameMime);
      if (!ffCheck.valid) {
        return res.status(400).json({ error: ffCheck.errors.join('; ') });
      }

      // Identity Lock Step 3: Evaluate First Frame Identity Gate
      // Use the complete uploaded identity pack (up to 4 masters), not only masterBuffers[0].
      const gateResult = await IdentityLockService.evaluateIdentityGate({
        ai,
        analysisModel: session.analysisModel || 'gemini-3.6-flash',
        masterImageBuffer: masterBuffers[0],
        masterMimeType: masterMimeTypes[0],
        masterImageBuffers: masterBuffers,
        masterMimeTypes,
        sceneImageBuffer: rawSceneBuf,
        sceneMimeType: rawSceneMime,
        candidateBuffer: approvedFirstFrameBuf,
        candidateMimeType: approvedFirstFrameMime,
        identitySpec,
        sceneMode,
        imageIsTargetCharacter,
        manualApproved,
      });

      if (!gateResult.canStartVeo) {
        console.warn(`[Video Start] 拒绝启动 Veo: Identity Gate 未通过 (status: ${gateResult.status}, score: ${gateResult.identityQaScore})`);
        const isReview = gateResult.status === 'review';
        const failureReason = isReview ? 'identity_qa_review_required' : 'identity_qa_failed';
        const httpStatus = isReview ? 422 : 400;
        const errObj = createStructuredError({
          source: 'internal_api',
          failureStage: 'submit',
          httpStatus,
          customUserMessage: isReview
            ? '角色一致性处于人工复核区间 (REVIEW)，需要明确人工批准后方可提交 Veo 渲染。'
            : '角色一致性质检未通过 (Identity QA failed)，拒绝启动 Veo 渲染。',
          endpointPathRedacted: '/api/videos/start',
        });

        return res.status(httpStatus).json({
          accepted: false,
          serverPersisted: false,
          status: 'failed',
          submissionState: 'not_submitted',
          failureReason,
          error: errObj.userMessage,
          qaReport: gateResult.identityQaReport,
          firstFrameIdentityQaStatus: gateResult.status,
          identityQaScore: gateResult.identityQaScore,
          identityCriticalIssues: gateResult.identityCriticalIssues,
          requiresManualApproval: isReview,
          predictLongRunningCalls: 0,
          structuredError: errObj,
        });
      }

      // Identity Lock Step 4: Prepare Motion-First I2V submission
      const submissionPrep = IdentityLockService.prepareI2VSubmission({
        userPrompt: compiledPrompt || rawUserPrompt,
        durationSeconds,
        cameraPreset,
        identityGatePassed: gateResult.canStartVeo,
      });

      const firstFrameHash = crypto.createHash('sha256').update(approvedFirstFrameBuf).digest('hex');
      const promptHash = crypto.createHash('sha256').update(normalizedPrompt).digest('hex');

      const idempotencyKey = crypto.createHash('sha256').update([
        characterId || 'no_char',
        firstFrameHash,
        promptHash,
        durationSeconds,
        models.videoModel,
        resolution,
      ].join('_')).digest('hex');



      const taskId = req.body.taskId || `vtask_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const now = Date.now();
      const providerStorageTaskKey = DurableVideoRetryService.getAttemptTaskKey(taskId, 1);
      const expectedProviderStorageUri = resolveVeoStorageUri(providerStorageTaskKey);

      // Persist QA anchors before the provider call. Cloud Run memory/local files are never
      // accepted as post-generation identity evidence.
      const qaApprovedFirstFrameObjectPath = `veo/${taskId}/qa/approved-first-frame`;
      await gcsArtifactStore.uploadImageArtifact({
        objectPath: qaApprovedFirstFrameObjectPath,
        buffer: approvedFirstFrameBuf,
        contentType: approvedFirstFrameMime,
      });

      const qaMasterImageObjectPaths: string[] = [];
      for (let i = 0; i < masterBuffers.slice(0, 3).length; i++) {
        const objectPath = `veo/${taskId}/qa/master-${i}`;
        await gcsArtifactStore.uploadImageArtifact({
          objectPath,
          buffer: masterBuffers[i],
          contentType: masterMimeTypes[i] || 'image/jpeg',
        });
        qaMasterImageObjectPaths.push(objectPath);
      }

      const sceneImgBuf = sceneFile ? sceneFile.buffer : approvedFirstFrameBuf;
      const sceneImgMime = sceneFile ? (sceneFile.mimetype || 'image/jpeg') : approvedFirstFrameMime;
      const sceneImageUrl = saveImageBufferToFile(taskId, sceneImgBuf, sceneImgMime);
      const initialLeaseOwner = process.env.K_REVISION || process.env.K_SERVICE || `pid_${process.pid}`;
      const initialExecutionId = `exec_${crypto.randomUUID()}`;
      const initialLeaseStartedAt = Date.now();
      const initialLeaseExpiresAt = initialLeaseStartedAt + 180000;

      const taskRecord: ServerVideoTaskRecord = {
        id: taskId,
        taskId,
        sceneImageUrl,
        status: 'preparing',
        modelId: models.videoModel,
        projectId: session.projectId || 'xp-vertex-project',
        region: session.region || session.location || 'us-central1',
        durationSeconds,
        aspectRatio,
        resolution,
        generateAudio,
        firstFrameHash,
        promptHash,
        submitHttpStatus: null,
        pollHttpStatus: null,
        pollAttempt: 0,
        createdAt: now,
        updatedAt: now,
        idempotencyKey,
        rawUserPrompt,
        compiledPrompt,
        veoSafePrompt: PromptCompiler.normalizeForVeo(compiledPrompt, rawUserPrompt, { durationSeconds, hasPerson: true }),
        promptCompilerVersion,
        motionIntensity,
        visualStyle,
        cameraPreset,
        schemaVersion: 'v1.1-stable',
        connectionId,
        sceneMode: sceneMode || 'animate_existing_character',
        characterId,
        characterDescription,
        identitySpec,
        identitySourceMode: sourceMode,
        firstFrameIdentityQaStatus: gateResult.status,
        identityQaScore: gateResult.identityQaScore,
        identityCriticalIssues: gateResult.identityCriticalIssues,
        identityQaStatus: 'not_run',
        providerAttempt: 1,
        providerStorageTaskKey,
        expectedProviderStorageUri,
        providerStorageIntentPersistedAt: now,
        executionId: initialExecutionId,
        leaseOwner: initialLeaseOwner,
        leaseExpiresAt: initialLeaseExpiresAt,
        heartbeatAt: initialLeaseStartedAt,
        attempt: 1,
        maxAttempts: 3,
        stateVersion: 1,
        statusVersion: 1,
        qaAttempt: 1,
        retryCount: 0,
        retrySubmissionState: 'none',
        retryHistory: [],
        artifactHistory: [],
        qaApprovedFirstFrameObjectPath,
        qaApprovedFirstFrameMimeType: approvedFirstFrameMime,
        qaMasterImageObjectPaths,
        qaMasterImageMimeTypes: masterMimeTypes.slice(0, qaMasterImageObjectPaths.length),
      };

      // Ensure task creation in Firestore before invoking background Veo execution
      if (!firestoreTaskRepository.isAvailable()) {
        console.warn('[Firestore Task Creation] Firestore unavailable.');
        const errObj = createStructuredError({
          source: 'internal_api',
          failureStage: 'submit',
          httpStatus: 503,
          customUserMessage: '存储服务 (Firestore) 当前不可用，无法创建视频生成任务。',
          endpointPathRedacted: '/api/videos/start',
        });
        return res.status(503).json({
          accepted: false,
          serverPersisted: false,
          storageAuthority: 'unavailable',
          taskId,
          status: 'failed',
          submissionState: 'not_submitted',
          error: '存储服务不可用',
          structuredError: errObj,
        });
      }

      try {
        taskRecord.evidenceSource = 'firestore';
        // Task creation, provider admission, and the initial execution lease commit in one
        // Firestore transaction. There is no post-create lease-acquisition gap.
        await firestoreTaskRepository.createTask(taskRecord);
      } catch (fsErr: any) {
        console.error('[Firestore Task Creation Error]:', fsErr);
        const errStr = String(fsErr?.message || fsErr);

        // createTask uses Firestore create() semantics. If another instance won the
        // same taskId race, return the authoritative existing task instead of invoking Veo twice.
        const alreadyExists = fsErr?.code === 6 || fsErr?.code === 'ALREADY_EXISTS' || /already exists/i.test(errStr);
        if (alreadyExists) {
          const existing = await firestoreTaskRepository.getTask(taskId).catch(() => null);
          if (existing) {
            serverVideoTaskStore.set(taskId, existing);
            return res.json({
              accepted: true,
              serverPersisted: true,
              taskId: existing.taskId,
              status: existing.status,
              submissionState: existing.status === 'preparing'
                ? 'reserved'
                : existing.status === 'submission_outcome_unknown'
                  ? 'outcome_unknown'
                  : existing.operationName
                    ? 'submitted'
                    : existing.status === 'submitting'
                      ? 'submitting'
                      : 'not_submitted',
              operationNamePresent: Boolean(existing.operationName),
              isIdempotentReuse: true,
              createdAt: existing.createdAt,
              updatedAt: existing.updatedAt,
              engine: existing.modelId,
              operationName: existing.operationName,
              videoDataUrl: existing.videoDataUrl,
            });
          }
        }
        const admissionBusy = fsErr?.code === 'PROVIDER_ADMISSION_BUSY';
        if (admissionBusy) {
          const artifactBucket = getVeoBucketName();
          const orphanQaPaths = [qaApprovedFirstFrameObjectPath, ...qaMasterImageObjectPaths];
          await Promise.all(orphanQaPaths.map((objectPath) =>
            gcsArtifactStore.deleteVideoArtifact(artifactBucket, objectPath).catch(() => false)
          ));
          const errObj = createStructuredError({
            source: 'internal_api',
            failureStage: 'submit',
            httpStatus: 409,
            customUserMessage: '当前已有视频任务占用 Veo 生成槽位。为避免重复提交或重复扣费，请先等待该任务进入完成、失败或人工审核状态。',
            endpointPathRedacted: '/api/videos/start',
          });
          return res.status(409).json({
            accepted: false,
            serverPersisted: false,
            status: 'failed',
            submissionState: 'not_submitted',
            failureReason: 'provider_admission_busy',
            blockingTaskId: fsErr?.blockingTaskId,
            blockingStatus: fsErr?.blockingStatus,
            predictLongRunningCalls: 0,
            error: errObj.userMessage,
            structuredError: errObj,
          });
        }

        const isQuotaOrTransient =
          fsErr?.code === 8 ||
          fsErr?.code === 14 ||
          fsErr?.code === 'RESOURCE_EXHAUSTED' ||
          fsErr?.code === 'UNAVAILABLE' ||
          errStr.includes('RESOURCE_EXHAUSTED') ||
          errStr.includes('Quota') ||
          errStr.includes('UNAVAILABLE');

        const httpStatus = isQuotaOrTransient ? 503 : 500;
        const errObj = createStructuredError({
          source: 'internal_api',
          failureStage: 'submit',
          httpStatus,
          customUserMessage: `Firestore 任务持久化失败 (${fsErr?.message || fsErr})，视频生成流程已安全终止。`,
          endpointPathRedacted: '/api/videos/start',
        });

        return res.status(httpStatus).json({
          accepted: false,
          serverPersisted: false,
          storageAuthority: getStorageAuthority(),
          taskId,
          status: 'failed',
          submissionState: 'not_submitted',
          error: isQuotaOrTransient ? '存储服务不可用或超额 (Firestore error)' : 'Firestore 任务持久化失败',
          structuredError: errObj,
        });
      }

      serverVideoTaskStore.set(taskId, taskRecord);
      saveTasksToDisk(serverVideoTaskStore);

      // P0-5: Provider submission is part of the request durability boundary.
      // Do not rely on fire-and-forget work after a Cloud Run HTTP response. The request
      // waits only until the provider operation/result is durably persisted; long-running
      // generation remains asynchronous and is resumed through polling/recovery.
      await (async () => {
        let finalVeoPrompt = submissionPrep.compiledMotionPrompt || PromptCompiler.compileI2VMotionPrompt({
          userMotionPrompt: normalizedPrompt,
          durationSeconds,
          cameraPreset,
        });
        if (/[\u4e00-\u9fa5]/.test(finalVeoPrompt)) {
          try {
            const cleanPrompt = PromptCompiler.cleanUserMotionPrompt(finalVeoPrompt);
            const translationRes = await callWithRetry(
              () =>
                ai.models.generateContent({
                  model: session.analysisModel || 'gemini-2.5-flash',
                  contents: [
                    {
                      role: 'user',
                      parts: [
                        {
                          text: `Translate and refine the following Chinese video motion prompt into a concise, safe, positive English motion description suitable for Google Veo 3.1 video generation model.
Rules:
1. Output ONLY a single line of safe, positive English text describing character motion, facial expression, or camera movement. No markdown, no quotes, no explanations.
2. Filter out any sensitive, explicit, anatomical, or policy-violating words (avoid terms related to body parts, clothing removal, or extreme actions).
3. Keep key motion and atmospheric details: duration ${durationSeconds}s, character actions, lighting, camera framing.

Chinese Prompt:
${cleanPrompt}`
                        }
                      ]
                    }
                  ]
                }),
              { actionName: 'Veo 提示词中译英', maxRetries: 2, initialDelayMs: 2000 }
            );
            const englishPrompt = translationRes.text?.trim().replace(/^["'“‘`]+|["'”’`]+$/g, '');
            if (englishPrompt && englishPrompt.length > 10) {
              finalVeoPrompt = englishPrompt;
              console.log(`[Veo Prompt Auto-Translated]: ${cleanPrompt.slice(0, 50)}... -> ${finalVeoPrompt}`);
            }
          } catch (err) {
            console.warn('[Veo Prompt Translation Failed, falling back to original]:', err);
          }
        }

        try {
          const authorizedTask = await taskStateMachineService.authorizeProviderSubmission({
            taskId,
            executionId: taskRecord.executionId!,
            providerStorageTaskKey,
            expectedProviderStorageUri,
          });
          Object.assign(taskRecord, authorizedTask);
          serverVideoTaskStore.set(taskId, authorizedTask);
        } catch (authorizationErr: any) {
          const message = `Provider 调用授权失败，Veo 未被调用: ${authorizationErr?.message || authorizationErr}`;
          console.error(`[Pre-Provider Authorization Failed] Task ${taskId}:`, authorizationErr);
          const failedTask = await taskStateMachineService.failPreparingBeforeProvider({
            taskId,
            executionId: taskRecord.executionId!,
            message,
          }).catch(() => null);
          if (failedTask) serverVideoTaskStore.set(taskId, failedTask);
          return;
        }

        console.log(`[Video Start] Durable Provider authorization committed; invoking Veo (taskId: ${taskId}, 时长: ${durationSeconds}s, 模型: ${models.videoModel})...`);

        try {
          const submitTimeoutMs = 120000;
          const startResult = await Promise.race([
            VideoGenerator.startVideoGeneration(
              ai,
              session,
              models.videoModel,
              approvedFirstFrameBuf,
              approvedFirstFrameMime,
              masterBuffers,
              masterMimeTypes,
              finalVeoPrompt,
              identitySpec,
              undefined,
              '',
              sceneMode,
              characterDescription,
              durationSeconds,
              taskId,
              expectedProviderStorageUri
            ),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('云端视频模型提交接口响应超时 (120s)，请检查 API 配额或算力连接后重试。')), submitTimeoutMs)
            )
          ]);

          const rec = serverVideoTaskStore.get(taskId);
          if (!rec) return;

          rec.submitHttpStatus = 200;
          rec.updatedAt = Date.now();

          if (startResult.videoBuffer) {
            try {
              const artifactMeta = await gcsArtifactStore.uploadVideoArtifact({
                taskId,
                videoBuffer: startResult.videoBuffer,
                contentType: 'video/mp4',
              });
              ephemeralVideoStore.set(taskId, startResult.videoBuffer);
              const settledTask = await settlePersistedVideoThroughQa({
                taskId,
                videoBuffer: startResult.videoBuffer,
                artifactMeta,
                session,
                ai,
                analysisModel: session.analysisModel || 'gemini-3.6-flash',
                patch: {
                  diagnostics: startResult.diagnostics,
                  submitHttpStatus: 200,
                },
              });
              serverVideoTaskStore.set(taskId, settledTask);
              await taskStateMachineService.releaseLease(taskId, taskRecord.executionId);
              console.log(`[Video Start Sync Settled] Task ${taskId} => ${settledTask.status} after durable video QA`);
              return;
            } catch (persistErr: any) {
              console.error(`[Video Start GCS/QA Error] Task ${taskId}:`, persistErr);
              const errObj = createStructuredError({
                source: 'artifact_persist',
                failureStage: 'artifact_persist',
                httpStatus: 500,
                customUserMessage: `视频生成成功但持久化或进入 QA 失败: ${persistErr?.message || persistErr}`,
                endpointPathRedacted: '/api/videos/start',
              });
              const updates: Partial<ServerVideoTaskRecord> = {
                status: 'artifact_persist_failed',
                artifactPersisted: false,
                error: `视频产物持久化失败: ${persistErr?.message || persistErr}`,
                structuredError: errObj,
                updatedAt: Date.now(),
              };
              if (firestoreTaskRepository.isAvailable()) await safeUpdateTaskRecord(taskId, updates);
              return;
            }
          }

          if (startResult.operationName) {
            const submitted = await safeUpdateTaskRecord(taskId, {
              status: 'submitted',
              operationName: startResult.operationName,
              diagnostics: startResult.diagnostics,
              submitHttpStatus: 200,
            });
            await safeUpdateTaskRecord(taskId, {
              status: 'polling',
              operationName: startResult.operationName,
              diagnostics: startResult.diagnostics,
              submitHttpStatus: 200,
              stateVersion: submitted.stateVersion,
            });
            await taskStateMachineService.releaseLease(taskId, taskRecord.executionId);
            console.log(`[Video Start Success] 任务 ${taskId} 成功获取 OperationName: ${startResult.operationName}`);
            return;
          }

          const updates: Partial<ServerVideoTaskRecord> = {
            status: 'submission_outcome_unknown',
            error: '云端返回响应但未能获取到有效 Operation Name，提单状态未知。',
            submitHttpStatus: 200,
          };
          if (firestoreTaskRepository.isAvailable()) {
            await safeUpdateTaskRecord(taskId, updates);
          } else {
            Object.assign(rec, updates);
            serverVideoTaskStore.set(taskId, rec);
            saveTasksToDisk(serverVideoTaskStore);
          }
        } catch (invokeErr: any) {
          console.error(`[Video Start Failed] Task ${taskId} 提交失败:`, invokeErr);
          const rec = serverVideoTaskStore.get(taskId);
          if (rec) {
            const httpStatus = invokeErr?.httpStatus || 500;
            const rawSubmitError = String(invokeErr?.message || invokeErr || '');
            const definitiveHttpStatuses = new Set([400, 401, 403, 404, 409, 422, 429]);
            const isAmbiguousSubmitFailure =
              !definitiveHttpStatuses.has(Number(invokeErr?.httpStatus)) &&
              /(响应超时|timeout|timed out|ECONNRESET|socket hang up|fetch failed|network error|connection reset|aborted)/i.test(rawSubmitError);

            const errObj = createStructuredError({
              source: 'vertex_submit',
              failureStage: 'submit',
              httpStatus: isAmbiguousSubmitFailure ? 504 : httpStatus,
              rawError: invokeErr,
              customUserMessage: isAmbiguousSubmitFailure
                ? 'Veo 提交请求的结果无法确认。为避免重复扣费，系统已阻止新的 Veo 提交；请先核实或清理该未知任务。'
                : undefined,
              endpointPathRedacted: '/api/videos/start',
            });
            const updates: Partial<ServerVideoTaskRecord> = isAmbiguousSubmitFailure
              ? {
                  status: 'submission_outcome_unknown',
                  failureReason: 'submission_outcome_unknown' as any,
                  retryMode: 'NO_RETRY',
                  error: 'Veo 提交结果未知，禁止自动或直接重新生成，以避免重复扣费。',
                  structuredError: errObj,
                  submitHttpStatus: null,
                }
              : {
                  status: 'failed',
                  error: invokeErr?.message || errObj.userMessage || '提单被云端明确拒绝或失败，可安全重试。',
                  structuredError: errObj,
                  submitHttpStatus: httpStatus,
                };
            if (firestoreTaskRepository.isAvailable()) {
              await safeUpdateTaskRecord(taskId, updates);
            } else {
              Object.assign(rec, updates);
              serverVideoTaskStore.set(taskId, rec);
              saveTasksToDisk(serverVideoTaskStore);
            }
            if (taskRecord.executionId) {
              await taskStateMachineService.releaseLease(taskId, taskRecord.executionId).catch(() => false);
            }
          }
        }
      })();

      // Return only after the provider submission outcome has been durably recorded.
      const durableTask = await firestoreTaskRepository.getTask(taskId);
      return res.json({
        accepted: durableTask?.status !== 'failed',
        serverPersisted: true,
        taskId,
        status: durableTask?.status || 'preparing',
        submissionState: durableTask?.status === 'submission_outcome_unknown'
          ? 'outcome_unknown'
          : durableTask?.operationName
            ? 'submitted'
            : durableTask?.status === 'submitting'
              ? 'submitting'
              : durableTask?.status === 'preparing'
                ? 'reserved'
                : 'not_submitted',
        operationNamePresent: Boolean(durableTask?.operationName),
        operationName: durableTask?.operationName,
        isIdempotentReuse: false,
        createdAt: durableTask?.createdAt || taskRecord.createdAt,
        updatedAt: durableTask?.updatedAt || taskRecord.updatedAt,
        engine: durableTask?.modelId || models.videoModel,
        videoDataUrl: durableTask?.videoDataUrl,
        artifactPersisted: durableTask?.artifactPersisted,
        qaReport: durableTask?.qaReport,
        identityQaStatus: durableTask?.identityQaStatus,
        requiresManualApproval: durableTask?.status === 'qa_pending' && durableTask?.identityQaStatus === 'review',
      });
    } catch (err: unknown) {
      const httpStatus = (err as any)?.httpStatus || 500;
      const source = (err as any)?.source || 'vertex_submit';
      const failureStage = (err as any)?.failureStage || 'submit';
      const errObj = createStructuredError({
        source,
        failureStage,
        httpStatus,
        rawError: err,
        endpointPathRedacted: '/api/videos/start',
      });

      // A process-memory record is never durable evidence. If Firestore persistence failed,
      // report serverPersisted=false rather than manufacturing a local authoritative task.
      const serverPersisted = false;

      return res.status(httpStatus).json({
        accepted: false,
        serverPersisted,
        taskId: req.body?.taskId || null,
        status: 'failed',
        submissionState: 'not_submitted',
        operationNamePresent: false,
        isIdempotentReuse: false,
        error: errObj.userMessage || '启动视频生成任务失败',
        structuredError: errObj,
      });
    }
  });

  // Video Task List Endpoint for Task History Page Syncing
  app.get('/api/videos/list', async (req, res) => {
    try {
      const connectionId = req.headers['x-connection-id'] as string;
      const now = Date.now();
      let hasUpdates = false;

      if (!firestoreTaskRepository.isAvailable()) {
        const errObj = createStructuredError({
          source: 'internal_api',
          failureStage: 'internal_api',
          httpStatus: 503,
          customUserMessage: '存储服务不可用 (Firestore unavailable)。无法获取任务列表。',
          endpointPathRedacted: '/api/videos/list',
        });
        return res.status(503).json({
          tasks: [],
          storageAuthority: 'unavailable',
          error: '存储服务不可用',
          structuredError: errObj,
        });
      }

      let tasksFromStore: ServerVideoTaskRecord[] = [];
      try {
        const limitParam = parseInt(req.query.limit as string, 10);
        const fetchLimit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(100, limitParam) : 20;
        tasksFromStore = await firestoreTaskRepository.listTasks(fetchLimit);
        for (const t of tasksFromStore) {
          serverVideoTaskStore.set(t.taskId || t.id, t);
        }
      } catch (fsErr: any) {
        console.warn('[Firestore listTasks Error]:', fsErr?.message || fsErr);
        const errStr = String(fsErr?.message || fsErr);
        const isTransient = fsErr?.code === 14 || fsErr?.code === 'UNAVAILABLE' || fsErr?.code === 8 || fsErr?.code === 'RESOURCE_EXHAUSTED' || errStr.includes('UNAVAILABLE') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('Quota') || errStr.includes('timeout');
        const httpCode = isTransient ? 503 : 500;
        const errObj = createStructuredError({
          source: 'internal_api',
          failureStage: 'internal_api',
          httpStatus: httpCode,
          customUserMessage: `Firestore 读取任务列表失败: ${fsErr?.message || fsErr}`,
          endpointPathRedacted: '/api/videos/list',
        });
        return res.status(httpCode).json({
          tasks: [],
          storageAuthority: 'firestore',
          error: '存储服务读取异常',
          structuredError: errObj,
        });
      }

      for (let i = 0; i < tasksFromStore.length; i++) {
        const candidate = tasksFromStore[i];
        if (candidate?.status !== 'preparing') continue;
        try {
          const reconciled = await taskStateMachineService.reconcileStalePreparingTask({
            taskId: candidate.taskId || candidate.id,
            now,
          });
          tasksFromStore[i] = reconciled.task;
          serverVideoTaskStore.set(reconciled.task.taskId || reconciled.task.id, reconciled.task);
          if (reconciled.failed) hasUpdates = true;
        } catch (prepErr) {
          console.warn('[Pre-Provider Preparing Reconcile Warning]:', prepErr);
        }
      }

      const tasks = tasksFromStore
        .filter((rec) => {
          if (!rec) return false;
          if (connectionId && rec.connectionId) {
            return rec.connectionId === connectionId;
          }
          return true;
        })
        .map((rec) => {
          // A missing operation after the request durability window is ambiguous, not a
          // proven provider rejection. Keep admission fail-closed to prevent duplicate cost.
          const isStuckWithoutOpName = rec.status === 'submitting' && !rec.operationName && (now - rec.createdAt) > 30000;
          const isKnownOperationTimedOut = Boolean(rec.operationName)
            && (rec.status === 'polling' || (rec.status as string) === 'submitted')
            && (now - rec.createdAt) > 1800000;

          if (isStuckWithoutOpName) {
            rec.status = 'submission_outcome_unknown';
            rec.failureReason = 'submission_outcome_unknown' as any;
            rec.retryMode = 'NO_RETRY';
            rec.error = 'Veo 提交结果未知，已阻止新的 Veo 提交，以避免重复扣费。';
            rec.structuredError = createStructuredError({
              source: 'vertex_submit',
              failureStage: 'submit',
              httpStatus: 504,
              customUserMessage: 'Veo 提交结果未知，已阻止新的 Veo 提交；请先核实或清理该任务。',
              endpointPathRedacted: '/api/videos/list',
            });
            rec.updatedAt = now;
            hasUpdates = true;
            firestoreTaskRepository.updateTask(rec.taskId || rec.id, {
              status: 'submission_outcome_unknown',
              failureReason: rec.failureReason,
              retryMode: 'NO_RETRY',
              error: rec.error,
              structuredError: rec.structuredError,
              updatedAt: now,
            }).catch(() => {});
          } else if (isKnownOperationTimedOut) {
            rec.status = 'polling_timeout';
            rec.failureReason = 'polling_timeout';
            rec.retryMode = 'RETRY_POLL';
            rec.error = 'Veo 长任务轮询超时，但已有 Operation Name，保留任务并继续阻止新的 Veo 提交。';
            rec.structuredError = createStructuredError({
              source: 'vertex_polling',
              failureStage: 'polling',
              httpStatus: 504,
              customUserMessage: '云端长任务轮询超时，但 Provider Operation 已存在。请继续恢复/轮询该 Operation，禁止直接重新生成。',
              endpointPathRedacted: '/api/videos/list',
            });
            rec.updatedAt = now;
            hasUpdates = true;
            firestoreTaskRepository.updateTask(rec.taskId || rec.id, {
              status: 'polling_timeout',
              failureReason: 'polling_timeout',
              retryMode: 'RETRY_POLL',
              error: rec.error,
              structuredError: rec.structuredError,
              updatedAt: now,
            }).catch(() => {});
          }

          const isCompletedWithoutVideo = rec.status === 'completed' && !rec.videoDataUrl;
          const effectiveStatus = isCompletedWithoutVideo ? 'failed' : rec.status;

          let effectiveFailureReason = rec.failureReason;
          let effectiveRetryMode = rec.retryMode;
          let userMsg: string | null = null;

          if (effectiveStatus === 'failed') {
            if (isCompletedWithoutVideo) {
              const isRai = rec.failureReason === 'output_rai_filtered' || rec.failureReason === 'input_safety_blocked';
              effectiveFailureReason = isRai ? rec.failureReason : 'artifact_missing';
              effectiveRetryMode = isRai ? 'REWRITE_INPUT_THEN_REGENERATE' : 'RETRY_DOWNLOAD';
              userMsg = isRai
                ? 'Google安全过滤未返回视频，请调整输入图片或动作描述后重新生成。'
                : '云端任务已完成，但视频文件尚未成功持久化，正在恢复已有产物。';
            } else {
              effectiveFailureReason = rec.failureReason || rec.structuredError?.failureReason || 'unknown';
              effectiveRetryMode = rec.retryMode || rec.structuredError?.retryMode || 'SAFE_TO_REGENERATE';
              userMsg = rec.structuredError?.userMessage || (typeof rec.error === 'string' ? rec.error : null) || (effectiveFailureReason === 'output_rai_filtered' ? 'Google安全过滤未返回视频，请调整输入图片或动作描述后重新生成。' : '视频生成未成功完成');
            }
          }

          const techMsg = rec.structuredError?.technicalMessageRedacted || (typeof rec.error === 'string' ? rec.error : null);

          return {
            id: rec.id || rec.taskId,
            taskId: rec.taskId,
            characterId: rec.characterId || '',
            characterName: rec.characterName || '默认虚拟角色',
            sceneMode: rec.sceneMode || 'animate_existing_character',
            sceneImageUrl: rec.sceneImageUrl || null,
            userPromptChinese: rec.rawUserPrompt || rec.compiledPrompt || '8s 动效视频生成',
            normalizedPromptEnglish: rec.compiledPrompt || rec.rawUserPrompt || '',
            veoSafePrompt: rec.veoSafePrompt || null,
            failureReason: effectiveFailureReason || null,
            retryMode: effectiveRetryMode || null,
            status: effectiveStatus,
            progressStage: effectiveStatus === 'completed'
              ? '视频生成完成'
              : effectiveStatus === 'failed'
              ? (userMsg || '视频生成未成功完成')
              : effectiveStatus === 'preparing'
                ? '准备提交 Veo（尚未调用 Provider）'
                : '云端渲染中...',
            progressPercent: effectiveStatus === 'completed' ? 100 : effectiveStatus === 'failed' ? 0 : effectiveStatus === 'preparing' ? 20 : 75,
            resultVideoUrl: rec.videoDataUrl || null,
            videoUri: rec.videoUri || null,
            outputUri: rec.outputUri || null,
            projectId: rec.projectId || null,
            region: rec.region || null,
            externalOperationName: rec.operationName || null,
            error: effectiveStatus === 'failed' ? {
              code: rec.structuredError?.source?.toUpperCase() || 'SERVER_FAILED',
              stage: rec.structuredError?.failureStage || 'polling',
              failureReason: effectiveFailureReason,
              retryMode: effectiveRetryMode,
              messageChinese: userMsg || '视频生成未成功完成',
              technicalMessageRedacted: techMsg || 'Veo 渲染未输出视频数据',
              httpStatus: rec.structuredError?.httpStatus || 400,
              googleStatus: rec.structuredError?.googleStatus || null,
              googleReason: rec.structuredError?.googleReason || null,
              retryable: effectiveRetryMode !== 'NO_RETRY',
              recommendedAction: effectiveRetryMode === 'REWRITE_INPUT_THEN_REGENERATE'
                ? '请修改提示词或更换图片后重试'
                : '请在下方点击【重试】',
            } : null,
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt,
            settings: {
              aspectRatio: rec.aspectRatio || '9:16',
              durationSeconds: rec.durationSeconds || 8,
              resolution: rec.resolution || '720p',
            }
          };
        })
        .sort((a, b) => b.createdAt - a.createdAt);

      if (hasUpdates) {
        saveTasksToDisk(serverVideoTaskStore);
      }

      res.json({
        tasks,
        storageAuthority: getStorageAuthority(),
      });
    } catch (err) {
      console.error('Failed to list video tasks:', err);
      res.status(500).json({ error: '获取视频任务列表失败' });
    }
  });

  // Delete Single Video Task Endpoint
  app.delete('/api/videos/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      if (!taskId) {
        return res.status(400).json({ error: 'taskId 为必填项' });
      }
      if (!firestoreTaskRepository.isAvailable()) {
        return res.status(503).json({
          success: false,
          storageAuthority: 'unavailable',
          error: 'Firestore unavailable; task deletion was not performed.',
        });
      }

      const existingTask = await firestoreTaskRepository.getTask(taskId);
      if (!existingTask) {
        return res.json({ success: true, deleted: false, deletedTaskId: taskId, storageAuthority: 'firestore' });
      }

      if (!isProviderTaskDeletionSafe(existingTask)) {
        const errObj = createStructuredError({
          source: 'internal_api',
          failureStage: 'internal_api',
          httpStatus: 409,
          customUserMessage: '当前任务仍可能占用 Veo Provider，禁止删除。请先恢复或核实 Provider Operation，避免释放算力槽后发生重复提交或重复扣费。',
          endpointPathRedacted: '/api/videos/:taskId',
        });
        return res.status(409).json({
          success: false,
          deleted: false,
          failureReason: 'provider_task_delete_blocked',
          taskId,
          status: existingTask.status,
          operationNamePresent: Boolean(existingTask.operationName),
          retryMode: existingTask.retryMode || 'NO_RETRY',
          storageAuthority: 'firestore',
          error: errObj.userMessage,
          structuredError: errObj,
        });
      }

      const deleted = await firestoreTaskRepository.deleteTask(taskId);
      if (deleted) {
        serverVideoTaskStore.delete(taskId);
        ephemeralVideoStore.delete(taskId);
        ephemeralImageStore.delete(taskId);
      }
      return res.json({ success: true, deleted, deletedTaskId: taskId, storageAuthority: 'firestore' });
    } catch (err) {
      console.error('Failed to delete video task:', err);
      return res.status(500).json({ error: '删除视频任务失败', storageAuthority: 'firestore' });
    }
  });

  // Clear All Failed Tasks Endpoint
  app.post('/api/videos/clear-failed', async (req, res) => {
    try {
      if (!firestoreTaskRepository.isAvailable()) {
        return res.status(503).json({
          success: false,
          storageAuthority: 'unavailable',
          error: 'Firestore unavailable; no tasks were deleted.',
        });
      }

      const connectionId = req.headers['x-connection-id'] as string;
      const tasks = await firestoreTaskRepository.listTasks(100);
      let deletedCount = 0;
      let protectedCount = 0;
      for (const rec of tasks) {
        const matchesConnection = !connectionId || !rec.connectionId || rec.connectionId === connectionId;
        const isFailedOrStuck = rec.status === 'failed' ||
          rec.status === 'artifact_persist_failed' ||
          (rec.status as string) === 'submit_failed_safe_to_retry' ||
          (rec.status as string) === 'orphaned_local_task';
        if (!matchesConnection || !isFailedOrStuck) continue;
        if (!isProviderTaskDeletionSafe(rec)) {
          protectedCount++;
          continue;
        }

        if (await firestoreTaskRepository.deleteTask(rec.taskId || rec.id)) {
          serverVideoTaskStore.delete(rec.taskId || rec.id);
          ephemeralVideoStore.delete(rec.taskId || rec.id);
          ephemeralImageStore.delete(rec.taskId || rec.id);
          deletedCount++;
        }
      }

      return res.json({ success: true, deletedCount, protectedCount, storageAuthority: 'firestore' });
    } catch (err) {
      console.error('Failed to clear failed video tasks:', err);
      return res.status(500).json({ error: '清空失败任务失败', storageAuthority: 'firestore' });
    }
  });

  // Task Recovery Endpoint
  app.post('/api/videos/recover-task', async (req, res) => {
    try {
      const { taskId, operationName, modelId, durationSeconds } = req.body;
      if (!taskId || !operationName) {
        return res.status(400).json({ error: 'taskId 与 operationName 为必填项' });
      }
      const operationNameString = String(operationName).trim();
      const operationNameLooksValid = operationNameString.length <= 2048
        && !/\s/.test(operationNameString)
        && /(^|\/)operations\/[^/]+$/.test(operationNameString);
      if (!operationNameLooksValid) {
        return res.status(400).json({
          success: false,
          failureReason: 'provider_operation_name_invalid',
          error: 'operationName 格式无效，必须是 Provider 返回的完整 Operation Name。',
        });
      }
      if (!firestoreTaskRepository.isAvailable()) {
        return res.status(503).json({
          success: false,
          storageAuthority: 'unavailable',
          error: 'Firestore unavailable; recovery record was not created.',
        });
      }

      const connectionId = req.headers['x-connection-id'] as string;
      const session = CredentialService.getSession(connectionId);
      if (!session) {
        return res.status(401).json({
          success: false,
          failureReason: 'compute_session_unavailable',
          error: '算力连接已失效，无法核实 Provider Operation。',
        });
      }

      const existing = await firestoreTaskRepository.getTask(taskId);
      if (existing && existing.status !== 'submission_outcome_unknown') {
        serverVideoTaskStore.set(taskId, existing);
        return res.json({
          success: true,
          providerVerified: false,
          message: '任务已在 Firestore 持久化存储中，未修改现有 Provider 状态',
          task: existing,
          storageAuthority: 'firestore',
        });
      }

      // An operationName supplied by a client is not evidence by itself. Reuse the
      // production Provider polling path: a successful read proves that this operation
      // exists and is accessible with the active/reconstructed credential session.
      const ai = await GeminiClientFactory.getClientForSession(session);
      let verification: Awaited<ReturnType<typeof VideoGenerator.pollVeoOperation>>;
      try {
        verification = await VideoGenerator.pollVeoOperation(ai, session, operationNameString);
      } catch (verifyErr: any) {
        const errObj = createStructuredError({
          source: 'vertex_polling',
          failureStage: 'polling',
          httpStatus: 422,
          rawError: verifyErr,
          customUserMessage: '无法核实该 Provider Operation；任务保持 submission_outcome_unknown，未释放算力槽，也未发起新的 Veo 生成。',
          endpointPathRedacted: '/api/videos/recover-task',
        });
        return res.status(422).json({
          success: false,
          providerVerified: false,
          failureReason: 'provider_operation_not_verified',
          status: existing?.status || 'not_found',
          storageAuthority: 'firestore',
          error: errObj.userMessage,
          structuredError: errObj,
        });
      }

      const expectedStoragePrefix = resolveVeoStorageUri(taskId);
      const linkage = evaluateProviderOperationLinkage({
        taskId,
        operationDone: Boolean(verification.done),
        videoUri: verification.videoUri,
        expectedStoragePrefix,
      });
      if (!linkage.proven) {
        const isStillRunning = linkage.reason === 'operation_still_running';
        const errObj = createStructuredError({
          source: 'vertex_polling',
          failureStage: 'polling',
          httpStatus: isStillRunning ? 409 : 422,
          customUserMessage: isStillRunning
            ? 'Provider Operation 已核实存在，但尚未完成，当前无法证明它属于该 unknown task。任务继续保持锁定；待 Operation 完成后再次恢复。'
            : 'Provider Operation 存在，但其输出无法证明属于该 taskId。任务继续保持 submission_outcome_unknown，未释放算力槽。',
          endpointPathRedacted: '/api/videos/recover-task',
        });
        return res.status(isStillRunning ? 409 : 422).json({
          success: false,
          providerVerified: true,
          providerTaskLinked: false,
          failureReason: 'provider_operation_linkage_not_proven',
          linkageReason: linkage.reason,
          expectedStoragePrefix,
          status: existing?.status || 'not_found',
          storageAuthority: 'firestore',
          error: errObj.userMessage,
          structuredError: errObj,
        });
      }

      if (existing && existing.status === 'submission_outcome_unknown') {
        const reconciled = await taskStateMachineService.transitionTask({
          taskId,
          toStatus: 'polling',
          expectedStateVersion: existing.stateVersion ?? existing.statusVersion ?? 1,
          patch: {
            operationName: operationNameString,
            retryMode: 'RETRY_POLL',
            failureReason: null as any,
            error: null as any,
            structuredError: null as any,
            submitHttpStatus: existing.submitHttpStatus ?? 200,
            pollHttpStatus: 200,
            pollAttempt: (existing.pollAttempt || 0) + 1,
            executionId: null as any,
            leaseOwner: null as any,
            leaseExpiresAt: null as any,
            heartbeatAt: null as any,
          },
        });
        serverVideoTaskStore.set(taskId, reconciled);
        return res.json({
          success: true,
          providerVerified: true,
          providerTaskLinked: true,
          providerDone: Boolean(verification.done),
          message: '已绑定经 GCS task 专属输出证明的 Provider Operation，并恢复现有任务轮询；未发起新的 Veo 生成。',
          task: reconciled,
          storageAuthority: 'firestore',
        });
      }

      const now = Date.now();
      const recoveredRecord: ServerVideoTaskRecord = {
        id: taskId,
        taskId,
        operationName: operationNameString,
        status: 'polling',
        modelId: modelId || session.videoModel || 'veo-3.1-fast-generate-001',
        projectId: session.projectId,
        region: session.region || session.location || 'us-central1',
        connectionId: session.connectionId,
        durationSeconds: Number(durationSeconds) || 4,
        aspectRatio: '9:16',
        resolution: '720p',
        generateAudio: false,
        submitHttpStatus: 200,
        pollHttpStatus: 200,
        pollAttempt: 1,
        createdAt: now - 10000,
        updatedAt: now,
        evidenceSource: 'firestore',
      };

      await firestoreTaskRepository.createTask(recoveredRecord);
      serverVideoTaskStore.set(taskId, recoveredRecord);
      return res.json({
        success: true,
        providerVerified: true,
        providerTaskLinked: true,
        providerDone: Boolean(verification.done),
        message: '已通过 GCS task 专属输出核实 Provider Operation，并安全初始化 Firestore 恢复任务；未发起新的 Veo 生成。',
        task: recoveredRecord,
        storageAuthority: 'firestore',
      });
    } catch (err: any) {
      console.error('Failed to recover video task:', err);
      const isAdmissionBusy = err?.code === 'PROVIDER_ADMISSION_BUSY';
      return res.status(isAdmissionBusy ? 409 : 500).json({
        success: false,
        storageAuthority: 'firestore',
        failureReason: isAdmissionBusy ? 'provider_admission_busy' : 'recovery_failed',
        blockingTaskId: isAdmissionBusy ? err?.blockingTaskId : undefined,
        blockingStatus: isAdmissionBusy ? err?.blockingStatus : undefined,
        error: err?.message || '恢复视频任务失败',
      });
    }
  });

  // Debug endpoint for task store inspection
  app.get('/api/videos/debug-store', async (_req, res) => {
    if (!firestoreTaskRepository.isAvailable()) {
      return res.status(503).json({
        storageAuthority: 'unavailable',
        evidenceSource: 'unavailable',
        memoryCacheEnabled: true,
        memoryCacheCount: serverVideoTaskStore.size,
        count: 0,
        tasks: [],
        error: 'Firestore unavailable; memory cache is intentionally not returned as authoritative evidence.',
      });
    }

    try {
      const tasksFromStore = await firestoreTaskRepository.listTasks(100);
      for (const task of tasksFromStore) {
        serverVideoTaskStore.set(task.taskId || task.id, task);
      }
      const tasks = tasksFromStore.map((rec) => ({
        id: rec.id || rec.taskId,
        connectionId: rec.connectionId,
        status: rec.status,
        operationName: rec.operationName || null,
        modelId: rec.modelId,
        durationSeconds: rec.durationSeconds,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        idempotencyKey: rec.idempotencyKey || null,
        error: rec.error || null,
        evidenceSource: 'firestore',
      }));
      return res.json({
        storageAuthority: 'firestore',
        memoryCacheEnabled: true,
        memoryCacheCount: serverVideoTaskStore.size,
        count: tasks.length,
        tasks,
      });
    } catch (err: any) {
      return res.status(503).json({
        storageAuthority: 'firestore',
        evidenceSource: 'firestore',
        count: 0,
        tasks: [],
        error: err?.message || 'Firestore diagnostic read failed.',
      });
    }
  });

  // Task Audit Endpoint (Read-only System & Task Audit)
  app.get('/api/videos/audit', async (_req, res) => {
    const kService = process.env.K_SERVICE || 'not_deployed';
    const kRevision = process.env.K_REVISION || 'not_deployed';
    const buildVersion = '9.0.0-v9.0-cinema';
    const schemaVersion = 'v2.0-stable';

    const isDeployedService0804 = kService === 'service-0804' && kRevision !== 'not_deployed';
    const disclaimer = !isDeployedService0804
      ? '以下结果仅来自构建或预览环境，不能代表service-0804线上任务。'
      : null;

    if (!firestoreTaskRepository.isAvailable()) {
      const errObj = createStructuredError({
        source: 'internal_api',
        failureStage: 'internal_api',
        httpStatus: 503,
        customUserMessage: '存储服务不可用 (Firestore unavailable)。无法进行审计查询。',
        endpointPathRedacted: '/api/videos/audit',
      });
      return res.status(503).json({
        K_SERVICE: kService,
        K_REVISION: kRevision,
        buildVersion,
        schemaVersion,
        evidenceSource: 'unavailable',
        storageAuthority: 'unavailable',
        memoryCacheEnabled: true,
        disclaimer,
        taskCount: 0,
        tasks: [],
        error: '存储服务不可用',
        structuredError: errObj,
      });
    }

    const storageAuthority = getStorageAuthority();
    const globalEvidenceSource = 'firestore';

    let tasksFromStore: ServerVideoTaskRecord[] = [];
    try {
      tasksFromStore = await firestoreTaskRepository.listTasks(100);
      for (const t of tasksFromStore) {
        serverVideoTaskStore.set(t.taskId || t.id, t);
      }
    } catch (fsErr: any) {
      console.warn('[Firestore Audit listTasks Error]:', fsErr?.message || fsErr);
      const errStr = String(fsErr?.message || fsErr);
      const isTransient = fsErr?.code === 14 || fsErr?.code === 'UNAVAILABLE' || fsErr?.code === 8 || fsErr?.code === 'RESOURCE_EXHAUSTED' || errStr.includes('UNAVAILABLE') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('Quota') || errStr.includes('timeout');
      const httpCode = isTransient ? 503 : 500;
      const errObj = createStructuredError({
        source: 'internal_api',
        failureStage: 'internal_api',
        httpStatus: httpCode,
        customUserMessage: `Firestore 读取审计任务失败: ${fsErr?.message || fsErr}`,
        endpointPathRedacted: '/api/videos/audit',
      });
      return res.status(httpCode).json({
        K_SERVICE: kService,
        K_REVISION: kRevision,
        buildVersion,
        schemaVersion,
        evidenceSource: 'firestore',
        storageAuthority: 'firestore',
        memoryCacheEnabled: true,
        disclaimer,
        taskCount: 0,
        tasks: [],
        error: '存储服务读取异常',
        structuredError: errObj,
      });
    }

    const tasks = tasksFromStore.map((rec) => {
      const createdAtEpochMs = Number(rec.createdAt) || Date.now();
      const dateObj = new Date(createdAtEpochMs);
      const createdAtUtcIso = dateObj.toISOString();
      const createdAtLocalIso = dateObj.toISOString();

      const pollAttempt = Number(rec.pollAttempt) || 0;
      const hasOperationName = Boolean(rec.operationName);

      // Enforce lastPolledAt = null if pollAttempt === 0
      const lastPolledAt = pollAttempt > 0 ? (rec.lastPolledAt || rec.updatedAt || null) : null;

      // Enforce status mapping
      let mappedStatus: AuditTaskStatus = rec.status as AuditTaskStatus;
      if ((rec.status as string) === 'processing' || (rec.status as string) === 'submitted' || (rec.status as string) === 'draft') {
        mappedStatus = 'polling';
      } else if ((rec.status as string) === 'submit_failed_safe_to_retry') {
        mappedStatus = 'failed';
      }

      // Enforce submissionState mapping
      let submissionState: TaskSubmissionState = 'not_submitted';
      if (mappedStatus === 'polling' || mappedStatus === 'polling_timeout' || mappedStatus === 'completed') {
        submissionState = 'submitted';
      } else if (mappedStatus === 'submitting') {
        submissionState = 'submitting';
      } else if (mappedStatus === 'validating' || mappedStatus === 'preparing') {
        submissionState = 'reserved';
      } else if (mappedStatus === 'submission_outcome_unknown') {
        submissionState = 'outcome_unknown';
      } else if (mappedStatus === 'failed') {
        submissionState = hasOperationName ? 'submitted' : 'not_submitted';
      } else if (mappedStatus === 'orphaned_local_task') {
        submissionState = 'not_submitted';
      }

      // Enforce RAI fields (must be null if no upstream response received)
      const hasGoogleResponse = Boolean(rec.submitHttpStatus || rec.pollHttpStatus || rec.operationName);
      const raiMediaFilteredCount = hasGoogleResponse && rec.raiMediaFilteredCount !== undefined ? rec.raiMediaFilteredCount : null;
      const raiStatus = hasGoogleResponse && rec.raiStatus ? rec.raiStatus : 'unknown';

      return {
        taskId: rec.taskId || rec.id,
        createdAtEpochMs,
        createdAtUtcIso,
        createdAtLocalIso,
        status: mappedStatus,
        submissionState,
        idempotencyKeyPrefix: rec.idempotencyKey ? rec.idempotencyKey.slice(0, 8) : null,
        operationNamePresent: hasOperationName,
        operationNamePrefix: hasOperationName && rec.operationName ? (rec.operationName.slice(0, 24) + '...') : null,
        pollAttempt,
        lastPolledAt,
        lastSubmitAttemptAt: rec.lastSubmitAttemptAt || rec.createdAt || null,
        submitTimedOutAt: rec.submitTimedOutAt || (mappedStatus === 'submission_outcome_unknown' ? rec.updatedAt : null),
        upstreamEndpoint: rec.upstreamEndpoint || (hasOperationName ? `${rec.region || 'us-central1'}-aiplatform.googleapis.com` : null),
        upstreamHttpStatus: rec.submitHttpStatus || rec.pollHttpStatus || null,
        upstreamErrorCode: rec.upstreamErrorCode || rec.structuredError?.source || null,
        upstreamErrorMessage: rec.upstreamErrorMessage || rec.error || null,
        raiMediaFilteredCount,
        raiStatus,
        outputBucket: rec.outputBucket || null,
        outputObjectPath: rec.outputObjectPath || null,
        artifactPersisted: Boolean(rec.artifactPersisted),
        evidenceSource: rec.evidenceSource || 'firestore',
        K_REVISION: kRevision,
      };
    });

    const storageConfig = assertProductionStorageConfig();
    const expectedVeoOutputBucket = storageConfig.expectedBucket;
    const environmentVeoOutputBucket = storageConfig.environmentBucket;
    const effectiveVeoOutputBucket = storageConfig.effectiveBucket;
    const bucketDriftDetected = storageConfig.bucketDriftDetected;
    const storageConfigValid = storageConfig.valid;
    const resolvedStorageUriPrefix = storageConfigValid ? `gs://${effectiveVeoOutputBucket}/veo/` : null;
    const storageConfigSource = bucketDriftDetected
      ? 'drift_rejected'
      : (process.env.VEO_OUTPUT_BUCKET ? 'env' : 'missing');

    return res.json({
      K_SERVICE: kService,
      K_REVISION: kRevision,
      buildVersion,
      schemaVersion,
      evidenceSource: globalEvidenceSource,
      storageAuthority,
      artifactAuthority: 'cloud_storage',
      expectedVeoOutputBucket,
      environmentVeoOutputBucket,
      effectiveVeoOutputBucket,
      bucketDriftDetected,
      storageConfigValid,
      resolvedStorageUriPrefix,
      storageConfigSource,
      VEO_OUTPUT_BUCKET: effectiveVeoOutputBucket || null,
      veoOutputBucket: effectiveVeoOutputBucket || null,
      gcsEnabled: storageConfigValid,
      memoryCacheEnabled: true,
      disclaimer,
      taskCount: tasks.length,
      tasks,
    });
  });

  // Async Video Task Status Query Endpoint
  app.get('/api/videos/status/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      if (!firestoreTaskRepository.isAvailable()) {
        const errObj = createStructuredError({
          source: 'internal_api',
          failureStage: 'internal_api',
          httpStatus: 503,
          customUserMessage: '存储服务不可用 (Firestore unavailable)。无法查询任务状态。',
          endpointPathRedacted: `/api/videos/status/${taskId}`,
        });
        return res.status(503).json({
          storageAuthority: 'unavailable',
          status: 'failed',
          error: '存储服务不可用',
          structuredError: errObj,
        });
      }

      let record: ServerVideoTaskRecord | null = null;
      try {
        record = await firestoreTaskRepository.getTask(taskId);
      } catch (fsErr: any) {
        console.error(`[Firestore Status Query Error] Task ${taskId}:`, fsErr);
        const errStr = String(fsErr?.message || fsErr);
        const isTransient = fsErr?.code === 14 || fsErr?.code === 'UNAVAILABLE' || fsErr?.code === 8 || fsErr?.code === 'RESOURCE_EXHAUSTED' || errStr.includes('UNAVAILABLE') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('Quota') || errStr.includes('timeout');
        const httpCode = isTransient ? 503 : 500;
        const errObj = createStructuredError({
          source: 'internal_api',
          failureStage: 'internal_api',
          httpStatus: httpCode,
          customUserMessage: `Firestore 读取任务状态失败: ${fsErr?.message || fsErr}`,
          endpointPathRedacted: `/api/videos/status/${taskId}`,
        });
        return res.status(httpCode).json({
          storageAuthority: 'firestore',
          status: 'failed',
          error: '存储服务读取异常',
          structuredError: errObj,
        });
      }

      if (!record) {
        const errObj = createStructuredError({
          source: 'internal_api',
          failureStage: 'internal_api',
          httpStatus: 404,
          customUserMessage: '视频生成任务不存在或已失效。',
          endpointPathRedacted: `/api/videos/status/${taskId}`,
        });
        return res.status(404).json(errObj);
      }

      // Update memory cache with authority record from Firestore
      serverVideoTaskStore.set(taskId, record);

      if (record.status === 'preparing') {
        const reconciled = await taskStateMachineService.reconcileStalePreparingTask({ taskId });
        record = reconciled.task;
        serverVideoTaskStore.set(taskId, record);
        if (record.status === 'preparing') {
          return res.json({
            status: 'preparing',
            submissionState: 'reserved',
            providerInvocationAuthorized: false,
            progressStage: '准备提交 Veo（尚未调用 Provider）',
            elapsedSeconds: Math.floor((Date.now() - record.createdAt) / 1000),
          });
        }
      }

      if (record.status === 'qa_pending') {
        if (
          record.identityQaStatus === 'review' ||
          record.automaticRetryPlan?.action === 'MANUAL_REVIEW'
        ) {
          return res.json({
            status: 'qa_pending',
            videoDataUrl: record.videoDataUrl || `/api/videos/stream/${taskId}`,
            sizeBytes: record.sizeBytes,
            durationSeconds: record.durationSeconds,
            qaReport: record.qaReport,
            identityQaStatus: 'review',
            requiresManualApproval: true,
            reviewActions: ['accepted', 'rejected'],
            humanReviewDecision: record.humanReviewDecision,
            humanReviewRecord: record.humanReviewRecord,
            stateVersion: record.stateVersion,
            automaticRetryPlan: record.automaticRetryPlan,
            retryHistory: record.retryHistory,
            artifactPersisted: true,
          });
        }

        const qaConnectionId = (req.headers['x-connection-id'] as string) || record.connectionId;
        const qaSession = CredentialService.getSession(qaConnectionId);
        if (!qaSession) {
          return res.json({
            status: 'qa_pending',
            videoDataUrl: record.videoDataUrl || `/api/videos/stream/${taskId}`,
            qaReport: record.qaReport,
            identityQaStatus: record.identityQaStatus || 'not_run',
            requiresConnection: true,
            artifactPersisted: true,
          });
        }

        const qaVideoBuffer = await gcsArtifactStore.fetchArtifactBuffer(
          record.outputBucket!,
          record.outputObjectPath!,
          { session: qaSession }
        );
        const qaAi = await GeminiClientFactory.getClientForSession(qaSession);
        const settled = await settlePersistedVideoThroughQa({
          taskId,
          videoBuffer: qaVideoBuffer,
          artifactMeta: {
            outputBucket: record.outputBucket!,
            outputObjectPath: record.outputObjectPath!,
            videoUri: record.videoUri!,
            sizeBytes: record.sizeBytes || qaVideoBuffer.length,
            contentType: record.contentType || 'video/mp4',
            artifactPersistedAt: record.artifactPersistedAt || Date.now(),
          },
          session: qaSession,
          ai: qaAi,
          analysisModel: qaSession.analysisModel || 'gemini-3.6-flash',
          patch: { pollAttempt: record.pollAttempt, pollHttpStatus: record.pollHttpStatus },
        });
        serverVideoTaskStore.set(taskId, settled);
        return res.json({
          status: settled.status,
          videoDataUrl: settled.videoDataUrl || `/api/videos/stream/${taskId}`,
          sizeBytes: settled.sizeBytes,
          durationSeconds: settled.durationSeconds,
          qaReport: settled.qaReport,
          identityQaStatus: settled.identityQaStatus,
          requiresManualApproval: settled.status === 'qa_pending' && settled.identityQaStatus === 'review',
          artifactPersisted: settled.artifactPersisted,
          diagnostics: settled.diagnostics,
          automaticRetryPlan: settled.automaticRetryPlan,
          retryHistory: settled.retryHistory,
        });
      }

      if (record.status === 'completed') {
        return res.json({
          status: 'completed',
          videoDataUrl: record.videoDataUrl,
          sizeBytes: record.sizeBytes,
          durationSeconds: record.durationSeconds,
          qaReport: record.qaReport,
          diagnostics: record.diagnostics,
        });
      }

      if (record.status === 'failed') {
        if (record.failureReason === 'pre_provider_abandoned' || record.failureReason === 'pre_provider_authorization_failed') {
          return res.json({
            status: 'failed',
            submissionState: 'not_submitted',
            providerInvocationAuthorized: false,
            failureReason: record.failureReason,
            retryMode: record.retryMode || 'SAFE_TO_REGENERATE',
            error: record.error,
            structuredError: record.structuredError,
          });
        }
        const force = req.query.force === 'true' || req.query.forceQuery === 'true' || req.query.retry === 'true';
        if (!force || !record.operationName) {
          const errObj = createStructuredError({
            source: 'vertex_polling',
            failureStage: 'polling',
            httpStatus: 500,
            customUserMessage: record.error || '视频生成任务已失败。',
            endpointPathRedacted: `/api/videos/status/${taskId}`,
          });
          return res.json({
            status: 'failed',
            error: record.error || '视频生成失败',
            structuredError: errObj,
          });
        }
      }

      if (
        record.status === 'generating' &&
        record.retrySubmissionState === 'reserved' &&
        !record.operationName
      ) {
        const reconciled = await taskStateMachineService.reconcileStaleAutomaticRetryReservation({ taskId });
        record = reconciled.task;
        serverVideoTaskStore.set(taskId, record);
        if (reconciled.reclaimed) {
          return res.json({
            status: record.status,
            submissionState: 'not_submitted',
            providerInvocationAuthorized: false,
            failureReason: record.failureReason,
            retryMode: record.retryMode,
            error: record.error,
            structuredError: record.structuredError,
          });
        }
      }

      if (
        record.status === 'generating' &&
        !record.operationName &&
        record.retryProviderAuthorizedAt &&
        record.retryProviderAuthorizedIdempotencyKey === record.providerRetryIdempotencyKey
      ) {
        const authorizedAgeMs = Date.now() - record.retryProviderAuthorizedAt;
        if (authorizedAgeMs > 180000) {
          const unknown = await taskStateMachineService.markAutomaticRetryOutcomeUnknown({
            taskId,
            idempotencyKey: record.providerRetryIdempotencyKey || 'missing',
            message: 'AUTOMATIC_RETRY_AUTHORIZATION_STALE: retry crossed the durable Provider authorization boundary but no submission result was persisted; refusing automatic resubmission.',
          });
          return res.json({
            status: unknown.status,
            error: unknown.error,
            structuredError: unknown.structuredError,
            failureReason: unknown.failureReason,
            retryMode: unknown.retryMode,
          });
        }
      }

      if (record.status === 'submission_outcome_unknown') {
        return res.json({
          status: 'submission_outcome_unknown',
          error: record.error,
          structuredError: record.structuredError,
          providerAttempt: record.providerAttempt,
          automaticRetryPlan: record.automaticRetryPlan,
          retryHistory: record.retryHistory,
          requiresManualReview: true,
        });
      }

      if (record.status === 'submitting' || !record.operationName) {
        return res.json({
          status: 'submitting',
          progressStage: '正在向云端提交视频渲染引擎...',
          elapsedSeconds: Math.floor((Date.now() - record.createdAt) / 1000),
          pollAttempt: record.pollAttempt,
        });
      }

      record.pollAttempt = (record.pollAttempt || 0) + 1;

      // Query status from Veo Operation once
      const connectionId = (req.headers['x-connection-id'] as string) || record.connectionId;
      const session = CredentialService.getSession(connectionId);
      if (!session) {
        const errObj = createStructuredError({
          source: 'authentication',
          failureStage: 'internal_api',
          httpStatus: 401,
          customUserMessage: '算力连接已失效，请重新连接算力服务。',
          endpointPathRedacted: `/api/videos/status/${taskId}`,
        });
        return res.status(401).json(errObj);
      }

      // If videoUri is already recorded from a completed cloud operation, try directly re-fetching video stream first
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
