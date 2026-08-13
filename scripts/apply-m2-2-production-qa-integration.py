from pathlib import Path
import re

SERVER = Path('server.ts')
STATE = Path('src/server/services/taskStateMachineService.ts')
TYPES = Path('src/types/index.ts')
STUDIO = Path('src/pages/StudioPage.tsx')

server = SERVER.read_text()
state = STATE.read_text()
types = TYPES.read_text()
studio = STUDIO.read_text()

# ---------------------------------------------------------------------------
# Types: persist QA anchors so post-generation QA survives Cloud Run restarts.
# ---------------------------------------------------------------------------
anchor = """  // M2-2 Video QA fields\n  identityQaStatus?: VideoIdentityQaStatus;\n  identityQaReport?: any;\n  identityFrameScores?: number[];\n  identityDriftDetected?: boolean;\n  worstFrameTimestamp?: number | null;\n"""
replacement = anchor + """  qaApprovedFirstFrameObjectPath?: string;\n  qaApprovedFirstFrameMimeType?: string;\n  qaMasterImageObjectPaths?: string[];\n  qaMasterImageMimeTypes?: string[];\n  characterDescription?: string;\n"""
if 'qaApprovedFirstFrameObjectPath?: string;' not in types:
    if anchor not in types:
        raise SystemExit('types anchor not found')
    types = types.replace(anchor, replacement, 1)

