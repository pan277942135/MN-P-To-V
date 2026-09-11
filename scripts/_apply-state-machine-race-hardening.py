from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, got {count}')
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, repl: str, label: str, flags=0) -> str:
    out, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 regex match, got {count}')
    return out

# 1) Durable state machine: evidence-based provider success + stale submitting reconciliation.
state_path = Path('src/server/services/taskStateMachineService.ts')
state = state_path.read_text()

marker = "  public async acquireLease(params: {\n"
insert = r'''  public async reconcileStaleSubmittingTask(params: {
    taskId: string;
    now?: number;
    fallbackStaleAfterMs?: number;
  }): Promise<{ markedUnknown: boolean; task: ServerVideoTaskRecord }> {
    const { taskId, now = Date.now(), fallbackStaleAfterMs = 180000 } = params;
    return await firestoreTaskRepository.runTaskTransaction<{ markedUnknown: boolean; task: ServerVideoTaskRecord }>(taskId, (currentTask) => {
      if (!currentTask) throw new Error(`[PROVIDER_SUBMIT_RECONCILE] Task ${taskId} not found.`);
      if (currentTask.status !== 'submitting' || currentTask.operationName || currentTask.providerOperationId) {
        return { taskPatch: undefined, result: { markedUnknown: false, task: currentTask } };
      }

      // A submitting task is inside the Provider call window only after durable authorization.
      // Never let a read/list request infer outcome_unknown while the execution lease is alive.
      if (!currentTask.providerSubmissionAuthorizedAt) {
        return { taskPatch: undefined, result: { markedUnknown: false, task: currentTask } };
      }

      const leaseExpired = currentTask.leaseExpiresAt
        ? currentTask.leaseExpiresAt <= now
        : now - currentTask.providerSubmissionAuthorizedAt > fallbackStaleAfterMs;
      if (!leaseExpired) {
        return { taskPatch: undefined, result: { markedUnknown: false, task: currentTask } };
      }

      const version = currentVersion(currentTask);
      const message = 'Veo 提交执行租约已失效，且尚无可验证 Operation Name；提交结果保持未知，禁止重复提交。';
      const patch: Partial<ServerVideoTaskRecord> = {
        status: 'submission_outcome_unknown',
        failureReason: 'submission_outcome_unknown' as any,
        retryMode: 'NO_RETRY',
        error: message,
        structuredError: buildStructuredError({
          code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
          message,
          stage: 'provider_submit_reconcile',
          retryable: false,
          executionId: currentTask.executionId,
          httpStatus: 504,
        }) as any,
        leaseOwner: null as any,
        leaseExpiresAt: 0,
        heartbeatAt: null as any,
        stateVersion: version + 1,
        statusVersion: version + 1,
        updatedAt: now,
      };
      return {
        taskPatch: patch,
        result: { markedUnknown: true, task: { ...currentTask, ...patch } as ServerVideoTaskRecord },
      };
    });
  }

  public async recordProviderSubmissionSuccess(params: {
    taskId: string;
    executionId: string;
    operationName: string;
    diagnostics?: any;
  }): Promise<ServerVideoTaskRecord> {
    const { taskId, executionId, operationName, diagnostics } = params;
    const normalizedOperationName = String(operationName || '').trim();
    if (!normalizedOperationName || !/(^|\/)operations\/[^/]+$/.test(normalizedOperationName)) {
      throw new Error('[PROVIDER_SUBMISSION_EVIDENCE_INVALID] A valid Provider Operation Name is required.');
    }

    return await firestoreTaskRepository.runTaskTransaction<ServerVideoTaskRecord>(taskId, (currentTask) => {
      if (!currentTask) throw new Error(`[PROVIDER_SUBMISSION_SUCCESS] Task ${taskId} not found.`);
      if (!currentTask.providerSubmissionAuthorizedAt || !currentTask.providerSubmissionAuthorizedExecutionId) {
        throw new Error('[PROVIDER_SUBMISSION_SUCCESS_WITHOUT_AUTHORIZATION] Durable Provider authorization evidence is required.');
      }
      if (currentTask.providerSubmissionAuthorizedExecutionId !== executionId) {
        throw new LateWorkerError(taskId, executionId, currentTask.providerSubmissionAuthorizedExecutionId);
      }
      if (currentTask.executionId && currentTask.executionId !== executionId) {
        throw new LateWorkerError(taskId, executionId, currentTask.executionId);
      }
      if (currentTask.operationName && currentTask.operationName !== normalizedOperationName) {
        throw new Error('[PROVIDER_OPERATION_CONFLICT] Task already contains a different Provider Operation Name.');
      }

      const recoverableStatuses = new Set(['submitting', 'submission_outcome_unknown', 'submitted', 'polling']);
      if (!recoverableStatuses.has(String(currentTask.status))) {
        throw new InvalidStateTransitionError(currentTask.status, 'polling', taskId);
      }

      const now = Date.now();
      const version = currentVersion(currentTask);
      const patch: Partial<ServerVideoTaskRecord> = {
        status: 'polling',
        operationName: normalizedOperationName,
        providerOperationId: normalizedOperationName,
        diagnostics: diagnostics ?? currentTask.diagnostics,
        submitHttpStatus: 200,
        lastSubmitAttemptAt: currentTask.lastSubmitAttemptAt || now,
        failureReason: null as any,
        retryMode: 'RETRY_POLL',
        error: null as any,
        structuredError: null as any,
        submitTimedOutAt: null as any,
        leaseOwner: null as any,
        leaseExpiresAt: 0,
        heartbeatAt: null as any,
        stateVersion: version + 1,
        statusVersion: version + 1,
        updatedAt: now,
      };
      return { taskPatch: patch, result: { ...currentTask, ...patch } as ServerVideoTaskRecord };
    });
  }

'''
if 'public async recordProviderSubmissionSuccess' not in state:
    state = replace_once(state, marker, insert + marker, 'insert state-machine provider methods')

