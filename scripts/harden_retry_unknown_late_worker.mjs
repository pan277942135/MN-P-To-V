import fs from 'node:fs';

function replaceOnce(path, needle, replacement) {
  const source = fs.readFileSync(path, 'utf8');
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${path}: expected exactly one hardening anchor, found ${count}`);
  fs.writeFileSync(path, source.replace(needle, replacement));
}

const statePath = 'src/server/services/taskStateMachineService.ts';
replaceOnce(
  statePath,
  `      if (\n        !currentTask.retryProviderAuthorizedAt ||\n        currentTask.retryProviderAuthorizedIdempotencyKey !== idempotencyKey\n      ) {\n        throw new Error(\`[M2_4_RETRY_OUTCOME_UNKNOWN_BEFORE_AUTHORIZATION] Retry \${idempotencyKey} has no durable Provider authorization evidence.\`);\n      }`,
  `      if (\n        !currentTask.retryProviderAuthorizedAt ||\n        currentTask.retryProviderAuthorizedIdempotencyKey !== idempotencyKey\n      ) {\n        throw new Error(\`[M2_4_RETRY_OUTCOME_UNKNOWN_BEFORE_AUTHORIZATION] Retry \${idempotencyKey} has no durable Provider authorization evidence.\`);\n      }\n      if (currentTask.status !== 'generating' || currentTask.retrySubmissionState !== 'authorized') {\n        throw new Error(\`[M2_4_RETRY_OUTCOME_UNKNOWN_INVALID_STATE] Retry \${idempotencyKey} is already \${currentTask.status}/\${currentTask.retrySubmissionState || 'unset'}; refusing late unknown overwrite.\`);\n      }`
);

const testPath = 'src/__tests__/m24RetryOutcomeUnknown.test.ts';
replaceOnce(
  testPath,
  `  it('refuses to manufacture unknown from a reservation with no Provider authorization evidence', async () => {`,
  `  it('refuses a late unknown write after the authorized retry has already been submitted', async () => {\n    const task = retryTask('retry_late_worker', 'authorized');\n    await firestoreTaskRepository.createTask(task);\n    await firestoreTaskRepository.updateTask(task.taskId, {\n      status: 'polling',\n      retrySubmissionState: 'submitted',\n      operationName: 'projects/test/locations/us-central1/operations/already-submitted',\n      providerOperationId: 'projects/test/locations/us-central1/operations/already-submitted',\n    });\n\n    await expect(taskStateMachineService.markAutomaticRetryOutcomeUnknown({\n      taskId: task.taskId, idempotencyKey: task.providerRetryIdempotencyKey!, message: 'late worker',\n    })).rejects.toThrow('M2_4_RETRY_OUTCOME_UNKNOWN_INVALID_STATE');\n\n    const stored = await firestoreTaskRepository.getTask(task.taskId);\n    expect(stored?.status).toBe('polling');\n    expect(stored?.retrySubmissionState).toBe('submitted');\n  });\n\n  it('refuses to manufacture unknown from a reservation with no Provider authorization evidence', async () => {`
);

const contractPath = 'src/__tests__/retryProviderAuthorizationBoundarySourceContract.test.ts';
replaceOnce(
  contractPath,
  `    expect(state).toContain('M2_4_RETRY_OUTCOME_UNKNOWN_BEFORE_AUTHORIZATION');`,
  `    expect(state).toContain('M2_4_RETRY_OUTCOME_UNKNOWN_BEFORE_AUTHORIZATION');\n    expect(state).toContain('M2_4_RETRY_OUTCOME_UNKNOWN_INVALID_STATE');\n    expect(state).toContain("currentTask.status !== 'generating' || currentTask.retrySubmissionState !== 'authorized'");`
);

console.log('Hardened automatic retry unknown transition against late-worker overwrites.');
