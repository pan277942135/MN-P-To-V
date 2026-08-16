import fs from 'node:fs';

function replaceOnce(path, needle, replacement) {
  const source = fs.readFileSync(path, 'utf8');
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${path}: expected exactly one finalization anchor, found ${count}`);
  fs.writeFileSync(path, source.replace(needle, replacement));
}

const statePath = 'src/server/services/taskStateMachineService.ts';
replaceOnce(
  statePath,
  "        failureReason: 'pre_provider_authorization_failed' as any,",
  "        failureReason: 'pre_provider_authorization_failed',"
);
replaceOnce(
  statePath,
  "        failureReason: 'pre_provider_abandoned' as any,",
  "        failureReason: 'pre_provider_abandoned',"
);

const testPath = 'src/__tests__/preProviderDurabilityBoundary.test.ts';
replaceOnce(
  testPath,
  `  it('reconciles an expired preparing lease to safe failure but leaves a fresh lease alone', async () => {`,
  `  it('never downgrades a durably authorized submitting task to safe-to-regenerate failure', async () => {\n    const task = preparingTask('prep_no_downgrade');\n    await firestoreTaskRepository.createTask(task);\n    const authorized = await taskStateMachineService.authorizeProviderSubmission({\n      taskId: task.taskId, executionId: task.executionId!, providerStorageTaskKey: task.providerStorageTaskKey!,\n      expectedProviderStorageUri: task.expectedProviderStorageUri!,\n    });\n    expect(authorized.status).toBe('submitting');\n\n    const afterFailureAttempt = await taskStateMachineService.failPreparingBeforeProvider({\n      taskId: task.taskId, executionId: task.executionId!, message: 'ambiguous authorization response',\n    });\n    expect(afterFailureAttempt.status).toBe('submitting');\n    expect(afterFailureAttempt.providerSubmissionAuthorizedAt).toBe(authorized.providerSubmissionAuthorizedAt);\n    expect(afterFailureAttempt.retryMode).not.toBe('SAFE_TO_REGENERATE');\n  });\n\n  it('keeps inconsistent preparing records with Provider authorization evidence fail-closed', async () => {\n    const task = preparingTask('prep_inconsistent', Date.now() - 1);\n    task.providerSubmissionAuthorizedAt = Date.now() - 1000;\n    task.providerSubmissionAuthorizedExecutionId = task.executionId;\n    await firestoreTaskRepository.createTask(task);\n\n    const result = await taskStateMachineService.reconcileStalePreparingTask({ taskId: task.taskId });\n    expect(result.failed).toBe(false);\n    expect(result.task.status).toBe('preparing');\n    expect(result.task.providerSubmissionAuthorizedAt).toBe(task.providerSubmissionAuthorizedAt);\n  });\n\n  it('reconciles an expired preparing lease to safe failure but leaves a fresh lease alone', async () => {`
);

fs.writeFileSync(testPath, fs.readFileSync(testPath, 'utf8'));
console.log('Finalized pre-provider safety assertions and first-class failure reasons.');
