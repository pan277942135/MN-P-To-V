from pathlib import Path

path = Path('server.ts')
src = path.read_text(encoding='utf-8')
original = src


def replace_once(label: str, before: str, after: str) -> None:
    global src
    count = src.count(before)
    if count != 1:
        raise RuntimeError(f'[p0-5 patch] {label}: expected exactly 1 match, found {count}')
    src = src.replace(before, after, 1)


replace_once(
    'durable requested task lookup',
    '''      const requestedTaskId = req.body.taskId;
      if (requestedTaskId && serverVideoTaskStore.has(requestedTaskId)) {''',
    '''      const requestedTaskId = req.body.taskId;

      // P0-5: Firestore is the idempotency authority across Cloud Run instances.
      // Always check the durable task before consulting the process-local cache.
      if (requestedTaskId && firestoreTaskRepository.isAvailable()) {
        const durableExisting = await firestoreTaskRepository.getTask(requestedTaskId);
        if (durableExisting) {
          serverVideoTaskStore.set(requestedTaskId, durableExisting);
          if (['submitting', 'submitted', 'polling', 'polling_timeout', 'generation_succeeded', 'artifact_persisting', 'artifact_persisted', 'qa_pending'].includes(durableExisting.status as string)) {
            return res.json({
              accepted: true,
              serverPersisted: true,
              taskId: durableExisting.taskId,
              status: durableExisting.status,
              submissionState: 'submitted',
              operationNamePresent: Boolean(durableExisting.operationName),
              isIdempotentReuse: true,
              createdAt: durableExisting.createdAt,
              updatedAt: durableExisting.updatedAt,
              engine: durableExisting.modelId,
              operationName: durableExisting.operationName,
            });
          }
          if (durableExisting.status === 'completed' && durableExisting.artifactPersisted) {
            return res.json({
              accepted: true,
              serverPersisted: true,
              taskId: durableExisting.taskId,
              status: 'completed',
              submissionState: 'submitted',
              operationNamePresent: Boolean(durableExisting.operationName),
              isIdempotentReuse: true,
              createdAt: durableExisting.createdAt,
              updatedAt: durableExisting.updatedAt,
              engine: durableExisting.modelId,
              videoDataUrl: durableExisting.videoDataUrl || `/api/videos/stream/${durableExisting.taskId}`,
              sizeBytes: durableExisting.sizeBytes,
              durationSeconds: durableExisting.durationSeconds,
              qaReport: durableExisting.qaReport,
              diagnostics: durableExisting.diagnostics,
            });
          }
        }
      }

      if (requestedTaskId && serverVideoTaskStore.has(requestedTaskId)) {'''
)

replace_once(
    'durable create and lease',
    '''        taskRecord.evidenceSource = 'firestore';
        await firestoreTaskRepository.createTask(taskRecord);''',
    '''        taskRecord.evidenceSource = 'firestore';
        await firestoreTaskRepository.createTask(taskRecord);

        // P0-5: acquire a durable Firestore execution lease before invoking the provider.
        const leaseOwner = process.env.K_REVISION || process.env.K_SERVICE || `pid_${process.pid}`;
        const leaseResult = await taskStateMachineService.acquireLease({
          taskId,
          leaseOwner,
          leaseDurationMs: 180000,
          maxAttempts: 3,
        });
        if (!leaseResult.acquired || !leaseResult.executionId) {
          throw new Error(`Unable to acquire durable execution lease for task ${taskId}: ${leaseResult.reason || 'unknown'}`);
        }
        taskRecord.executionId = leaseResult.executionId;
        taskRecord.leaseOwner = leaseOwner;
        taskRecord.leaseExpiresAt = leaseResult.task?.leaseExpiresAt;
        taskRecord.stateVersion = leaseResult.task?.stateVersion;
        taskRecord.statusVersion = leaseResult.task?.statusVersion;'''
)

