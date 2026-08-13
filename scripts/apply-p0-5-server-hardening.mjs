import fs from 'node:fs';

const file = 'server.ts';
let src = fs.readFileSync(file, 'utf8');
const original = src;

function replaceOnce(label, before, after) {
  const count = src.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`[p0-5 patch] ${label}: expected exactly 1 match, found ${count}`);
  }
  src = src.replace(before, after);
}

replaceOnce(
  'durable requested task lookup',
  `      const requestedTaskId = req.body.taskId;\n      if (requestedTaskId && serverVideoTaskStore.has(requestedTaskId)) {`,
  `      const requestedTaskId = req.body.taskId;\n\n      // P0-5: Firestore is the idempotency authority across Cloud Run instances.\n      // Always check the durable task before consulting the process-local cache.\n      if (requestedTaskId && firestoreTaskRepository.isAvailable()) {\n        const durableExisting = await firestoreTaskRepository.getTask(requestedTaskId);\n        if (durableExisting) {\n          serverVideoTaskStore.set(requestedTaskId, durableExisting);\n          if (['submitting', 'submitted', 'polling', 'polling_timeout', 'generation_succeeded', 'artifact_persisting', 'artifact_persisted', 'qa_pending'].includes(durableExisting.status as string)) {\n            return res.json({\n              accepted: true,\n              serverPersisted: true,\n              taskId: durableExisting.taskId,\n              status: durableExisting.status,\n              submissionState: 'submitted',\n              operationNamePresent: Boolean(durableExisting.operationName),\n              isIdempotentReuse: true,\n              createdAt: durableExisting.createdAt,\n              updatedAt: durableExisting.updatedAt,\n              engine: durableExisting.modelId,\n              operationName: durableExisting.operationName,\n            });\n          }\n          if (durableExisting.status === 'completed' && durableExisting.artifactPersisted) {\n            return res.json({\n              accepted: true,\n              serverPersisted: true,\n              taskId: durableExisting.taskId,\n              status: 'completed',\n              submissionState: 'submitted',\n              operationNamePresent: Boolean(durableExisting.operationName),\n              isIdempotentReuse: true,\n              createdAt: durableExisting.createdAt,\n              updatedAt: durableExisting.updatedAt,\n              engine: durableExisting.modelId,\n              videoDataUrl: durableExisting.videoDataUrl || \\`/api/videos/stream/\\${durableExisting.taskId}\\`,\n              sizeBytes: durableExisting.sizeBytes,\n              durationSeconds: durableExisting.durationSeconds,\n              qaReport: durableExisting.qaReport,\n              diagnostics: durableExisting.diagnostics,\n            });\n          }\n        }\n      }\n\n      if (requestedTaskId && serverVideoTaskStore.has(requestedTaskId)) {`
);

replaceOnce(
  'durable create and lease',
  `        taskRecord.evidenceSource = 'firestore';\n        await firestoreTaskRepository.createTask(taskRecord);`,
  `        taskRecord.evidenceSource = 'firestore';\n        await firestoreTaskRepository.createTask(taskRecord);\n\n        // P0-5: acquire a durable Firestore execution lease before invoking the provider.\n        const leaseOwner = process.env.K_REVISION || process.env.K_SERVICE || \\`pid_\\${process.pid}\\`;\n        const leaseResult = await taskStateMachineService.acquireLease({\n          taskId,\n          leaseOwner,\n          leaseDurationMs: 180000,\n          maxAttempts: 3,\n        });\n        if (!leaseResult.acquired || !leaseResult.executionId) {\n          throw new Error(\\`Unable to acquire durable execution lease for task \\${taskId}: \\${leaseResult.reason || 'unknown'}\\`);\n        }\n        taskRecord.executionId = leaseResult.executionId;\n        taskRecord.leaseOwner = leaseOwner;\n        taskRecord.leaseExpiresAt = leaseResult.task?.leaseExpiresAt;\n        taskRecord.stateVersion = leaseResult.task?.stateVersion;\n        taskRecord.statusVersion = leaseResult.task?.statusVersion;`
);