# ---------------------------------------------------------------------------
# State machine: add artifact->qa_pending and strict QA->completed boundaries.
# ---------------------------------------------------------------------------
methods_anchor = "  private async finalizeExistingArtifact("
if 'public async persistArtifactForQa(' not in state:
    methods = r'''  public async persistArtifactForQa(params: {
    taskId: string;
    outputBucket: string;
    outputObjectPath: string;
    videoUri: string;
    sizeBytes?: number;
    contentType?: string;
    artifactPersistedAt?: number;
    patch?: Partial<ServerVideoTaskRecord>;
  }): Promise<ServerVideoTaskRecord> {
    const {
      taskId,
      outputBucket,
      outputObjectPath,
      videoUri,
      sizeBytes,
      contentType = 'video/mp4',
      artifactPersistedAt = Date.now(),
      patch = {},
    } = params;

    const advance = async (toStatus: TaskStatus, transitionPatch: Partial<ServerVideoTaskRecord> = {}) =>
      await this.transitionTask({ taskId, toStatus, patch: transitionPatch });

    let task = await firestoreTaskRepository.getTask(taskId);
    if (!task) throw new Error(`[TaskStateMachine] Task ${taskId} not found while persisting artifact for QA.`);

    if (task.status === 'completed') {
      if (task.artifactPersisted !== true || !task.outputBucket || !task.outputObjectPath || !task.videoUri) {
        throw new Error(`[TaskStateMachine] Completed task ${taskId} violates artifact invariant.`);
      }
      return task;
    }

    if (task.status === 'created') task = await advance('preparing');
    if (task.status === 'preparing' || task.status === 'submitting' || task.status === 'submitted') {
      task = await advance('generating');
    }
    if (task.status === 'polling_timeout') task = await advance('polling');
    if (task.status === 'generating' || task.status === 'polling') {
      task = await advance('generation_succeeded');
    }
    if (task.status === 'generation_succeeded' || task.status === 'artifact_persist_failed') {
      task = await advance('artifact_persisting');
    }
    if (task.status === 'artifact_persisting') {
      task = await advance('artifact_persisted', {
        ...patch,
        outputBucket,
        outputObjectPath,
        videoUri,
        sizeBytes,
        contentType,
        artifactPersisted: true,
        artifactPersistedAt,
        videoDataUrl: `/api/videos/stream/${taskId}`,
      });
    }
    if (task.status === 'artifact_persisted') {
      task = await advance('qa_pending', {
        ...patch,
        outputBucket,
        outputObjectPath,
        videoUri,
        sizeBytes,
        contentType,
        artifactPersisted: true,
        artifactPersistedAt,
        identityQaStatus: patch.identityQaStatus || 'not_run',
      });
    }
    if (task.status === 'qa_pending') {
      task = await this.transitionTask({
        taskId,
        toStatus: 'qa_pending',
        patch: {
          ...patch,
          outputBucket,
          outputObjectPath,
          videoUri,
          sizeBytes,
          contentType,
          artifactPersisted: true,
          artifactPersistedAt,
        },
      });
    }

    if (task.status !== 'qa_pending') {
      throw new Error(`[TaskStateMachine] Task ${taskId} cannot enter QA from state ${task.status}.`);
    }
    return task;
  }

  public async completeAfterQa(params: {
    taskId: string;
    qaReport: any;
    patch?: Partial<ServerVideoTaskRecord>;
  }): Promise<ServerVideoTaskRecord> {
    const { taskId, qaReport, patch = {} } = params;
    const task = await firestoreTaskRepository.getTask(taskId);
    if (!task) throw new Error(`[TaskStateMachine] Task ${taskId} not found while completing after QA.`);

    if (task.status === 'completed') {
      if (task.artifactPersisted !== true || !task.outputBucket || !task.outputObjectPath || !task.videoUri) {
        throw new Error(`[TaskStateMachine] Completed task ${taskId} violates artifact invariant.`);
      }
      return task;
    }

    if (task.status !== 'qa_pending') {
      throw new Error(`[TaskStateMachine] Task ${taskId} must be qa_pending before QA completion; got ${task.status}.`);
    }
    if (task.artifactPersisted !== true || !task.outputBucket || !task.outputObjectPath || !task.videoUri) {
      throw new Error(`[TaskStateMachine] Task ${taskId} cannot complete QA without persisted artifact authority.`);
    }
    if (!qaReport || qaReport.pass !== true || qaReport.gateStatus !== 'pass') {
      throw new Error(`[TaskStateMachine] Task ${taskId} cannot complete without a PASS video identity QA report.`);
    }

    return await this.transitionTask({
      taskId,
      toStatus: 'completed',
      patch: {
        ...patch,
        qaReport,
        identityQaReport: qaReport,
        identityQaStatus: 'pass',
        identityFrameScores: Array.isArray(qaReport.frameReports)
          ? qaReport.frameReports.map((frame: any) => frame.identityScore)
          : [],
        identityDriftDetected: Boolean(qaReport.identityDriftDetected),
        worstFrameTimestamp: qaReport.worstFrameTimestamp ?? null,
        completedAt: Date.now(),
        videoDataUrl: `/api/videos/stream/${taskId}`,
      },
    });
  }

'''
    if methods_anchor not in state:
        raise SystemExit('state methods anchor not found')
    state = state.replace(methods_anchor, methods + methods_anchor, 1)

# Startup recovery may recover artifact authority, but must not certify QA by itself.
state = re.sub(
    r"\n\s*if \(status === 'qa_pending'\) \{\n\s*await this\.transitionTask\(\{\n\s*taskId: task\.taskId,\n\s*toStatus: 'completed',.*?\n\s*\}\);\n\s*\}\n",
    "\n",
    state,
    count=1,
    flags=re.S,
)

# ---------------------------------------------------------------------------
# Server imports + canonical durable QA settlement helper.
# ---------------------------------------------------------------------------
if "DurableVideoIdentityQaService" not in server:
    server = server.replace(
        "import { VideoInspector } from './src/services/video/videoInspector';\n",
        "import { VideoInspector } from './src/services/video/videoInspector';\nimport { DurableVideoIdentityQaService } from './src/server/services/durableVideoIdentityQaService';\n",
        1,
    )

