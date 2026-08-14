import fs from 'node:fs';

const filePath = 'server.ts';
let source = fs.readFileSync(filePath, 'utf8');
let changed = false;

function replaceOnce(label, before, after) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`[provider-slot-recovery] missing anchor: ${label}`);
  source = source.replace(before, after);
  changed = true;
}

function replaceRegex(label, regex, replacement, marker) {
  if (marker && source.includes(marker)) return;
  if (!regex.test(source)) throw new Error(`[provider-slot-recovery] missing regex anchor: ${label}`);
  source = source.replace(regex, replacement);
  changed = true;
}

replaceOnce(
  'provider deletion safety import',
  "import { taskStateMachineService, InvalidStateTransitionError } from './src/server/services/taskStateMachineService';",
  "import { taskStateMachineService, InvalidStateTransitionError } from './src/server/services/taskStateMachineService';\nimport { isProviderTaskDeletionSafe } from './src/server/services/providerAdmissionPolicy';"
);

replaceOnce(
  'unknown idempotent reuse status',
  "if (['submitting', 'submitted', 'polling', 'polling_timeout', 'generation_succeeded', 'artifact_persisting', 'artifact_persisted', 'qa_pending'].includes(durableExisting.status as string)) {",
  "if (['submitting', 'submitted', 'polling', 'polling_timeout', 'generation_succeeded', 'artifact_persisting', 'artifact_persisted', 'qa_pending', 'submission_outcome_unknown'].includes(durableExisting.status as string)) {"
);

replaceOnce(
  'unknown idempotent response state',
  "              submissionState: 'submitted',\n              operationNamePresent: Boolean(durableExisting.operationName),\n              isIdempotentReuse: true,",
  "              submissionState: durableExisting.status === 'submission_outcome_unknown'\n                ? 'outcome_unknown'\n                : (durableExisting.operationName ? 'submitted' : 'submitting'),\n              operationNamePresent: Boolean(durableExisting.operationName),\n              isIdempotentReuse: true,"
);

const deleteRoute = `  // Delete Single Video Task Endpoint
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
`;
replaceRegex(
  'delete route',
  /  \/\/ Delete Single Video Task Endpoint[\s\S]*?\n  \}\);\n\n  \/\/ Clear All Failed Tasks Endpoint/,
  deleteRoute + '\n  // Clear All Failed Tasks Endpoint',
  "failureReason: 'provider_task_delete_blocked'"
);

const clearFailedRoute = `  // Clear All Failed Tasks Endpoint
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
`;
replaceRegex(
  'clear failed route',
  /  \/\/ Clear All Failed Tasks Endpoint[\s\S]*?\n  \}\);\n\n  \/\/ Task Recovery Endpoint/,
  clearFailedRoute + '\n  // Task Recovery Endpoint',
  'let protectedCount = 0;'
);

const recoveryRoute = `  // Task Recovery Endpoint
  app.post('/api/videos/recover-task', async (req, res) => {
    try {
      const { taskId, operationName, modelId, durationSeconds } = req.body;
      if (!taskId || !operationName) {
        return res.status(400).json({ error: 'taskId 与 operationName 为必填项' });
      }
      const operationNameString = String(operationName).trim();
      const operationNameLooksValid = operationNameString.length <= 2048
        && !/\\s/.test(operationNameString)
        && /(^|\\/)operations\\/[^/]+$/.test(operationNameString);
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
          providerDone: Boolean(verification.done),
          message: '已绑定核实后的 Provider Operation，并恢复现有任务轮询；未发起新的 Veo 生成。',
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
        providerDone: Boolean(verification.done),
        message: '已核实 Provider Operation，并安全初始化 Firestore 恢复任务；未发起新的 Veo 生成。',
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
`;
replaceRegex(
  'recover task route',
  /  \/\/ Task Recovery Endpoint[\s\S]*?\n  \}\);\n\n  \/\/ Debug endpoint for task store inspection/,
  recoveryRoute + '\n  // Debug endpoint for task store inspection',
  "failureReason: 'provider_operation_not_verified'"
);

if (changed) fs.writeFileSync(filePath, source);
console.log(`[provider-slot-recovery] ${changed ? 'server.ts updated' : 'already applied'}`);