# Strengthen unknown -> polling generic transition: it must carry operation evidence.
needle = "      if (!force && !canTransition(currentTask.status, toStatus)) {\n        throw new InvalidStateTransitionError(currentTask.status, toStatus, taskId);\n      }\n\n      const version = currentVersion(currentTask);\n"
replacement = "      if (!force && !canTransition(currentTask.status, toStatus)) {\n        throw new InvalidStateTransitionError(currentTask.status, toStatus, taskId);\n      }\n      if (\n        !force &&\n        currentTask.status === 'submission_outcome_unknown' &&\n        toStatus === 'polling' &&\n        !String((patch as any).operationName || currentTask.operationName || '').trim()\n      ) {\n        throw new Error('[PROVIDER_OPERATION_EVIDENCE_REQUIRED] submission_outcome_unknown -> polling requires a durable Operation Name.');\n      }\n\n      const version = currentVersion(currentTask);\n"
state = replace_once(state, needle, replacement, 'strengthen unknown polling invariant')
state_path.write_text(state)

# 2) Server route: atomic provider evidence recording; no 30s read-side mutation; expose artifact authority in list.
server_path = Path('server.ts')
server = server_path.read_text()

old_op = """          if (startResult.operationName) {\n            const submitted = await safeUpdateTaskRecord(taskId, {\n              status: 'submitted',\n              operationName: startResult.operationName,\n              diagnostics: startResult.diagnostics,\n              submitHttpStatus: 200,\n            });\n            await safeUpdateTaskRecord(taskId, {\n              status: 'polling',\n              operationName: startResult.operationName,\n              diagnostics: startResult.diagnostics,\n              submitHttpStatus: 200,\n              stateVersion: submitted.stateVersion,\n            });\n            await taskStateMachineService.releaseLease(taskId, taskRecord.executionId);\n            console.log(`[Video Start Success] 任务 ${taskId} 成功获取 OperationName: ${startResult.operationName}`);\n            return;\n          }\n"""
new_op = """          if (startResult.operationName) {\n            const pollingTask = await taskStateMachineService.recordProviderSubmissionSuccess({\n              taskId,\n              executionId: taskRecord.executionId!,\n              operationName: startResult.operationName,\n              diagnostics: startResult.diagnostics,\n            });\n            serverVideoTaskStore.set(taskId, pollingTask);\n            console.log(`[Video Start Success] 任务 ${taskId} 已原子记录 Provider Operation 并进入 polling: ${startResult.operationName}`);\n            return;\n          }\n"""
server = replace_once(server, old_op, new_op, 'replace provider operation transition block')