replace_once(
    'duplicate create reconciliation',
    '''      } catch (fsErr: any) {
        console.error('[Firestore Task Creation Error]:', fsErr);
        const errStr = String(fsErr?.message || fsErr);''',
    '''      } catch (fsErr: any) {
        console.error('[Firestore Task Creation Error]:', fsErr);
        const errStr = String(fsErr?.message || fsErr);

        // createTask uses Firestore create() semantics. If another instance won the
        // same taskId race, return the authoritative existing task instead of invoking Veo twice.
        const alreadyExists = fsErr?.code === 6 || fsErr?.code === 'ALREADY_EXISTS' || /already exists/i.test(errStr);
        if (alreadyExists) {
          const existing = await firestoreTaskRepository.getTask(taskId).catch(() => null);
          if (existing) {
            serverVideoTaskStore.set(taskId, existing);
            return res.json({
              accepted: true,
              serverPersisted: true,
              taskId: existing.taskId,
              status: existing.status,
              submissionState: 'submitted',
              operationNamePresent: Boolean(existing.operationName),
              isIdempotentReuse: true,
              createdAt: existing.createdAt,
              updatedAt: existing.updatedAt,
              engine: existing.modelId,
              operationName: existing.operationName,
              videoDataUrl: existing.videoDataUrl,
            });
          }
        }'''
)

replace_once(
    'await provider submission before HTTP response',
    '''      // 异步后台发起 Google Veo 提单与提示词处理，不阻塞 HTTP 响应
      (async () => {''',
    '''      // P0-5: Provider submission is part of the request durability boundary.
      // Do not rely on fire-and-forget work after a Cloud Run HTTP response. The request
      // waits only until the provider operation/result is durably persisted; long-running
      // generation remains asynchronous and is resumed through polling/recovery.
      await (async () => {'''
)

replace_once(
    'remove fire-and-forget catch',
    '''      })().catch((bgErr) => console.error('[Video Start BG Error]:', bgErr));

      // 立即返回 HTTP 200 确认，避免长连接超时与端口 3000 断连
      return res.json({
        accepted: true,
        serverPersisted: true,
        taskId,
        status: 'submitting',
        submissionState: 'submitting',
        operationNamePresent: false,
        isIdempotentReuse: false,
        createdAt: taskRecord.createdAt,
        updatedAt: taskRecord.updatedAt,
        engine: models.videoModel,
      });''',
    '''      })();

      // Return only after the provider submission outcome has been durably recorded.
      const durableTask = await firestoreTaskRepository.getTask(taskId);
      return res.json({
        accepted: true,
        serverPersisted: true,
        taskId,
        status: durableTask?.status || 'submitting',
        submissionState: durableTask?.operationName ? 'submitted' : 'submitting',
        operationNamePresent: Boolean(durableTask?.operationName),
        operationName: durableTask?.operationName,
        isIdempotentReuse: false,
        createdAt: durableTask?.createdAt || taskRecord.createdAt,
        updatedAt: durableTask?.updatedAt || taskRecord.updatedAt,
        engine: durableTask?.modelId || models.videoModel,
        videoDataUrl: durableTask?.videoDataUrl,
        artifactPersisted: durableTask?.artifactPersisted,
      });'''
)

replace_once(
    'release lease after operation persistence',
    '''            console.log(`[Video Start Success] 任务 ${taskId} 成功获取 OperationName: ${startResult.operationName}`);
            return;''',
    '''            await taskStateMachineService.releaseLease(taskId, taskRecord.executionId);
            console.log(`[Video Start Success] 任务 ${taskId} 成功获取 OperationName: ${startResult.operationName}`);
            return;'''
)

replace_once(
    'release lease after synchronous artifact',
    '''              console.log(`[Video Start Sync Complete] 任务 ${taskId} 直接渲染完成并上传至 GCS (${artifactMeta.sizeBytes} bytes)`);
              return;''',
    '''              await taskStateMachineService.releaseLease(taskId, taskRecord.executionId);
              console.log(`[Video Start Sync Complete] 任务 ${taskId} 直接渲染完成并上传至 GCS (${artifactMeta.sizeBytes} bytes)`);
              return;'''
)

if src == original:
    raise RuntimeError('[p0-5 patch] no changes applied')

path.write_text(src, encoding='utf-8')
print('[p0-5 patch] server.ts hardening applied successfully')
