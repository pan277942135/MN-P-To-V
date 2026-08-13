from pathlib import Path
import re

TYPES = Path('src/types/index.ts')
STATE = Path('src/server/services/taskStateMachineService.ts')
SERVER = Path('server.ts')
ORCH = Path('src/services/tasks/taskOrchestrator.ts')

types = TYPES.read_text()
state = STATE.read_text()
server = SERVER.read_text()
orch = ORCH.read_text()

# ---------------------------------------------------------------------------
# Types: separate provider-attempt budget from execution lease attempts and
# persist retry/artifact history for auditability.
# ---------------------------------------------------------------------------
anchor = "export type VideoIdentityQaStatus = 'not_run' | 'pass' | 'review' | 'fail';\n"
if 'export type RetrySubmissionState' not in types:
    addition = anchor + """
export type RetrySubmissionState = 'none' | 'reserved' | 'submitted' | 'outcome_unknown';

export interface VideoRetryHistoryRecord {
  sequence: number;
  decidedAt: number;
  action: string;
  reasonCode: string;
  diagnosisCode?: string;
  providerAttempt: number;
  qaAttempt: number;
  idempotencyKey?: string;
  state: 'reserved' | 'submitted' | 'completed' | 'failed' | 'manual_review' | 'qa_retry';
  operationName?: string;
}

export interface VideoArtifactHistoryRecord {
  providerAttempt: number;
  outputBucket: string;
  outputObjectPath: string;
  videoUri: string;
  sizeBytes?: number;
  persistedAt?: number;
  qaStatus?: VideoIdentityQaStatus;
  diagnosisCode?: string;
  archivedAt: number;
}
"""
    if anchor not in types:
        raise SystemExit('types retry anchor not found')
    types = types.replace(anchor, addition, 1)

fields_anchor = """  retryCount?: number;
  attempts?: AttemptRecord[];
  diagnostics?: any;
"""
if 'providerAttempt?: number;' not in types:
    fields = """  retryCount?: number;
  providerAttempt?: number;
  qaAttempt?: number;
  automaticRetryPlan?: any;
  providerRetryIdempotencyKey?: string;
  retrySubmissionState?: RetrySubmissionState;
  retryReservedAt?: number;
  retryHistory?: VideoRetryHistoryRecord[];
  artifactHistory?: VideoArtifactHistoryRecord[];
  attempts?: AttemptRecord[];
  diagnostics?: any;
"""
    if fields_anchor not in types:
        raise SystemExit('types task fields anchor not found')
    types = types.replace(fields_anchor, fields, 1)

# ---------------------------------------------------------------------------
# State machine: qa_pending may enter a new generation only via atomic retry
# reservation. Reserve/submit records prevent two workers from launching the
# same logical retry.
# ---------------------------------------------------------------------------
state = state.replace(
    "  generating: ['generation_succeeded', 'polling', 'failed', 'cancelled', 'canceled'],",
    "  generating: ['generation_succeeded', 'polling', 'submission_outcome_unknown', 'failed', 'cancelled', 'canceled'],",
    1,
)
state = state.replace(
    "  qa_pending: ['completed', 'failed', 'cancelled', 'canceled'],",
    "  qa_pending: ['completed', 'generating', 'failed', 'cancelled', 'canceled'],",
    1,
)
if "  submission_outcome_unknown: ['polling', 'failed', 'cancelled', 'canceled']," not in state:
    state = state.replace(
        "  completed: [],",
        "  submission_outcome_unknown: ['polling', 'failed', 'cancelled', 'canceled'],\n  completed: [],",
        1,
    )