replaceOnce(
  'duplicate create reconciliation',
  `      } catch (fsErr: any) {\n        console.error('[Firestore Task Creation Error]:', fsErr);\n        const errStr = String(fsErr?.message || fsErr);`,
  `      } catch (fsErr: any) {\n        console.error('[Firestore Task Creation Error]:', fsErr);\n        const errStr = String(fsErr?.message || fsErr);\n\n        // createTask uses Firestore create() semantics. If another instance won the\n        // same taskId race, return the authoritative existing task instead of invoking Veo twice.\n        const alreadyExists = fsErr?.code === 6 || fsErr?.code === 'ALREADY_EXISTS' || /already exists/i.test(errStr);\n        if (alreadyExists) {\n          const existing = await firestoreTaskRepository.getTask(taskId).catch(() => null);\n          if (existing) {\n            serverVideoTaskStore.set(taskId, existing);\n            return res.json({\n              accepted: true,\n              serverPersisted: true,\n              taskId: existing.taskId,\n              status: existing.status,\n              submissionState: 'submitted',\n              operationNamePresent: Boolean(existing.operationName),\n              isIdempotentReuse: true,\n              createdAt: existing.createdAt,\n              updatedAt: existing.updatedAt,\n              engine: existing.modelId,\n              operationName: existing.operationName,\n              videoDataUrl: existing.videoDataUrl,\n            });\n          }\n        }`
);

replaceOnce(
  'await provider submission before HTTP response',
  `      // 异步后台发起 Google Veo 提单与提示词处理，不阻塞 HTTP 响应\n      (async () => {`,
  `      // P0-5: Provider submission is part of the request durability boundary.\n      // Do not rely on fire-and-forget work after a Cloud Run HTTP response. The request\n      // waits only until the provider operation/result is durably persisted; long-running\n      // generation remains asynchronous and is resumed through polling/recovery.\n      await (async () => {`
);

replaceOnce(
  'remove fire-and-forget catch',
  `      })().catch((bgErr) => console.error('[Video Start BG Error]:', bgErr));\n\n      // 立即返回 HTTP 200 确认，避免长连接超时与端口 3000 断连\n      return res.json({\n        accepted: true,\n        serverPersisted: true,\n        taskId,\n        status: 'submitting',\n        submissionState: 'submitting',\n        operationNamePresent: false,\n        isIdempotentReuse: false,\n        createdAt: taskRecord.createdAt,\n        updatedAt: taskRecord.updatedAt,\n        engine: models.videoModel,\n      });`,
  `      })();\n\n      // Return only after the provider submission outcome has been durably recorded.\n      const durableTask = await firestoreTaskRepository.getTask(taskId);\n      return res.json({\n        accepted: true,\n        serverPersisted: true,\n        taskId,\n        status: durableTask?.status || 'submitting',\n        submissionState: durableTask?.operationName ? 'submitted' : 'submitting',\n        operationNamePresent: Boolean(durableTask?.operationName),\n        operationName: durableTask?.operationName,\n        isIdempotentReuse: false,\n        createdAt: durableTask?.createdAt || taskRecord.createdAt,\n        updatedAt: durableTask?.updatedAt || taskRecord.updatedAt,\n        engine: durableTask?.modelId || models.videoModel,\n        videoDataUrl: durableTask?.videoDataUrl,\n        artifactPersisted: durableTask?.artifactPersisted,\n      });`
);

// Release the submission lease once the durable provider operation is persisted.
replaceOnce(
  'release lease after operation persistence',
  `            console.log(\`[Video Start Success] 任务 \\${taskId} 成功获取 OperationName: \\${startResult.operationName}\`);\n            return;`,
  `            await taskStateMachineService.releaseLease(taskId, taskRecord.executionId);\n            console.log(\`[Video Start Success] 任务 \\${taskId} 成功获取 OperationName: \\${startResult.operationName}\`);\n            return;`
);

replaceOnce(
  'release lease after synchronous artifact',
  `              console.log(\`[Video Start Sync Complete] 任务 \\${taskId} 直接渲染完成并上传至 GCS (\\${artifactMeta.sizeBytes} bytes)\`);\n              return;`,
  `              await taskStateMachineService.releaseLease(taskId, taskRecord.executionId);\n              console.log(\`[Video Start Sync Complete] 任务 \\${taskId} 直接渲染完成并上传至 GCS (\\${artifactMeta.sizeBytes} bytes)\`);\n              return;`
);

if (src === original) {
  throw new Error('[p0-5 patch] no changes applied');
}

fs.writeFileSync(file, src);
console.log('[p0-5 patch] server.ts hardening applied successfully');