old_reconcile = """      for (let i = 0; i < tasksFromStore.length; i++) {\n        const candidate = tasksFromStore[i];\n        if (candidate?.status !== 'preparing') continue;\n        try {\n          const reconciled = await taskStateMachineService.reconcileStalePreparingTask({\n            taskId: candidate.taskId || candidate.id,\n            now,\n          });\n          tasksFromStore[i] = reconciled.task;\n          serverVideoTaskStore.set(reconciled.task.taskId || reconciled.task.id, reconciled.task);\n          if (reconciled.failed) hasUpdates = true;\n        } catch (prepErr) {\n          console.warn('[Pre-Provider Preparing Reconcile Warning]:', prepErr);\n        }\n      }\n"""
new_reconcile = """      for (let i = 0; i < tasksFromStore.length; i++) {\n        const candidate = tasksFromStore[i];\n        if (!candidate) continue;\n        try {\n          if (candidate.status === 'preparing') {\n            const reconciled = await taskStateMachineService.reconcileStalePreparingTask({\n              taskId: candidate.taskId || candidate.id,\n              now,\n            });\n            tasksFromStore[i] = reconciled.task;\n            serverVideoTaskStore.set(reconciled.task.taskId || reconciled.task.id, reconciled.task);\n            if (reconciled.failed) hasUpdates = true;\n          } else if (candidate.status === 'submitting' && !candidate.operationName) {\n            const reconciled = await taskStateMachineService.reconcileStaleSubmittingTask({\n              taskId: candidate.taskId || candidate.id,\n              now,\n            });\n            tasksFromStore[i] = reconciled.task;\n            serverVideoTaskStore.set(reconciled.task.taskId || reconciled.task.id, reconciled.task);\n            if (reconciled.markedUnknown) hasUpdates = true;\n          }\n        } catch (reconcileErr) {\n          console.warn('[Provider Task Reconcile Warning]:', reconcileErr);\n        }\n      }\n"""
server = replace_once(server, old_reconcile, new_reconcile, 'replace list reconciliation loop')

server = replace_once(
    server,
    "          const isStuckWithoutOpName = rec.status === 'submitting' && !rec.operationName && (now - rec.createdAt) > 30000;\n",
    "",
    'remove 30s submitting race predicate',
)
server = regex_once(
    server,
    r"          if \(isStuckWithoutOpName\) \{.*?          \} else if \(isKnownOperationTimedOut\) \{",
    "          if (isKnownOperationTimedOut) {",
    'remove read-side unknown mutation block',
    flags=re.S,
)