method_anchor = "  public async completeWithPersistedArtifact(params: {"
if 'public async reserveAutomaticProviderRetry(' not in state:
    methods = r'''  public async reserveAutomaticProviderRetry(params: {
    taskId: string;
    decision: any;
    diagnosisCode?: string;
  }): Promise<{ reserved: boolean; task: ServerVideoTaskRecord }> {
    const { taskId, decision, diagnosisCode } = params;
    if (decision?.action !== 'REGENERATE_VIDEO' || !decision?.idempotencyKey) {
      throw new Error('[M2_4_RETRY_RESERVATION_INVALID] REGENERATE_VIDEO decision with idempotency key is required.');
    }

    return await firestoreTaskRepository.runTaskTransaction(taskId, (currentTask) => {
      if (!currentTask) throw new Error(`[TaskStateMachine] Task ${taskId} not found.`);

      if (currentTask.providerRetryIdempotencyKey === decision.idempotencyKey) {
        return {
          taskPatch: undefined,
          result: { reserved: false, task: currentTask },
        };
      }
      if (currentTask.status !== 'qa_pending') {
        throw new InvalidStateTransitionError(currentTask.status, 'generating', taskId);
      }

      const now = Date.now();
      const version = currentVersion(currentTask);
      const artifactHistory = [...(currentTask.artifactHistory || [])];
      if (
        currentTask.artifactPersisted === true &&
        currentTask.outputBucket &&
        currentTask.outputObjectPath &&
        currentTask.videoUri &&
        !artifactHistory.some((item) => item.outputObjectPath === currentTask.outputObjectPath)
      ) {
        artifactHistory.push({
          providerAttempt: currentTask.providerAttempt || 1,
          outputBucket: currentTask.outputBucket,
          outputObjectPath: currentTask.outputObjectPath,
          videoUri: currentTask.videoUri,
          sizeBytes: currentTask.sizeBytes,
          persistedAt: currentTask.artifactPersistedAt,
          qaStatus: currentTask.identityQaStatus,
          diagnosisCode,
          archivedAt: now,
        });
      }

      const retryHistory = [...(currentTask.retryHistory || [])];
      retryHistory.push({
        sequence: retryHistory.length + 1,
        decidedAt: now,
        action: decision.action,
        reasonCode: decision.reasonCode,
        diagnosisCode,
        providerAttempt: decision.nextProviderAttempt,
        qaAttempt: decision.nextQaAttempt || 1,
        idempotencyKey: decision.idempotencyKey,
        state: 'reserved',
      });

      const patch: Partial<ServerVideoTaskRecord> = {
        status: 'generating',
        stateVersion: version + 1,
        statusVersion: version + 1,
        providerAttempt: decision.nextProviderAttempt,
        qaAttempt: 1,
        retryCount: Math.max(0, decision.nextProviderAttempt - 1),
        automaticRetryPlan: decision,
        providerRetryIdempotencyKey: decision.idempotencyKey,
        retrySubmissionState: 'reserved',
        retryReservedAt: now,
        retryHistory,
        artifactHistory,
        operationName: '',
        providerOperationId: '',
        videoUri: '',
        outputObjectPath: '',
        videoDataUrl: '',
        sizeBytes: 0,
        contentType: '',
        artifactPersisted: false,
        identityQaStatus: 'not_run',
        qaReport: null,
        identityQaReport: null,
        pollAttempt: 0,
        error: '',
        structuredError: null,
        updatedAt: now,
      };

      return {
        taskPatch: patch,
        result: { reserved: true, task: { ...currentTask, ...patch } as ServerVideoTaskRecord },
      };
    });
  }

  public async markAutomaticRetrySubmitted(params: {
    taskId: string;
    idempotencyKey: string;
    operationName: string;
    diagnostics?: any;
  }): Promise<ServerVideoTaskRecord> {
    const { taskId, idempotencyKey, operationName, diagnostics } = params;
    return await firestoreTaskRepository.runTaskTransaction(taskId, (currentTask) => {
      if (!currentTask) throw new Error(`[TaskStateMachine] Task ${taskId} not found.`);
      if (
        currentTask.providerRetryIdempotencyKey !== idempotencyKey ||
        currentTask.retrySubmissionState !== 'reserved' ||
        currentTask.status !== 'generating'
      ) {
        throw new Error(`[M2_4_RETRY_SUBMISSION_STALE] Retry submission no longer owns task ${taskId}.`);
      }

      const now = Date.now();
      const version = currentVersion(currentTask);
      const retryHistory = [...(currentTask.retryHistory || [])];
      const index = retryHistory.findIndex((item) => item.idempotencyKey === idempotencyKey);
      if (index >= 0) {
        retryHistory[index] = { ...retryHistory[index], state: 'submitted', operationName };
      }
      const patch: Partial<ServerVideoTaskRecord> = {
        status: 'polling',
        stateVersion: version + 1,
        statusVersion: version + 1,
        operationName,
        providerOperationId: operationName,
        retrySubmissionState: 'submitted',
        retryHistory,
        diagnostics,
        submitHttpStatus: 200,
        lastSubmitAttemptAt: now,
        updatedAt: now,
      };
      return { taskPatch: patch, result: { ...currentTask, ...patch } as ServerVideoTaskRecord };
    });
  }

  public async markAutomaticRetryOutcomeUnknown(params: {
    taskId: string;
    idempotencyKey: string;
    message: string;
  }): Promise<ServerVideoTaskRecord> {
    const { taskId, idempotencyKey, message } = params;
    return await firestoreTaskRepository.runTaskTransaction(taskId, (currentTask) => {
      if (!currentTask) throw new Error(`[TaskStateMachine] Task ${taskId} not found.`);
      if (currentTask.providerRetryIdempotencyKey !== idempotencyKey) {
        return { taskPatch: undefined, result: currentTask };
      }
      const now = Date.now();
      const version = currentVersion(currentTask);
      const patch: Partial<ServerVideoTaskRecord> = {
        status: 'submission_outcome_unknown',
        stateVersion: version + 1,
        statusVersion: version + 1,
        retrySubmissionState: 'outcome_unknown',
        error: message,
        structuredError: buildStructuredError({
          code: 'AUTOMATIC_RETRY_SUBMISSION_OUTCOME_UNKNOWN',
          message,
          stage: 'automatic_retry_submit',
          retryable: false,
          attempt: currentTask.providerAttempt,
        }),
        updatedAt: now,
      };
      return { taskPatch: patch, result: { ...currentTask, ...patch } as ServerVideoTaskRecord };
    });
  }

'''
    if method_anchor not in state:
        raise SystemExit('state retry method anchor not found')
    state = state.replace(method_anchor, methods + method_anchor, 1)