helper_anchor = "export const serverVideoTaskStore = new Map<string, ServerVideoTaskRecord>();\n"
if 'async function settlePersistedVideoThroughQa(' not in server:
    helper = r'''

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
    const qaError = {
      code: 'VIDEO_IDENTITY_QA_EXECUTION_FAILED',
      message: qaErr?.message || String(qaErr),
      stage: 'qa_video',
      retryable: true,
      timestamp: Date.now(),
    };
    return await taskStateMachineService.transitionTask({
      taskId,
      toStatus: 'qa_pending',
      patch: {
        structuredError: qaError,
        error: qaError.message,
        identityQaStatus: 'not_run',
      },
    });
  }

  if (qaReport.gateStatus === 'pass') {
    return await taskStateMachineService.completeAfterQa({
      taskId,
      qaReport,
      patch,
    });
  }

  const commonQaPatch: Partial<ServerVideoTaskRecord> = {
    ...patch,
    qaReport,
    identityQaReport: qaReport,
    identityQaStatus: qaReport.gateStatus,
    identityFrameScores: qaReport.frameReports.map((frame) => frame.identityScore),
    identityDriftDetected: qaReport.identityDriftDetected,
    worstFrameTimestamp: qaReport.worstFrameTimestamp,
  };

  if (qaReport.gateStatus === 'review') {
    return await taskStateMachineService.transitionTask({
      taskId,
      toStatus: 'qa_pending',
      patch: commonQaPatch,
    });
  }

  return await taskStateMachineService.transitionTask({
    taskId,
    toStatus: 'failed',
    patch: {
      ...commonQaPatch,
      failureReason: 'artifact_invalid',
      retryMode: 'SAFE_TO_REGENERATE',
      error: `视频身份一致性质检失败: ${qaReport.summary}`,
      structuredError: {
        code: 'VIDEO_IDENTITY_QA_FAILED',
        message: qaReport.summary,
        stage: 'qa_video',
        retryable: true,
        timestamp: Date.now(),
        details: {
          minimumIdentityScore: qaReport.minimumIdentityScore,
          worstFrameTimestamp: qaReport.worstFrameTimestamp,
        },
      },
    },
  });
}
'''
    if helper_anchor not in server:
        raise SystemExit('server helper anchor not found')
    server = server.replace(helper_anchor, helper_anchor + helper, 1)

# Direct images still require master QA; eliminate misleading no-master direct logging.
server = server.replace(
    "      if (masterBuffers.length === 0) {\n        console.log(`[Video Start] 未提交单独角色母板图，以首帧原图直通模式运行 (sceneMode: ${sceneMode || 'animate_existing_character'})`);\n      }\n",
    "",
)

# All production identity modes require at least one master, because rebuild bypass != QA bypass.
server = server.replace(
    "      // Fail-closed Rule B: If rebuild is required, at least 1 master image must exist\n      if (sourceMode === 'IDENTITY_REBUILD_REQUIRED' && masterBuffers.length === 0) {",
    "      // M2-1/M2-2 fail closed: every identity mode requires at least one durable master reference.\n      if (masterBuffers.length === 0) {",
    1,
)
server = server.replace(
    "未提供目标角色母板图 (master image)，且当前图像未标记为确认目标角色图，无法进行角色重建与质检。",
    "未提供目标角色母板图 (master image)，无法执行强制角色身份质检。",
    1,
)

# Persist approved first frame + master QA anchors to GCS before provider submission.
anchor = """      const taskId = req.body.taskId || `vtask_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;\n      const now = Date.now();\n\n      const sceneImgBuf = sceneFile ? sceneFile.buffer : approvedFirstFrameBuf;\n"""
if 'qaApprovedFirstFrameObjectPath' not in server:
    insert = """      const taskId = req.body.taskId || `vtask_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;\n      const now = Date.now();\n\n      // Persist QA anchors before the provider call. Cloud Run memory/local files are never\n      // accepted as post-generation identity evidence.\n      const qaApprovedFirstFrameObjectPath = `veo/${taskId}/qa/approved-first-frame`;\n      await gcsArtifactStore.uploadImageArtifact({\n        objectPath: qaApprovedFirstFrameObjectPath,\n        buffer: approvedFirstFrameBuf,\n        contentType: approvedFirstFrameMime,\n      });\n\n      const qaMasterImageObjectPaths: string[] = [];\n      for (let i = 0; i < masterBuffers.slice(0, 3).length; i++) {\n        const objectPath = `veo/${taskId}/qa/master-${i}`;\n        await gcsArtifactStore.uploadImageArtifact({\n          objectPath,\n          buffer: masterBuffers[i],\n          contentType: masterMimeTypes[i] || 'image/jpeg',\n        });\n        qaMasterImageObjectPaths.push(objectPath);\n      }\n\n      const sceneImgBuf = sceneFile ? sceneFile.buffer : approvedFirstFrameBuf;\n"""
    if anchor not in server:
        raise SystemExit('server taskId anchor not found')
    server = server.replace(anchor, insert, 1)