# Better progress semantics for non-terminal authoritative states.
old_progress = """            progressStage: effectiveStatus === 'completed'\n              ? '视频生成完成'\n              : effectiveStatus === 'failed'\n              ? (userMsg || '视频生成未成功完成')\n              : effectiveStatus === 'preparing'\n                ? '准备提交 Veo（尚未调用 Provider）'\n                : '云端渲染中...',\n            progressPercent: effectiveStatus === 'completed' ? 100 : effectiveStatus === 'failed' ? 0 : effectiveStatus === 'preparing' ? 20 : 75,\n            resultVideoUrl: rec.videoDataUrl || null,\n"""
new_progress = """            progressStage: effectiveStatus === 'completed'\n              ? '视频生成完成'\n              : effectiveStatus === 'failed'\n              ? (userMsg || '视频生成未成功完成')\n              : effectiveStatus === 'qa_pending'\n                ? '视频已生成并持久化，身份质检待复核'\n                : effectiveStatus === 'submission_outcome_unknown'\n                  ? 'Veo 提交结果待核实，已保护避免重复提交'\n                  : effectiveStatus === 'preparing'\n                    ? '准备提交 Veo（尚未调用 Provider）'\n                    : effectiveStatus === 'submitting'\n                      ? '正在向 Veo 提交任务...'\n                      : '云端渲染中...',\n            progressPercent: effectiveStatus === 'completed'\n              ? 100\n              : effectiveStatus === 'failed'\n                ? 0\n                : effectiveStatus === 'qa_pending'\n                  ? 95\n                  : effectiveStatus === 'preparing'\n                    ? 20\n                    : effectiveStatus === 'submitting'\n                      ? 45\n                      : effectiveStatus === 'submission_outcome_unknown'\n                        ? 50\n                        : 75,\n            resultVideoUrl: rec.videoDataUrl || (rec.artifactPersisted && rec.outputBucket && rec.outputObjectPath ? `/api/videos/stream/${rec.taskId || rec.id}` : null),\n            videoDataUrl: rec.videoDataUrl || (rec.artifactPersisted && rec.outputBucket && rec.outputObjectPath ? `/api/videos/stream/${rec.taskId || rec.id}` : null),\n            outputBucket: rec.outputBucket || null,\n            outputObjectPath: rec.outputObjectPath || null,\n            artifactPersisted: Boolean(rec.artifactPersisted),\n            sizeBytes: rec.sizeBytes || 0,\n            contentType: rec.contentType || null,\n            identityQaStatus: rec.identityQaStatus || null,\n            qaReport: rec.qaReport || rec.identityQaReport || null,\n            humanReviewDecision: rec.humanReviewDecision || null,\n"""
server = replace_once(server, old_progress, new_progress, 'expose authoritative artifact fields in list')
server_path.write_text(server)

# 3) Browser reconciliation: server active/unknown states override stale local 500/network errors.
recon_path = Path('src/services/tasks/taskReconciler.ts')
recon = recon_path.read_text()
recon = recon.replace(
    "const effectiveVideoUrl = serverMatch.videoDataUrl || serverArtifactUrl || localTask.resultVideoUrl;",
    "const effectiveVideoUrl = serverMatch.videoDataUrl || serverMatch.resultVideoUrl || serverArtifactUrl || localTask.resultVideoUrl;",
)
recon = recon.replace(
    "localTask.resultVideoUrl = serverMatch.videoDataUrl || serverArtifactUrl;",
    "localTask.resultVideoUrl = serverMatch.videoDataUrl || serverMatch.resultVideoUrl || serverArtifactUrl;",
)
old_active = """        } else if (serverStatus === 'failed') {\n          localTask.status = 'failed';\n          localTask.progressStage = '视频生成失败';\n          const serverError = serverMatch.error || serverMatch.structuredError || serverMatch.upstreamErrorMessage;\n          if (serverError) {\n            localTask.error = typeof serverError === 'object' ? serverError : {\n              code: 'SERVER_FAILED',\n              stage: 'polling',\n              messageChinese: serverError || '视频生成失败',\n              technicalMessageRedacted: serverError || '云端渲染失败',\n              httpStatus: 500,\n              retryable: true,\n              recommendedAction: '在下方点击【一键重试】',\n            };\n          }\n        } else if (serverStatus === 'polling' || serverStatus === 'submitting' || serverStatus === 'processing') {\n          // Do NOT downgrade a failed or completed task back to polling_video\n          if (\n            localTask.status !== 'failed' &&\n            localTask.status !== 'completed' &&\n            localTask.status !== 'completed_with_warning' &&\n            localTask.status !== 'orphaned_local_task' &&\n            !localTask.error\n          ) {\n            localTask.status = 'polling_video';\n            localTask.progressStage = `云端视频渲染中...`;\n          }\n"""
new_active = """        } else if (serverStatus === 'submission_outcome_unknown') {\n          localTask.status = 'submission_outcome_unknown';\n          localTask.progressStage = 'Veo 提交结果待核实，已保护避免重复提交';\n          localTask.progressPercent = Math.max(localTask.progressPercent || 0, 50);\n          // Unknown is a protected recovery state, not a proven generation failure. Do not\n          // keep a stale browser HTTP 500 because it would expose the unsafe one-click retry UI.\n          localTask.error = undefined;\n          (localTask as any).failureReason = 'submission_outcome_unknown';\n          (localTask as any).retryMode = 'NO_RETRY';\n        } else if (serverStatus === 'failed') {\n          localTask.status = 'failed';\n          localTask.progressStage = '视频生成失败';\n          const serverError = serverMatch.error || serverMatch.structuredError || serverMatch.upstreamErrorMessage;\n          if (serverError) {\n            localTask.error = typeof serverError === 'object' ? serverError : {\n              code: 'SERVER_FAILED',\n              stage: 'polling',\n              messageChinese: serverError || '视频生成失败',\n              technicalMessageRedacted: serverError || '云端渲染失败',\n              httpStatus: 500,\n              retryable: true,\n              recommendedAction: '在下方点击【一键重试】',\n            };\n          }\n        } else if (serverStatus === 'polling' || serverStatus === 'submitting' || serverStatus === 'submitted' || serverStatus === 'processing') {\n          // Firestore is authoritative. A stale browser/network 500 must never keep an\n          // already-submitted Provider task painted as failed or expose regeneration.\n          localTask.status = 'polling_video';\n          localTask.progressStage = serverStatus === 'submitting'\n            ? '正在向 Veo 提交任务...'\n            : '云端视频渲染中...';\n          localTask.progressPercent = Math.max(localTask.progressPercent || 0, serverStatus === 'submitting' ? 45 : 75);\n          localTask.error = undefined;\n          (localTask as any).failureReason = undefined;\n          (localTask as any).retryMode = serverStatus === 'submitting' ? 'NO_RETRY' : 'RETRY_POLL';\n"""
recon = replace_once(recon, old_active, new_active, 'replace browser active-state reconciliation')
recon_path.write_text(recon)