# ---------------------------------------------------------------------------
# Server: policy is authoritative after diagnosis; retry artifacts use attempt-
# specific object paths and duplicate provider retry launches are reserved in
# Firestore before the network call.
# ---------------------------------------------------------------------------
server_import = "import { VideoFailureDiagnosisService } from './src/services/qa/videoFailureDiagnosisService';\n"
imports = server_import + "import { VideoRetryPolicyService } from './src/services/qa/videoRetryPolicyService';\nimport { DurableVideoRetryService } from './src/server/services/durableVideoRetryService';\n"
if "VideoRetryPolicyService" not in server:
    if server_import not in server:
        raise SystemExit('server retry import anchor not found')
    server = server.replace(server_import, imports, 1)

# QA execution failure: one QA-only retry on the same durable artifact; never
# spend provider quota because frame/QA evidence is incomplete.
old_catch = """  } catch (qaErr: any) {
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
"""
new_catch = """  } catch (qaErr: any) {
    const currentQaAttempt = qaPendingTask.qaAttempt || 1;
    const canReQa = currentQaAttempt < 2;
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
"""
if old_catch in server:
    server = server.replace(old_catch, new_catch, 1)
elif 'QA_EXECUTION_FAILED_REQA' not in server:
    raise SystemExit('server QA catch anchor not found')

# Diagnosis -> policy decision.
diag_anchor = """  const failureDiagnosis = VideoFailureDiagnosisService.diagnose(qaReport);
  const diagnosedQaReport = failureDiagnosis
    ? { ...qaReport, failureDiagnosis }
    : qaReport;
"""
if 'const retryDecision = VideoRetryPolicyService.decide({' not in server:
    diag_replacement = """  const failureDiagnosis = VideoFailureDiagnosisService.diagnose(qaReport);
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
"""
    if diag_anchor not in server:
        raise SystemExit('server diagnosis policy anchor not found')
    server = server.replace(diag_anchor, diag_replacement, 1)

# REVIEW/manual review must remain qa_pending and must never auto-regenerate.
review_anchor = """  if (qaReport.gateStatus === 'review') {
    return await taskStateMachineService.transitionTask({
      taskId,
      toStatus: 'qa_pending',
      patch: commonQaPatch,
    });
  }

  return await taskStateMachineService.transitionTask({
    taskId,
    toStatus: 'failed',
"""
if 'reserveAutomaticProviderRetry' not in server:
    review_replacement = """  if (retryDecision.action === 'MANUAL_REVIEW' || qaReport.gateStatus === 'review') {
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
    const reservation = await taskStateMachineService.reserveAutomaticProviderRetry({
      taskId,
      decision: retryDecision,
      diagnosisCode: failureDiagnosis?.primaryCode,
    });
    if (!reservation.reserved) return reservation.task;

    try {
      const retryStart = await DurableVideoRetryService.launch({
        task: reservation.task,
        decision: retryDecision,
        session,
        ai,
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
"""
    if review_anchor not in server:
        raise SystemExit('server retry decision branch anchor not found')
    server = server.replace(review_anchor, review_replacement, 1)

# Terminal failure records the policy decision.
server = server.replace(
    """      ...commonQaPatch,
      failureReason: 'artifact_invalid',
""",
    """      ...commonQaPatch,
      automaticRetryPlan: retryDecision,
      failureReason: 'artifact_invalid',
""",
    1,
)