# Add durable identity/QA metadata to Firestore task record.
record_anchor = """        connectionId,\n        sceneMode: sceneMode || 'animate_existing_character',\n      };\n"""
if 'qaMasterImageObjectPaths,' not in server:
    record_replacement = """        connectionId,\n        sceneMode: sceneMode || 'animate_existing_character',\n        characterId,\n        characterDescription,\n        identitySpec,\n        identitySourceMode: sourceMode,\n        firstFrameIdentityQaStatus: gateResult.status,\n        identityQaScore: gateResult.identityQaScore,\n        identityCriticalIssues: gateResult.identityCriticalIssues,\n        identityQaStatus: 'not_run',\n        qaApprovedFirstFrameObjectPath,\n        qaApprovedFirstFrameMimeType: approvedFirstFrameMime,\n        qaMasterImageObjectPaths,\n        qaMasterImageMimeTypes: masterMimeTypes.slice(0, qaMasterImageObjectPaths.length),\n      };\n"""
    if record_anchor not in server:
        raise SystemExit('server task record anchor not found')
    server = server.replace(record_anchor, record_replacement, 1)

# Sync-return video path: persist -> qa_pending -> real QA -> terminal only on PASS/FAIL.
sync_pattern = re.compile(
    r"          if \(startResult\.videoBuffer\) \{.*?\n          \}\n\n          if \(startResult\.operationName\) \{",
    re.S,
)
sync_replacement = r'''          if (startResult.videoBuffer) {
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

          if (startResult.operationName) {'''
server2, count = sync_pattern.subn(sync_replacement, server, count=1)
if count != 1:
    raise SystemExit('server sync completion block not found')
server = server2

# Enrich /start response with actual durable QA state.
server = server.replace(
    """        videoDataUrl: durableTask?.videoDataUrl,\n        artifactPersisted: durableTask?.artifactPersisted,\n      });\n""",
    """        videoDataUrl: durableTask?.videoDataUrl,\n        artifactPersisted: durableTask?.artifactPersisted,\n        qaReport: durableTask?.qaReport,\n        identityQaStatus: durableTask?.identityQaStatus,\n        requiresManualApproval: durableTask?.status === 'qa_pending' && durableTask?.identityQaStatus === 'review',\n      });\n""",
    1,
)

# Existing completeWithPersistedArtifact server calls must never certify post-generation QA.
server = server.replace(
    'taskStateMachineService.completeWithPersistedArtifact(',
    'taskStateMachineService.persistArtifactForQa(',
)