# 4) Regression suite: source contract + durable transaction behavior.
test_path = Path('src/__tests__/providerSubmissionRaceHardening.test.ts')
test_path.write_text(r'''import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import type { ServerVideoTaskRecord } from '../types';
import { firestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';
import { setFirestoreInstanceForTesting } from '../server/db/firestore';
import { taskStateMachineService } from '../server/services/taskStateMachineService';

class MockDoc {
  constructor(private store: Map<string, any>, private id: string) {}
  async get() {
    const data = this.store.get(this.id);
    return { exists: Boolean(data), data: () => data ? structuredClone(data) : undefined };
  }
  async set(data: any) { this.store.set(this.id, structuredClone(data)); }
  async update(patch: any) { this.store.set(this.id, { ...(this.store.get(this.id) || {}), ...structuredClone(patch) }); }
}
class MockCollection {
  constructor(private store: Map<string, any>) {}
  doc(id: string) { return new MockDoc(this.store, id); }
  orderBy() { return this; }
  limit() { return this; }
  async get() {
    const docs = Array.from(this.store.entries()).map(([id, data]) => ({ id, data: () => structuredClone(data) }));
    return { docs, forEach: (cb: (doc: any) => void) => docs.forEach(cb) };
  }
}
class MockFirestore {
  store = new Map<string, any>();
  collection(_name: string) { return new MockCollection(this.store); }
  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      get: async (doc: MockDoc) => doc.get(),
      set: async (doc: MockDoc, data: any) => doc.set(data),
      update: async (doc: MockDoc, patch: any) => doc.update(patch),
    };
    return await fn(tx);
  }
}

function baseSubmitting(now: number): ServerVideoTaskRecord {
  return {
    id: 'task_race',
    taskId: 'task_race',
    status: 'submitting',
    stateVersion: 3,
    statusVersion: 3,
    modelId: 'veo-3.1-fast-generate-001',
    projectId: 'test-project',
    region: 'us-central1',
    durationSeconds: 4,
    aspectRatio: '9:16',
    resolution: '1080p',
    generateAudio: false,
    pollAttempt: 0,
    createdAt: now - 53_000,
    updatedAt: now - 53_000,
    executionId: 'exec_live',
    leaseOwner: 'revision-live',
    leaseExpiresAt: now + 127_000,
    heartbeatAt: now - 53_000,
    providerSubmissionAuthorizedAt: now - 53_000,
    providerSubmissionAuthorizedExecutionId: 'exec_live',
    providerStorageTaskKey: 'task_race',
    expectedProviderStorageUri: 'gs://bucket/veo/task_race/',
  } as ServerVideoTaskRecord;
}

describe('Provider submission race hardening', () => {
  let db: MockFirestore;
  beforeEach(() => {
    db = new MockFirestore();
    setFirestoreInstanceForTesting(db as any);
    firestoreTaskRepository.resetDiagnostics();
  });
  afterEach(() => setFirestoreInstanceForTesting(null));

  it('does not classify a 53s in-flight submission as unknown while its durable lease is alive', async () => {
    const now = Date.now();
    await firestoreTaskRepository.createTask(baseSubmitting(now));
    const result = await taskStateMachineService.reconcileStaleSubmittingTask({ taskId: 'task_race', now });
    expect(result.markedUnknown).toBe(false);
    expect(result.task.status).toBe('submitting');
  });

  it('classifies a crashed submitting task as unknown only after its execution lease expires', async () => {
    const now = Date.now();
    const task = baseSubmitting(now);
    task.leaseExpiresAt = now - 1;
    await firestoreTaskRepository.createTask(task);
    const result = await taskStateMachineService.reconcileStaleSubmittingTask({ taskId: 'task_race', now });
    expect(result.markedUnknown).toBe(true);
    expect(result.task.status).toBe('submission_outcome_unknown');
    expect(result.task.retryMode).toBe('NO_RETRY');
  });

  it('atomically recovers an evidence-backed late Provider response from outcome_unknown to polling', async () => {
    const now = Date.now();
    const task = baseSubmitting(now);
    task.status = 'submission_outcome_unknown';
    task.error = 'stale unknown';
    task.failureReason = 'submission_outcome_unknown' as any;
    task.retryMode = 'NO_RETRY';
    await firestoreTaskRepository.createTask(task);

    const result = await taskStateMachineService.recordProviderSubmissionSuccess({
      taskId: 'task_race',
      executionId: 'exec_live',
      operationName: 'projects/p/locations/us-central1/publishers/google/models/veo/operations/op-123',
      diagnostics: { source: 'late-provider-response' },
    });
    expect(result.status).toBe('polling');
    expect(result.operationName).toContain('/operations/op-123');
    expect(result.providerOperationId).toBe(result.operationName);
    expect(result.error).toBeNull();
    expect(result.failureReason).toBeNull();
    expect(result.leaseExpiresAt).toBe(0);
  });

  it('rejects a late response that lacks durable provider authorization evidence', async () => {
    const now = Date.now();
    const task = baseSubmitting(now);
    task.providerSubmissionAuthorizedAt = undefined;
    task.providerSubmissionAuthorizedExecutionId = undefined;
    await firestoreTaskRepository.createTask(task);
    await expect(taskStateMachineService.recordProviderSubmissionSuccess({
      taskId: 'task_race',
      executionId: 'exec_live',
      operationName: 'operations/op-unauthorized',
    })).rejects.toThrow(/authorization evidence/i);
  });

  it('keeps server list read-side logic from mutating active 30s submissions and exposes artifact authority', () => {
    const server = fs.readFileSync('server.ts', 'utf8');
    expect(server).not.toContain("(now - rec.createdAt) > 30000");
    expect(server).not.toContain('if (isStuckWithoutOpName)');
    expect(server).toContain('reconcileStaleSubmittingTask');
    expect(server).toContain('recordProviderSubmissionSuccess');
    expect(server).toContain('artifactPersisted: Boolean(rec.artifactPersisted)');
    expect(server).toContain('videoDataUrl: rec.videoDataUrl || (rec.artifactPersisted');
  });

  it('makes Firestore active/unknown state authoritative over stale browser errors', () => {
    const reconciler = fs.readFileSync('src/services/tasks/taskReconciler.ts', 'utf8');
    expect(reconciler).toContain("serverStatus === 'submission_outcome_unknown'");
    expect(reconciler).toContain("serverStatus === 'submitted'");
    expect(reconciler).toContain('A stale browser/network 500 must never keep');
    expect(reconciler).toContain('serverMatch.resultVideoUrl');
  });
});
''')

print('state-machine provider race hardening patch applied')
