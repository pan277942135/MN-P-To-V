import fs from 'node:fs';

const filePath = 'server.ts';
let source = fs.readFileSync(filePath, 'utf8');
let changed = false;

function replaceOnce(label, before, after) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`[provider-operation-linkage] missing anchor: ${label}`);
  source = source.replace(before, after);
  changed = true;
}

replaceOnce(
  'linkage policy import',
  "import { isProviderTaskDeletionSafe } from './src/server/services/providerAdmissionPolicy';",
  "import { isProviderTaskDeletionSafe } from './src/server/services/providerAdmissionPolicy';\nimport { evaluateProviderOperationLinkage } from './src/server/services/providerOperationRecoveryPolicy';"
);

const anchor = `      if (existing && existing.status === 'submission_outcome_unknown') {
        const reconciled = await taskStateMachineService.transitionTask({`;

const guarded = `      const expectedStoragePrefix = resolveVeoStorageUri(taskId);
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
        const reconciled = await taskStateMachineService.transitionTask({`;

replaceOnce('task-linked recovery guard', anchor, guarded);

replaceOnce(
  'existing recovery linked response',
  "          providerVerified: true,\n          providerDone: Boolean(verification.done),\n          message: '已绑定核实后的 Provider Operation，并恢复现有任务轮询；未发起新的 Veo 生成。',",
  "          providerVerified: true,\n          providerTaskLinked: true,\n          providerDone: Boolean(verification.done),\n          message: '已绑定经 GCS task 专属输出证明的 Provider Operation，并恢复现有任务轮询；未发起新的 Veo 生成。',"
);

replaceOnce(
  'missing recovery linked response',
  "        providerVerified: true,\n        providerDone: Boolean(verification.done),\n        message: '已核实 Provider Operation，并安全初始化 Firestore 恢复任务；未发起新的 Veo 生成。',",
  "        providerVerified: true,\n        providerTaskLinked: true,\n        providerDone: Boolean(verification.done),\n        message: '已通过 GCS task 专属输出核实 Provider Operation，并安全初始化 Firestore 恢复任务；未发起新的 Veo 生成。',"
);

if (changed) fs.writeFileSync(filePath, source);
console.log(`[provider-operation-linkage] ${changed ? 'server.ts refined' : 'already applied'}`);