# When a task is already qa_pending, run/reuse durable QA before any provider polling branch.
status_anchor = """      // Update memory cache with authority record from Firestore\n      serverVideoTaskStore.set(taskId, record);\n\n      if (record.status === 'completed') {\n"""
if 'record.status === \'qa_pending\'' not in server:
    status_insert = """      // Update memory cache with authority record from Firestore\n      serverVideoTaskStore.set(taskId, record);\n\n      if (record.status === 'qa_pending') {\n        if (record.identityQaStatus === 'review') {\n          return res.json({\n            status: 'qa_pending',\n            videoDataUrl: record.videoDataUrl || `/api/videos/stream/${taskId}`,\n            sizeBytes: record.sizeBytes,\n            durationSeconds: record.durationSeconds,\n            qaReport: record.qaReport,\n            identityQaStatus: 'review',\n            requiresManualApproval: true,\n            artifactPersisted: true,\n          });\n        }\n\n        const qaConnectionId = (req.headers['x-connection-id'] as string) || record.connectionId;\n        const qaSession = CredentialService.getSession(qaConnectionId);\n        if (!qaSession) {\n          return res.json({\n            status: 'qa_pending',\n            videoDataUrl: record.videoDataUrl || `/api/videos/stream/${taskId}`,\n            qaReport: record.qaReport,\n            identityQaStatus: record.identityQaStatus || 'not_run',\n            requiresConnection: true,\n            artifactPersisted: true,\n          });\n        }\n\n        const qaVideoBuffer = await gcsArtifactStore.fetchArtifactBuffer(\n          record.outputBucket!,\n          record.outputObjectPath!,\n          { session: qaSession }\n        );\n        const qaAi = await GeminiClientFactory.getClientForSession(qaSession);\n        const settled = await settlePersistedVideoThroughQa({\n          taskId,\n          videoBuffer: qaVideoBuffer,\n          artifactMeta: {\n            outputBucket: record.outputBucket!,\n            outputObjectPath: record.outputObjectPath!,\n            videoUri: record.videoUri!,\n            sizeBytes: record.sizeBytes || qaVideoBuffer.length,\n            contentType: record.contentType || 'video/mp4',\n            artifactPersistedAt: record.artifactPersistedAt || Date.now(),\n          },\n          session: qaSession,\n          ai: qaAi,\n          analysisModel: qaSession.analysisModel || 'gemini-3.6-flash',\n          patch: { pollAttempt: record.pollAttempt, pollHttpStatus: record.pollHttpStatus },\n        });\n        serverVideoTaskStore.set(taskId, settled);\n        return res.json({\n          status: settled.status,\n          videoDataUrl: settled.videoDataUrl || `/api/videos/stream/${taskId}`,\n          sizeBytes: settled.sizeBytes,\n          durationSeconds: settled.durationSeconds,\n          qaReport: settled.qaReport,\n          identityQaStatus: settled.identityQaStatus,\n          requiresManualApproval: settled.status === 'qa_pending' && settled.identityQaStatus === 'review',\n          artifactPersisted: settled.artifactPersisted,\n          diagnostics: settled.diagnostics,\n        });\n      }\n\n      if (record.status === 'completed') {\n"""
    if status_anchor not in server:
        raise SystemExit('status qa_pending anchor not found')
    server = server.replace(status_anchor, status_insert, 1)

# Re-fetch path: remove arbitrary 50KB threshold and fake completion report.
server = server.replace(
    'if (reFetchBuf && reFetchBuf.length > 50 * 1024) {',
    'if (reFetchBuf && reFetchBuf.length > 0) {',
    1,
)
refetch_pattern = re.compile(
    r"\n\s*const defaultQaReport = \{.*?\n\s*return res\.json\(\{\n\s*status: 'completed',.*?\n\s*\}\);",
    re.S,
)
# First matching fake report in status re-fetch block. Replace with real settlement using artifactMeta/reFetchBuf.
refetch_replacement = r'''
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
            });'''
server2, count = refetch_pattern.subn(refetch_replacement, server, count=1)
if count != 1:
    raise SystemExit('status re-fetch fake QA block not found')
server = server2

# Final poll-done path: replace fake QA + auto completion with real settlement.
final_fake_pattern = re.compile(
    r"\n\s*// Save local cache for fast stream reads\n\s*const \{ videoUrl \} = saveVideoBufferToFile\(taskId, videoBuf\);\n\s*const defaultQaReport = \{.*?\n\s*return res\.json\(\{\n\s*status: 'completed',.*?\n\s*\}\);",
    re.S,
)
final_replacement = r'''
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
      });'''
server2, count = final_fake_pattern.subn(final_replacement, server, count=1)
if count != 1:
    raise SystemExit('status final fake QA block not found')
server = server2

# Recovery is artifact recovery, not identity certification. Recovered artifacts must stop at qa_pending.
recover_start = server.find('  // Recover Video Artifact Endpoint')
recover_end = server.find('  // Physical Video Streaming & Download Endpoint')
if recover_start == -1 or recover_end == -1:
    raise SystemExit('recover section not found')
