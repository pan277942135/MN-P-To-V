import fs from 'node:fs';

function replaceOnce(path, needle, replacement) {
  const source = fs.readFileSync(path, 'utf8');
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${path}: expected exactly one patch anchor, found ${count}`);
  fs.writeFileSync(path, source.replace(needle, replacement));
}

// 1) Durable task schema: record exactly where this provider attempt was instructed to write.
replaceOnce(
  'src/types/index.ts',
  `  providerAttempt?: number;\n  qaAttempt?: number;`,
  `  providerAttempt?: number;\n  providerStorageTaskKey?: string;\n  expectedProviderStorageUri?: string;\n  providerStorageIntentPersistedAt?: number;\n  qaAttempt?: number;`
);

// 2) The low-level provider request accepts the already-durable URI instead of silently recomputing it.
replaceOnce(
  'src/services/video/videoGenerator.ts',
  `    characterDescription?: string,\n    durationSeconds = 6,\n    taskId?: string\n  ): Promise<VideoStartResult> {`,
  `    characterDescription?: string,\n    durationSeconds = 6,\n    taskId?: string,\n    expectedStorageUri?: string\n  ): Promise<VideoStartResult> {`
);
replaceOnce(
  'src/services/video/videoGenerator.ts',
  `            durationSeconds,\n            taskId,\n          }),`,
  `            durationSeconds,\n            taskId,\n            storageUri: expectedStorageUri,\n          }),`
);

// 3) Retry reservation must atomically persist the next attempt storage intent before launch.
replaceOnce(
  'src/server/services/taskStateMachineService.ts',
  `  public async reserveAutomaticProviderRetry(params: {\n    taskId: string;\n    decision: any;\n    diagnosisCode?: string;\n  }): Promise<{ reserved: boolean; task: ServerVideoTaskRecord }> {\n    const { taskId, decision, diagnosisCode } = params;`,
  `  public async reserveAutomaticProviderRetry(params: {\n    taskId: string;\n    decision: any;\n    diagnosisCode?: string;\n    providerStorageTaskKey: string;\n    expectedProviderStorageUri: string;\n  }): Promise<{ reserved: boolean; task: ServerVideoTaskRecord }> {\n    const { taskId, decision, diagnosisCode, providerStorageTaskKey, expectedProviderStorageUri } = params;`
);
replaceOnce(
  'src/server/services/taskStateMachineService.ts',
  `    if (decision?.action !== 'REGENERATE_VIDEO' || !decision?.idempotencyKey) {\n      throw new Error('[M2_4_RETRY_RESERVATION_INVALID] REGENERATE_VIDEO decision with idempotency key is required.');\n    }\n\n    return await firestoreTaskRepository.runTaskTransaction`,
  `    if (decision?.action !== 'REGENERATE_VIDEO' || !decision?.idempotencyKey) {\n      throw new Error('[M2_4_RETRY_RESERVATION_INVALID] REGENERATE_VIDEO decision with idempotency key is required.');\n    }\n    const expectedTaskKey = decision.nextProviderAttempt <= 1\n      ? taskId\n      : \`${'${taskId}'}/attempts/${'${decision.nextProviderAttempt}'}\`;\n    const normalizedStorageUri = String(expectedProviderStorageUri || '').trim();\n    if (providerStorageTaskKey !== expectedTaskKey) {\n      throw new Error(\`[M2_4_RETRY_STORAGE_INTENT_MISMATCH] expected task key ${'${expectedTaskKey}'} but received ${'${providerStorageTaskKey || \'empty\'}'}\`);\n    }\n    if (!normalizedStorageUri.startsWith('gs://') || !normalizedStorageUri.endsWith(\`/veo/${'${providerStorageTaskKey}'}/\`)) {\n      throw new Error('[M2_4_RETRY_STORAGE_INTENT_INVALID] expectedProviderStorageUri must target the exact reserved providerStorageTaskKey.');\n    }\n\n    return await firestoreTaskRepository.runTaskTransaction`
);
replaceOnce(
  'src/server/services/taskStateMachineService.ts',
  `        providerAttempt: decision.nextProviderAttempt,\n        qaAttempt: 1,`,
  `        providerAttempt: decision.nextProviderAttempt,\n        providerStorageTaskKey,\n        expectedProviderStorageUri: normalizedStorageUri,\n        providerStorageIntentPersistedAt: now,\n        qaAttempt: 1,`
);

// 4) Retry launcher refuses to call Veo unless the reservation's durable intent matches exactly.
replaceOnce(
  'src/server/services/durableVideoRetryService.ts',
  `import { gcsArtifactStore } from '../storage/gcsArtifactStore';`,
  `import { gcsArtifactStore, resolveVeoStorageUri } from '../storage/gcsArtifactStore';`
);
replaceOnce(
  'src/server/services/durableVideoRetryService.ts',
  `    const attemptTaskKey = this.getAttemptTaskKey(task.taskId, decision.nextProviderAttempt);\n\n    return await VideoGenerator.startVideoGeneration(`,
  `    const attemptTaskKey = this.getAttemptTaskKey(task.taskId, decision.nextProviderAttempt);\n    const derivedStorageUri = resolveVeoStorageUri(attemptTaskKey);\n    if (task.providerStorageTaskKey !== attemptTaskKey || task.expectedProviderStorageUri !== derivedStorageUri) {\n      throw new Error(\n        \`M2_4_RETRY_STORAGE_INTENT_MISMATCH: durable storage intent does not match provider attempt ${'${decision.nextProviderAttempt}'}\`\n      );\n    }\n\n    return await VideoGenerator.startVideoGeneration(`
);
replaceOnce(
  'src/server/services/durableVideoRetryService.ts',
  `      task.durationSeconds || 6,\n      attemptTaskKey\n    );`,
  `      task.durationSeconds || 6,\n      attemptTaskKey,\n      task.expectedProviderStorageUri\n    );`
);

// 5) Initial task persists storage intent in Firestore before the provider call, then passes the same URI downstream.
replaceOnce(
  'server.ts',
  `      const taskId = req.body.taskId || \`vtask_${'${Date.now()}'}_${'${Math.random().toString(36).substring(2, 7)}'}\`;\n      const now = Date.now();`,
  `      const taskId = req.body.taskId || \`vtask_${'${Date.now()}'}_${'${Math.random().toString(36).substring(2, 7)}'}\`;\n      const now = Date.now();\n      const providerStorageTaskKey = DurableVideoRetryService.getAttemptTaskKey(taskId, 1);\n      const expectedProviderStorageUri = resolveVeoStorageUri(providerStorageTaskKey);`
);
replaceOnce(
  'server.ts',
  `        providerAttempt: 1,\n        qaAttempt: 1,`,
  `        providerAttempt: 1,\n        providerStorageTaskKey,\n        expectedProviderStorageUri,\n        providerStorageIntentPersistedAt: now,\n        qaAttempt: 1,`
);
replaceOnce(
  'server.ts',
  `              durationSeconds,\n              taskId\n            ),`,
  `              durationSeconds,\n              taskId,\n              expectedProviderStorageUri\n            ),`
);

// 6) Every automatic retry computes and reserves the exact intent before launch.
replaceOnce(
  'server.ts',
  `  if (retryDecision.action === 'REGENERATE_VIDEO' && retryDecision.idempotencyKey) {\n    const reservation = await taskStateMachineService.reserveAutomaticProviderRetry({\n      taskId,\n      decision: retryDecision,\n      diagnosisCode: failureDiagnosis?.primaryCode,\n    });`,
  `  if (retryDecision.action === 'REGENERATE_VIDEO' && retryDecision.idempotencyKey) {\n    const retryProviderStorageTaskKey = DurableVideoRetryService.getAttemptTaskKey(\n      taskId,\n      retryDecision.nextProviderAttempt\n    );\n    const retryExpectedProviderStorageUri = resolveVeoStorageUri(retryProviderStorageTaskKey);\n    const reservation = await taskStateMachineService.reserveAutomaticProviderRetry({\n      taskId,\n      decision: retryDecision,\n      diagnosisCode: failureDiagnosis?.primaryCode,\n      providerStorageTaskKey: retryProviderStorageTaskKey,\n      expectedProviderStorageUri: retryExpectedProviderStorageUri,\n    });`
);

// 7) Recovery trusts persisted intent only when it agrees with current attempt semantics/config; otherwise fail closed.
replaceOnce(
  'server.ts',
  `        const providerAttempt = Math.max(1, Number(rec.providerAttempt) || 1);\n        const recoveryTaskKey = DurableVideoRetryService.getAttemptTaskKey(taskId, providerAttempt);\n        const discovery = await gcsArtifactStore.discoverTaskPrefixVideo({`,
  `        const providerAttempt = Math.max(1, Number(rec.providerAttempt) || 1);\n        const derivedRecoveryTaskKey = DurableVideoRetryService.getAttemptTaskKey(taskId, providerAttempt);\n        const persistedStorageTaskKey = String(rec.providerStorageTaskKey || '').trim();\n        const persistedExpectedStorageUri = String(rec.expectedProviderStorageUri || '').trim();\n        const hasAnyPersistedStorageIntent = Boolean(persistedStorageTaskKey || persistedExpectedStorageUri);\n        const hasCompletePersistedStorageIntent = Boolean(persistedStorageTaskKey && persistedExpectedStorageUri);\n        const recoveryTaskKey = persistedStorageTaskKey || derivedRecoveryTaskKey;\n        const derivedExpectedStorageUri = resolveVeoStorageUri(recoveryTaskKey);\n\n        if (\n          (hasAnyPersistedStorageIntent && !hasCompletePersistedStorageIntent) ||\n          (persistedStorageTaskKey && persistedStorageTaskKey !== derivedRecoveryTaskKey) ||\n          (persistedExpectedStorageUri && persistedExpectedStorageUri !== derivedExpectedStorageUri)\n        ) {\n          return res.status(409).json({\n            success: false,\n            providerTaskLinked: false,\n            failureReason: 'provider_storage_intent_mismatch',\n            status: 'submission_outcome_unknown',\n            providerAttempt,\n            persistedStorageTaskKey: persistedStorageTaskKey || null,\n            persistedExpectedStorageUri: persistedExpectedStorageUri || null,\n            derivedRecoveryTaskKey,\n            derivedExpectedStorageUri,\n            predictLongRunningCalls: 0,\n            error: 'Provider 存储意图与当前任务/配置不一致。为避免扫描错误路径或误绑定其他产物，任务继续锁定。',\n            storageAuthority: 'firestore',\n          });\n        }\n\n        const discovery = await gcsArtifactStore.discoverTaskPrefixVideo({`
);

// 8) Update durable retry unit tests to prove storage intent is reserved atomically and rejects mismatch.
const retryTestPath = 'src/__tests__/m24DurableRetryReservation.test.ts';
replaceOnce(
  retryTestPath,
  `const diagnosis: any = {`,
  `const storageIntent = (taskId: string, providerAttempt = 2) => ({\n  providerStorageTaskKey: providerAttempt <= 1 ? taskId : \`${'${taskId}'}/attempts/${'${providerAttempt}'}\`,\n  expectedProviderStorageUri: \`gs://test-bucket/veo/${'${providerAttempt <= 1 ? taskId : `${taskId}/attempts/${providerAttempt}`}'}\/\`,\n});\n\nconst diagnosis: any = {`
);
replaceOnce(
  retryTestPath,
  `      diagnosisCode: diagnosis.primaryCode,\n    });\n\n    expect(reserved.reserved).toBe(true);`,
  `      diagnosisCode: diagnosis.primaryCode,\n      ...storageIntent(task.taskId, decision.nextProviderAttempt),\n    });\n\n    expect(reserved.reserved).toBe(true);`
);
replaceOnce(
  retryTestPath,
  `    expect(reserved.task.providerAttempt).toBe(2);\n    expect(reserved.task.retryCount).toBe(1);`,
  `    expect(reserved.task.providerAttempt).toBe(2);\n    expect(reserved.task.providerStorageTaskKey).toBe(\`retry_reserve/attempts/2\`);\n    expect(reserved.task.expectedProviderStorageUri).toBe(\`gs://test-bucket/veo/retry_reserve/attempts/2/\`);\n    expect(reserved.task.providerStorageIntentPersistedAt).toBeTypeOf('number');\n    expect(reserved.task.retryCount).toBe(1);`
);
// Duplicate reservation test has two calls; patch both call blocks by replacing exact remaining occurrences.
let retryTest = fs.readFileSync(retryTestPath, 'utf8');
retryTest = retryTest.replaceAll(
  `      diagnosisCode: diagnosis.primaryCode,\n    });`,
  `      diagnosisCode: diagnosis.primaryCode,\n      ...storageIntent(task.taskId, decision.nextProviderAttempt),\n    });`
);
fs.writeFileSync(retryTestPath, retryTest);

replaceOnce(
  retryTestPath,
  `  it('marks the reserved retry as submitted only when idempotency key still owns the task', async () => {`,
  `  it('fails before reservation when storage intent targets a different provider attempt', async () => {\n    const task = qaPendingTask('retry_bad_intent');\n    await firestoreTaskRepository.createTask(task);\n    const decision = VideoRetryPolicyService.decide({\n      taskId: task.taskId,\n      qaReport,\n      diagnosis,\n      providerAttempt: 1,\n      qaAttempt: 1,\n      artifactObjectPath: task.outputObjectPath,\n    });\n\n    await expect(taskStateMachineService.reserveAutomaticProviderRetry({\n      taskId: task.taskId,\n      decision,\n      diagnosisCode: diagnosis.primaryCode,\n      providerStorageTaskKey: task.taskId,\n      expectedProviderStorageUri: \`gs://test-bucket/veo/${'${task.taskId}'}/\`,\n    })).rejects.toThrow('M2_4_RETRY_STORAGE_INTENT_MISMATCH');\n\n    const untouched = await firestoreTaskRepository.getTask(task.taskId);\n    expect(untouched?.status).toBe('qa_pending');\n    expect(untouched?.providerAttempt).toBe(1);\n  });\n\n  it('marks the reserved retry as submitted only when idempotency key still owns the task', async () => {`
);

// 9) Focused source contract for initial persistence, retry reservation, exact downstream binding, and fail-closed recovery.
fs.writeFileSync('src/__tests__/providerStorageIntentSourceContract.test.ts', `import { readFileSync } from 'node:fs';\nimport { describe, expect, it } from 'vitest';\n\nconst server = readFileSync('server.ts', 'utf8');\nconst types = readFileSync('src/types/index.ts', 'utf8');\nconst state = readFileSync('src/server/services/taskStateMachineService.ts', 'utf8');\nconst retry = readFileSync('src/server/services/durableVideoRetryService.ts', 'utf8');\nconst generator = readFileSync('src/services/video/videoGenerator.ts', 'utf8');\n\ndescribe('durable provider storage intent source contract', () => {\n  it('persists initial attempt storage intent before createTask/provider launch', () => {\n    expect(types).toContain('providerStorageTaskKey?: string');\n    expect(types).toContain('expectedProviderStorageUri?: string');\n    expect(types).toContain('providerStorageIntentPersistedAt?: number');\n    const intentIndex = server.indexOf('const providerStorageTaskKey = DurableVideoRetryService.getAttemptTaskKey(taskId, 1)');\n    const recordIndex = server.indexOf('const taskRecord: ServerVideoTaskRecord');\n    const createIndex = server.indexOf('await firestoreTaskRepository.createTask(taskRecord)');\n    const providerIndex = server.indexOf('VideoGenerator.startVideoGeneration(');\n    expect(intentIndex).toBeGreaterThan(-1);\n    expect(intentIndex).toBeLessThan(recordIndex);\n    expect(recordIndex).toBeLessThan(createIndex);\n    expect(createIndex).toBeLessThan(providerIndex);\n    expect(server).toContain('providerStorageIntentPersistedAt: now');\n  });\n\n  it('binds the actual Vertex request to the already-durable expected storage URI', () => {\n    expect(server).toContain('taskId,\\n              expectedProviderStorageUri');\n    expect(generator).toContain('expectedStorageUri?: string');\n    expect(generator).toContain('storageUri: expectedStorageUri');\n  });\n\n  it('reserves retry storage intent atomically before launch and revalidates it at launch', () => {\n    expect(server).toContain('retryProviderStorageTaskKey');\n    expect(server).toContain('retryExpectedProviderStorageUri');\n    expect(state).toContain('providerStorageTaskKey: string');\n    expect(state).toContain('expectedProviderStorageUri: string');\n    expect(state).toContain('providerStorageIntentPersistedAt: now');\n    expect(retry).toContain('M2_4_RETRY_STORAGE_INTENT_MISMATCH');\n    expect(retry).toContain('task.expectedProviderStorageUri !== derivedStorageUri');\n    expect(retry).toContain('task.expectedProviderStorageUri\\n    );');\n  });\n\n  it('fails closed on persisted/derived intent mismatch while retaining legacy derived fallback', () => {\n    expect(server).toContain("failureReason: 'provider_storage_intent_mismatch'");\n    expect(server).toContain('predictLongRunningCalls: 0');\n    expect(server).toContain('const recoveryTaskKey = persistedStorageTaskKey || derivedRecoveryTaskKey');\n    expect(server).toContain('hasAnyPersistedStorageIntent && !hasCompletePersistedStorageIntent');\n    expect(server).toContain('persistedExpectedStorageUri !== derivedExpectedStorageUri');\n  });\n});\n`);

console.log('Applied durable provider storage intent patch.');