# New task attempt counters are explicit and distinct from execution lease attempts.
record_anchor = """        identityQaStatus: 'not_run',
        qaApprovedFirstFrameObjectPath,
"""
if 'providerAttempt: 1,' not in server:
    record_replacement = """        identityQaStatus: 'not_run',
        providerAttempt: 1,
        qaAttempt: 1,
        retryCount: 0,
        retrySubmissionState: 'none',
        retryHistory: [],
        artifactHistory: [],
        qaApprovedFirstFrameObjectPath,
"""
    if record_anchor not in server:
        raise SystemExit('server initial attempt anchor not found')
    server = server.replace(record_anchor, record_replacement, 1)

# qa_pending with a manual plan must not continuously rerun QA on every status poll.
qa_pending_anchor = """      if (record.status === 'qa_pending') {
        if (record.identityQaStatus === 'review') {
"""
if "record.automaticRetryPlan?.action === 'MANUAL_REVIEW'" not in server:
    qa_pending_replacement = """      if (record.status === 'qa_pending') {
        if (
          record.identityQaStatus === 'review' ||
          record.automaticRetryPlan?.action === 'MANUAL_REVIEW'
        ) {
"""
    if qa_pending_anchor not in server:
        raise SystemExit('server qa_pending manual anchor not found')
    server = server.replace(qa_pending_anchor, qa_pending_replacement, 1)

# Surface retry plan in the manual review response and general settled response.
server = server.replace(
    """            requiresManualApproval: true,
            artifactPersisted: true,
""",
    """            requiresManualApproval: true,
            automaticRetryPlan: record.automaticRetryPlan,
            retryHistory: record.retryHistory,
            artifactPersisted: true,
""",
    1,
)
server = server.replace(
    """          diagnostics: settled.diagnostics,
        });
""",
    """          diagnostics: settled.diagnostics,
          automaticRetryPlan: settled.automaticRetryPlan,
          retryHistory: settled.retryHistory,
        });
""",
    1,
)

# A process crash after retry reservation has an ambiguous provider outcome. Never
# automatically submit the same retry again because Vertex exposes no idempotency key.
submitting_anchor = """      if (record.status === 'submitting' || !record.operationName) {
        return res.json({
"""
if 'AUTOMATIC_RETRY_RESERVATION_STALE' not in server:
    submitting_replacement = """      if (
        record.status === 'generating' &&
        record.retrySubmissionState === 'reserved' &&
        !record.operationName
      ) {
        const reservedAgeMs = Date.now() - (record.retryReservedAt || record.updatedAt || Date.now());
        if (reservedAgeMs > 180000) {
          const unknown = await taskStateMachineService.markAutomaticRetryOutcomeUnknown({
            taskId,
            idempotencyKey: record.providerRetryIdempotencyKey || 'missing',
            message: 'AUTOMATIC_RETRY_RESERVATION_STALE: retry reservation outlived the provider submission window; refusing automatic resubmission.',
          });
          return res.json({
            status: unknown.status,
            error: unknown.error,
            structuredError: unknown.structuredError,
            automaticRetryPlan: unknown.automaticRetryPlan,
          });
        }
        return res.json({
          status: 'submitting',
          progressStage: '正在提交自动定向重试；已持久化 retry reservation，禁止重复提单',
          providerAttempt: record.providerAttempt,
          automaticRetryPlan: record.automaticRetryPlan,
        });
      }

      if (record.status === 'submitting' || !record.operationName) {
        return res.json({
"""
    if submitting_anchor not in server:
        raise SystemExit('server retry reserved recovery anchor not found')
    server = server.replace(submitting_anchor, submitting_replacement, 1)

# Persist each provider attempt under its own GCS object path. This prevents
# attempt 2 from overwriting the failed-but-auditable attempt 1 artifact.
server = server.replace(
    """              artifactMeta = await gcsArtifactStore.uploadVideoArtifact({
                taskId,
                videoBuffer: reFetchBuf,
""",
    """              const artifactTaskKey = DurableVideoRetryService.getAttemptTaskKey(
                taskId,
                record.providerAttempt || 1
              );
              artifactMeta = await gcsArtifactStore.uploadVideoArtifact({
                taskId: artifactTaskKey,
                videoBuffer: reFetchBuf,
""",
    1,
)
server = server.replace(
    """              artifactMeta = await gcsArtifactStore.migrateArtifactToGcs({
                taskId,
                videoUri: record.videoUri,
""",
    """              artifactMeta = await gcsArtifactStore.migrateArtifactToGcs({
                taskId: DurableVideoRetryService.getAttemptTaskKey(taskId, record.providerAttempt || 1),
                videoUri: record.videoUri,
""",
    1,
)
server = server.replace(
    """        artifactMeta = await gcsArtifactStore.uploadVideoArtifact({
          taskId,
          videoBuffer: videoBuf,
""",
    """        artifactMeta = await gcsArtifactStore.uploadVideoArtifact({
          taskId: DurableVideoRetryService.getAttemptTaskKey(taskId, record.providerAttempt || 1),
          videoBuffer: videoBuf,
""",
    1,
)

