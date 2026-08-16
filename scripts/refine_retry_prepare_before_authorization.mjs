import fs from 'node:fs';

function replaceOnce(path, needle, replacement) {
  const source = fs.readFileSync(path, 'utf8');
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${path}: expected exactly one refinement anchor, found ${count}`);
  fs.writeFileSync(path, source.replace(needle, replacement));
}

const retryPath = 'src/server/services/durableVideoRetryService.ts';
let retry = fs.readFileSync(retryPath, 'utf8');

const classAnchor = `export class DurableVideoRetryService {`;
if (!retry.includes(classAnchor)) throw new Error('DurableVideoRetryService class anchor missing');
retry = retry.replace(classAnchor, `export interface PreparedVideoRetryInput {\n  firstFrame: Buffer;\n  firstFrameMimeType: string;\n  masterImages: Buffer[];\n  masterImageMimeTypes: string[];\n  prompt: string;\n  attemptTaskKey: string;\n  expectedStorageUri: string;\n}\n\nexport class DurableVideoRetryService {`);

const launchStart = retry.indexOf('  static async launch(params: {');
if (launchStart < 0) throw new Error('launch method start not found');
const classEnd = retry.lastIndexOf('\n}');
if (classEnd <= launchStart) throw new Error('class end not found');
const oldLaunch = retry.slice(launchStart, classEnd);
const newMethods = `  static async prepare(params: {\n    task: ServerVideoTaskRecord;\n    decision: VideoRetryDecision;\n    session: ActiveSession;\n  }): Promise<PreparedVideoRetryInput> {\n    const { task, decision, session } = params;\n\n    if (decision.action !== 'REGENERATE_VIDEO' || !decision.idempotencyKey) {\n      throw new Error('M2_4_RETRY_POLICY_VIOLATION: provider preparation requires REGENERATE_VIDEO decision and idempotency key');\n    }\n    if (task.providerRetryIdempotencyKey !== decision.idempotencyKey) {\n      throw new Error('M2_4_RETRY_PREPARATION_STALE: retry preparation no longer owns the task');\n    }\n    if (task.retrySubmissionState !== 'reserved' || task.retryProviderAuthorizedAt || task.retryProviderAuthorizedIdempotencyKey) {\n      throw new Error('M2_4_RETRY_PREPARATION_INVALID_STATE: retry preparation must happen before durable Provider authorization');\n    }\n    if (!task.qaApprovedFirstFrameObjectPath) {\n      throw new Error('M2_4_RETRY_INPUT_MISSING: approved first-frame anchor is missing');\n    }\n    if (!task.qaMasterImageObjectPaths?.length) {\n      throw new Error('M2_4_RETRY_INPUT_MISSING: character master anchors are missing');\n    }\n    if (!task.identitySpec) {\n      throw new Error('M2_4_RETRY_INPUT_MISSING: IdentitySpec is missing');\n    }\n\n    const bucket = task.outputBucket;\n    if (!bucket) {\n      throw new Error('M2_4_RETRY_INPUT_MISSING: artifact bucket is missing');\n    }\n\n    const attemptTaskKey = this.getAttemptTaskKey(task.taskId, decision.nextProviderAttempt);\n    const derivedStorageUri = resolveVeoStorageUri(attemptTaskKey);\n    if (task.providerStorageTaskKey !== attemptTaskKey || task.expectedProviderStorageUri !== derivedStorageUri) {\n      throw new Error(\n        \`M2_4_RETRY_STORAGE_INTENT_MISMATCH: durable storage intent does not match provider attempt \${decision.nextProviderAttempt}\`\n      );\n    }\n\n    // All fallible artifact I/O happens while the retry is still only reserved. A failure\n    // here is provably pre-Provider and can be safely terminated/retried.\n    const firstFrame = await gcsArtifactStore.fetchArtifactBuffer(\n      bucket,\n      task.qaApprovedFirstFrameObjectPath,\n      { session }\n    );\n    const masterImages = await Promise.all(\n      task.qaMasterImageObjectPaths.slice(0, 3).map((objectPath) =>\n        gcsArtifactStore.fetchArtifactBuffer(bucket, objectPath, { session })\n      )\n    );\n\n    const prompt =\n      task.veoSafePrompt ||\n      task.compiledPrompt ||\n      task.rawUserPrompt ||\n      'Natural subtle motion while preserving the approved character identity.';\n\n    return {\n      firstFrame,\n      firstFrameMimeType: task.qaApprovedFirstFrameMimeType || 'image/jpeg',\n      masterImages,\n      masterImageMimeTypes: task.qaMasterImageMimeTypes || [],\n      prompt,\n      attemptTaskKey,\n      expectedStorageUri: task.expectedProviderStorageUri,\n    };\n  }\n\n  static async launch(params: {\n    task: ServerVideoTaskRecord;\n    decision: VideoRetryDecision;\n    session: ActiveSession;\n    ai: GoogleGenAI;\n    prepared: PreparedVideoRetryInput;\n  }): Promise<VideoStartResult> {\n    const { task, decision, session, ai, prepared } = params;\n\n    if (decision.action !== 'REGENERATE_VIDEO' || !decision.idempotencyKey) {\n      throw new Error('M2_4_RETRY_POLICY_VIOLATION: provider launch requires REGENERATE_VIDEO decision and idempotency key');\n    }\n    if (\n      task.retrySubmissionState !== 'authorized' ||\n      !task.retryProviderAuthorizedAt ||\n      task.retryProviderAuthorizedIdempotencyKey !== decision.idempotencyKey\n    ) {\n      throw new Error('M2_4_RETRY_PROVIDER_NOT_AUTHORIZED: durable retry Provider authorization is required before launch');\n    }\n\n    const attemptTaskKey = this.getAttemptTaskKey(task.taskId, decision.nextProviderAttempt);\n    if (\n      prepared.attemptTaskKey !== attemptTaskKey ||\n      task.providerStorageTaskKey !== attemptTaskKey ||\n      prepared.expectedStorageUri !== task.expectedProviderStorageUri ||\n      task.expectedProviderStorageUri !== resolveVeoStorageUri(attemptTaskKey)\n    ) {\n      throw new Error('M2_4_RETRY_PREPARED_INPUT_STALE: prepared retry input no longer matches durable Provider intent');\n    }\n\n    // IMPORTANT: after durable authorization there is no artifact/network preparation left.\n    // The next asynchronous operation is the Provider generation call itself.\n    return await VideoGenerator.startVideoGeneration(\n      ai,\n      session,\n      task.modelId || session.videoModel || 'veo-3.1-fast-generate-001',\n      prepared.firstFrame,\n      prepared.firstFrameMimeType,\n      prepared.masterImages,\n      prepared.masterImageMimeTypes,\n      prepared.prompt,\n      task.identitySpec,\n      undefined,\n      decision.repairPromptAppend,\n      task.sceneMode,\n      task.characterDescription,\n      task.durationSeconds || 6,\n      prepared.attemptTaskKey,\n      prepared.expectedStorageUri\n    );\n  }\n`;
retry = retry.slice(0, launchStart) + newMethods + retry.slice(classEnd);
fs.writeFileSync(retryPath, retry);

const serverPath = 'server.ts';
replaceOnce(
  serverPath,
  `    if (!reservation.reserved) return reservation.task;\n\n    let authorizedRetryTask: ServerVideoTaskRecord;`,
  `    if (!reservation.reserved) return reservation.task;\n\n    let preparedRetry;\n    try {\n      preparedRetry = await DurableVideoRetryService.prepare({\n        task: reservation.task,\n        decision: retryDecision,\n        session,\n      });\n    } catch (preparationErr: any) {\n      const message = \`自动重试 Provider 输入准备失败，Veo 尚未进入调用窗口: \${preparationErr?.message || preparationErr}\`;\n      return await taskStateMachineService.failAutomaticRetryBeforeProvider({\n        taskId,\n        idempotencyKey: retryDecision.idempotencyKey,\n        message,\n      });\n    }\n\n    let authorizedRetryTask: ServerVideoTaskRecord;`
);
replaceOnce(
  serverPath,
  `      const retryStart = await DurableVideoRetryService.launch({\n        task: authorizedRetryTask,\n        decision: retryDecision,\n        session,\n        ai,\n      });`,
  `      const retryStart = await DurableVideoRetryService.launch({\n        task: authorizedRetryTask,\n        decision: retryDecision,\n        session,\n        ai,\n        prepared: preparedRetry,\n      });`
);

const reservationTest = 'src/__tests__/m24DurableRetryReservation.test.ts';
let test = fs.readFileSync(reservationTest, 'utf8');
const oldLaunchTest = `    await expect(DurableVideoRetryService.launch({\n      task: reserved.task, decision, session: {} as any, ai: {} as any,\n    })).rejects.toThrow('M2_4_RETRY_PROVIDER_NOT_AUTHORIZED');`;
const newLaunchTest = `    await expect(DurableVideoRetryService.launch({\n      task: reserved.task,\n      decision,\n      session: {} as any,\n      ai: {} as any,\n      prepared: {\n        firstFrame: Buffer.from('frame'),\n        firstFrameMimeType: 'image/jpeg',\n        masterImages: [Buffer.from('master')],\n        masterImageMimeTypes: ['image/jpeg'],\n        prompt: 'test',\n        attemptTaskKey: reserved.task.providerStorageTaskKey!,\n        expectedStorageUri: reserved.task.expectedProviderStorageUri!,\n      },\n    })).rejects.toThrow('M2_4_RETRY_PROVIDER_NOT_AUTHORIZED');`;
if (!test.includes(oldLaunchTest)) throw new Error('reserved launch test anchor missing');
test = test.replace(oldLaunchTest, newLaunchTest);
fs.writeFileSync(reservationTest, test);

const contractPath = 'src/__tests__/retryProviderAuthorizationBoundarySourceContract.test.ts';
let contract = fs.readFileSync(contractPath, 'utf8');
replaceOnce(
  contractPath,
  `  it('authorizes before launch and launch rejects a mere reservation', () => {\n    const authorizeIndex = server.indexOf('authorizeAutomaticProviderRetry({');\n    const launchIndex = server.indexOf('DurableVideoRetryService.launch({');\n    expect(authorizeIndex).toBeGreaterThan(-1);\n    expect(launchIndex).toBeGreaterThan(authorizeIndex);\n    expect(retry).toContain('M2_4_RETRY_PROVIDER_NOT_AUTHORIZED');\n  });`,
  `  it('finishes fallible preparation before authorization and Provider launch', () => {\n    const prepareIndex = server.indexOf('DurableVideoRetryService.prepare({');\n    const authorizeIndex = server.indexOf('authorizeAutomaticProviderRetry({');\n    const launchIndex = server.indexOf('DurableVideoRetryService.launch({');\n    expect(prepareIndex).toBeGreaterThan(-1);\n    expect(authorizeIndex).toBeGreaterThan(prepareIndex);\n    expect(launchIndex).toBeGreaterThan(authorizeIndex);\n\n    const prepareMethod = retry.indexOf('static async prepare');\n    const launchMethod = retry.indexOf('static async launch');\n    const providerCall = retry.indexOf('VideoGenerator.startVideoGeneration', launchMethod);\n    expect(prepareMethod).toBeGreaterThan(-1);\n    expect(retry.indexOf('fetchArtifactBuffer', prepareMethod)).toBeLessThan(launchMethod);\n    expect(launchMethod).toBeGreaterThan(prepareMethod);\n    expect(providerCall).toBeGreaterThan(launchMethod);\n    expect(retry.slice(launchMethod, providerCall)).not.toContain('fetchArtifactBuffer');\n    expect(retry).toContain('M2_4_RETRY_PROVIDER_NOT_AUTHORIZED');\n  });`
);

console.log('Moved all retry artifact I/O before durable Provider authorization.');