recover = server[recover_start:recover_end]
recover = recover.replace("message: '已根据现有 Cloud Storage 产物完成任务状态对账'", "message: '已恢复 Cloud Storage 产物，等待视频身份质检'")
recover = recover.replace("message: '已成功从 Provider Uri 迁移视频产物至 Cloud Storage'", "message: '已从 Provider URI 持久化视频产物，等待视频身份质检'")
recover = recover.replace("message: '已从 durable Veo Operation 恢复并持久化视频产物至 Cloud Storage'", "message: '已从 durable Veo Operation 恢复并持久化视频产物，等待视频身份质检'")
# Do not rewrite the early branch that verifies an already completed task.
parts = recover.split("      // 1. Reconcile an already-owned GCS object without resubmitting the provider.", 1)
if len(parts) == 2:
    tail = parts[1].replace("status: 'completed'", "status: 'qa_pending'")
    recover = parts[0] + "      // 1. Reconcile an already-owned GCS object without resubmitting the provider." + tail
server = server[:recover_start] + recover + server[recover_end:]

# Disable legacy synchronous endpoint that returns fake in-memory/base64 QA artifacts.
legacy_pattern = re.compile(
    r"  // Video Generation & QA Endpoint \(Legacy Synchronous Fallback\).*?\n  // Fallback 404 handler for unmatched /api/\* routes",
    re.S,
)
legacy_replacement = r'''  // Legacy synchronous generation endpoint is disabled because it bypasses
  // Firestore/GCS authority and durable post-artifact Identity QA.
  app.post('/api/videos/generate-and-qa', (_req, res) => {
    return res.status(410).json({
      error: 'legacy_video_generation_disabled',
      useEndpoint: '/api/videos/start',
    });
  });

  // Fallback 404 handler for unmatched /api/* routes'''
server2, count = legacy_pattern.subn(legacy_replacement, server, count=1)
if count != 1:
    raise SystemExit('legacy generate-and-qa route not found')
server = server2

# Server source must not retain fake post-video QA strings.
for forbidden in [
    "身份自动质检：未执行",
    "summary: '首帧原图直通模式已生效，角色母板未发送至Veo'",
]:
    if forbidden in server:
        raise SystemExit(f'forbidden fake QA string remains: {forbidden}')

# ---------------------------------------------------------------------------
# Studio UI: never fabricate 100 scores or force completed locally.
# ---------------------------------------------------------------------------
studio = re.sub(
    r"\n\s*qaReport:\s*\{\n\s*pass:\s*true,\n\s*identityScore:\s*100,.*?\n\s*\},",
    "",
    studio,
    count=1,
    flags=re.S,
)

studio = studio.replace(
    """      task.qaReport = videoData.qaReport;\n      task.status = 'completed';\n      task.progressStage = '合成与全帧视频生成完成';\n      task.progressPercent = 100;\n""",
    """      task.qaReport = videoData.qaReport;\n      task.identityQaStatus = videoData.identityQaStatus || task.identityQaStatus;\n      task.status = videoData.status || task.status;\n      if (task.status === 'completed') {\n        task.progressStage = '视频生成与身份质检完成';\n        task.progressPercent = 100;\n      } else if (task.status === 'qa_pending') {\n        task.progressStage = videoData.requiresManualApproval\n          ? '视频身份质检需要人工复核'\n          : '视频已持久化，等待身份质检';\n        task.progressPercent = 95;\n      }\n""",
    1,
)

if 'identityScore: 100' in studio:
    raise SystemExit('StudioPage still contains synthetic identityScore: 100')

# ---------------------------------------------------------------------------
# Write only changed files.
# ---------------------------------------------------------------------------
for path, old, new in [
    (SERVER, SERVER.read_text(), server),
    (STATE, STATE.read_text(), state),
    (TYPES, TYPES.read_text(), types),
    (STUDIO, STUDIO.read_text(), studio),
]:
    if old != new:
        path.write_text(new)

print('Applied M2-2 production QA integration patch')
