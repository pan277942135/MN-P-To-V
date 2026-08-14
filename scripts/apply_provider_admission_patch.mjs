import fs from 'node:fs';

function replaceOnce(source, label, before, after) {
  if (source.includes(after)) return { source, changed: false };
  if (!source.includes(before)) throw new Error(`[provider-admission-migration] missing anchor: ${label}`);
  return { source: source.replace(before, after), changed: true };
}

function replaceRegex(source, label, regex, replacement, marker) {
  if (marker && source.includes(marker)) return { source, changed: false };
  if (!regex.test(source)) throw new Error(`[provider-admission-migration] missing regex anchor: ${label}`);
  return { source: source.replace(regex, replacement), changed: true };
}

// ---- Firestore task repository: atomic task + provider-slot reservation ----
{
  const file = 'src/server/repositories/firestoreTaskRepository.ts';
  let source = fs.readFileSync(file, 'utf8');
  let changed = false;
  let r;

  r = replaceOnce(
    source,
    'provider admission imports',
    "import { getFirestoreInstance, isFirestoreAvailable, markFirestoreUnavailable } from '../db/firestore';",
    "import { getFirestoreInstance, isFirestoreAvailable, markFirestoreUnavailable } from '../db/firestore';\nimport { buildProviderAdmissionScopeKey, isProviderAdmissionBlockingTask, ProviderAdmissionBusyError } from '../services/providerAdmissionPolicy';"
  ); source = r.source; changed ||= r.changed;

  r = replaceOnce(
    source,
    'provider admission collection',
    "  private collectionName = 'video_tasks';",
    "  private collectionName = 'video_tasks';\n  private providerAdmissionCollectionName = 'video_provider_admission';"
  ); source = r.source; changed ||= r.changed;

  const createTaskMethod = `  public async createTask(record: ServerVideoTaskRecord): Promise<void> {
    const db = getFirestoreInstance();
    if (!db) {
      throw new Error('[FirestoreTaskRepository] Firestore is unavailable. Cannot create task.');
    }

    const taskId = record.taskId || record.id;
    if (!taskId) {
      throw new Error('[FirestoreTaskRepository] Invalid record: missing taskId');
    }

    assertCompletedInvariant(record);

    return this.withRetry('createTask', true, async () => {
      const docRef = db.collection(this.collectionName).doc(taskId);
      const scopeKey = buildProviderAdmissionScopeKey(record.projectId);
      const admissionRef = db.collection(this.providerAdmissionCollectionName).doc(scopeKey);
      const now = Date.now();
      const payload = sanitizeForFirestore({
        ...record,
        taskId,
        id: record.id || taskId,
        evidenceSource: 'firestore',
        stateVersion: record.stateVersion ?? record.statusVersion ?? 1,
        statusVersion: record.statusVersion ?? record.stateVersion ?? 1,
        updatedAt: record.updatedAt || now,
        createdAt: record.createdAt || now,
      });

      // Atomic cross-instance admission boundary: task creation and provider-slot
      // reservation commit together. No process-local lock participates in correctness.
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(docRef);
        if (snap.exists) {
          throw createAlreadyExistsError(taskId);
        }

        const admissionSnap = await transaction.get(admissionRef);
        const admissionData = admissionSnap.exists ? (admissionSnap.data() as any) : null;
        const incumbentTaskId = String(admissionData?.taskId || '');

        if (incumbentTaskId && incumbentTaskId !== taskId) {
          const incumbentRef = db.collection(this.collectionName).doc(incumbentTaskId);
          const incumbentSnap = await transaction.get(incumbentRef);
          if (incumbentSnap.exists) {
            const incumbentTask = {
              ...(incumbentSnap.data() as ServerVideoTaskRecord),
              taskId: (incumbentSnap.data() as ServerVideoTaskRecord).taskId || incumbentTaskId,
              evidenceSource: 'firestore' as const,
            } as ServerVideoTaskRecord;
            if (isProviderAdmissionBlockingTask(incumbentTask)) {
              throw new ProviderAdmissionBusyError({
                blockingTaskId: incumbentTask.taskId || incumbentTaskId,
                blockingStatus: incumbentTask.status,
                scopeKey,
              });
            }
          }
        }

        transaction.set(docRef, payload);
        transaction.set(admissionRef, sanitizeForFirestore({
          scopeKey,
          taskId,
          projectId: record.projectId || '',
          acquiredAt: now,
          updatedAt: now,
          authority: 'firestore',
        }));
      });
    });
  }
`;

  r = replaceRegex(
    source,
    'createTask method',
    /  public async createTask\(record: ServerVideoTaskRecord\): Promise<void> \{[\s\S]*?\n  \}\n\n  public async getTask/,
    createTaskMethod + '\n  public async getTask',
    'Atomic cross-instance admission boundary:'
  ); source = r.source; changed ||= r.changed;

  if (changed) fs.writeFileSync(file, source);
  console.log(`[provider-admission-migration] ${file}: ${changed ? 'updated' : 'already applied'}`);
}