# ---------------------------------------------------------------------------
# Local orchestrator: replace blind fixed retry with the same policy semantics.
# ---------------------------------------------------------------------------
orch_import = "import { VideoFailureDiagnosisService } from '../qa/videoFailureDiagnosisService';\n"
if "VideoRetryPolicyService" not in orch:
    if orch_import not in orch:
        raise SystemExit('orchestrator retry import anchor not found')
    orch = orch.replace(
        orch_import,
        orch_import + "import { VideoRetryPolicyService } from '../qa/videoRetryPolicyService';\n",
        1,
    )

attempt_record_anchor = """      const attemptRecord: AttemptRecord = {
        attemptIndex: task.attempts.length + 1,
        actionType: videoAttempts === 1 ? 'video_start' : 'video_repair',
        model: effectiveModels.videoModel,
        startTime,
        endTime: Date.now(),
        success: videoQaReport.pass,
        qaScore: videoQaReport.averageIdentityScore,
        triggeredRetry: !videoQaReport.pass && videoAttempts < maxVideoAttempts,
        notes: `[${videoQaReport.gateStatus}][${failureDiagnosis?.primaryCode || 'NO_FAILURE_DIAGNOSIS'}] ${videoQaReport.summary}`,
      };
"""
if 'const retryDecision = VideoRetryPolicyService.decide({' not in orch:
    attempt_record_replacement = """      const retryDecision = VideoRetryPolicyService.decide({
        taskId: task.id,
        qaReport: videoQaReport,
        diagnosis: failureDiagnosis,
        providerAttempt: videoAttempts,
        qaAttempt: 1,
        maxProviderAttempts: maxVideoAttempts,
      });

      const attemptRecord: AttemptRecord = {
        attemptIndex: task.attempts.length + 1,
        actionType: videoAttempts === 1 ? 'video_start' : 'video_repair',
        model: effectiveModels.videoModel,
        startTime,
        endTime: Date.now(),
        success: videoQaReport.pass,
        qaScore: videoQaReport.averageIdentityScore,
        triggeredRetry: retryDecision.action === 'REGENERATE_VIDEO',
        notes: `[${videoQaReport.gateStatus}][${failureDiagnosis?.primaryCode || 'NO_FAILURE_DIAGNOSIS'}][${retryDecision.action}] ${videoQaReport.summary}`,
      };
"""
    if attempt_record_anchor not in orch:
        raise SystemExit('orchestrator attempt retry anchor not found')
    orch = orch.replace(attempt_record_anchor, attempt_record_replacement, 1)

blind_retry_anchor = """      directionalRepair =
        failureDiagnosis?.repairPromptAppend ||
        videoQaReport.repairInstruction ||
        '恢复所有视频帧与 Approved First Frame 和角色母板的一致身份特征';

      if (videoAttempts < maxVideoAttempts) {
        task.progressStage = `Identity QA ${videoQaReport.gateStatus}，按最差帧问题执行定向重试`;
        task.updatedAt = Date.now();
        await onTaskUpdated(task);
        continue;
      }

      if (videoQaReport.gateStatus === 'review') {
"""
if 'retryDecision.action === \'REGENERATE_VIDEO\'' not in orch:
    blind_retry_replacement = """      directionalRepair =
        retryDecision.repairPromptAppend ||
        failureDiagnosis?.repairPromptAppend ||
        videoQaReport.repairInstruction ||
        '恢复所有视频帧与 Approved First Frame 和角色母板的一致身份特征';

      if (retryDecision.action === 'REGENERATE_VIDEO') {
        task.progressStage = `自动重试策略允许定向重生成：${retryDecision.reasonCode}`;
        task.updatedAt = Date.now();
        await onTaskUpdated(task);
        continue;
      }

      if (retryDecision.action === 'MANUAL_REVIEW' || videoQaReport.gateStatus === 'review') {
"""
    if blind_retry_anchor not in orch:
        raise SystemExit('orchestrator blind retry branch anchor not found')
    orch = orch.replace(blind_retry_anchor, blind_retry_replacement, 1)

TYPES.write_text(types)
STATE.write_text(state)
SERVER.write_text(server)
ORCH.write_text(orch)
print('Applied M2-4 durable automatic retry integration')