// ---- State machine: ambiguous submit is a legal fail-closed state ----
{
  const file = 'src/server/services/taskStateMachineService.ts';
  let source = fs.readFileSync(file, 'utf8');
  const before = "  submitting: ['submitted', 'preparing', 'generating', 'failed', 'cancelled', 'canceled'],";
  const after = "  submitting: ['submitted', 'preparing', 'generating', 'submission_outcome_unknown', 'failed', 'cancelled', 'canceled'],";
  if (!source.includes(after)) {
    if (!source.includes(before)) throw new Error('[provider-admission-migration] state transition anchor missing');
    source = source.replace(before, after);
    fs.writeFileSync(file, source);
    console.log(`[provider-admission-migration] ${file}: updated`);
  } else {
    console.log(`[provider-admission-migration] ${file}: already applied`);
  }
}

// ---- Server route behavior ----
{
  const file = 'server.ts';
  let source = fs.readFileSync(file, 'utf8');
  let changed = false;
  let r;

  const busyBlock = `        const admissionBusy = fsErr?.code === 'PROVIDER_ADMISSION_BUSY';
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

`;
  r = replaceOnce(
    source,
    'provider busy response',
    "        const isQuotaOrTransient =\n",
    busyBlock + "        const isQuotaOrTransient =\n"
  ); source = r.source; changed ||= r.changed;

  const newInvokeCatch = `        } catch (invokeErr: any) {
          console.error(\`[Video Start Failed] Task \${taskId} 提交失败:\`, invokeErr);
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
`;
  r = replaceRegex(
    source,
    'ambiguous provider submit catch',
    /        \} catch \(invokeErr: any\) \{[\s\S]*?\n        \}\n      \}\)\(\);/,
    newInvokeCatch + '      })();',
    'const isAmbiguousSubmitFailure ='
  ); source = r.source; changed ||= r.changed;

  r = replaceOnce(
    source,
    'submission state response',
    "        submissionState: durableTask?.operationName ? 'submitted' : 'submitting',",
    "        submissionState: durableTask?.status === 'submission_outcome_unknown' ? 'outcome_unknown' : (durableTask?.operationName ? 'submitted' : 'submitting'),"
  ); source = r.source; changed ||= r.changed;

  const safeTimeoutBlock = `          // A missing operation after the request durability window is ambiguous, not a
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

`;
  r = replaceRegex(
    source,
    'fail-closed list timeout handling',
    /          \/\/ Auto-fail tasks stuck without operationName[\s\S]*?\n          const isCompletedWithoutVideo/,
    safeTimeoutBlock + '          const isCompletedWithoutVideo',
    'const isKnownOperationTimedOut = Boolean(rec.operationName)'
  ); source = r.source; changed ||= r.changed;

  if (changed) fs.writeFileSync(file, source);
  console.log(`[provider-admission-migration] ${file}: ${changed ? 'updated' : 'already applied'}`);
}
