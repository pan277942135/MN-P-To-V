from pathlib import Path


def replace_once(src: str, label: str, before: str, after: str) -> str:
    count = src.count(before)
    if count != 1:
        raise RuntimeError(f'[p0-5 production wiring] {label}: expected 1 match, found {count}')
    return src.replace(before, after, 1)


# -----------------------------------------------------------------------------
# TaskStateMachineService: one canonical completion path for a verified artifact.
# -----------------------------------------------------------------------------
sm_path = Path('src/server/services/taskStateMachineService.ts')
sm = sm_path.read_text(encoding='utf-8')
method_marker = '  public async completeWithPersistedArtifact('
if method_marker not in sm:
    insert_before = '  private async finalizeExistingArtifact(\n'
    idx = sm.find(insert_before)
    if idx < 0:
        raise RuntimeError('state machine finalizeExistingArtifact marker not found')
    method = '''  public async completeWithPersistedArtifact(params: {
    taskId: string;
    outputBucket: string;
    outputObjectPath: string;
    videoUri: string;
    sizeBytes?: number;
    contentType?: string;
    artifactPersistedAt?: number;
    patch?: Partial<ServerVideoTaskRecord>;
  }): Promise<ServerVideoTaskRecord> {
    const {
      taskId,
      outputBucket,
      outputObjectPath,
      videoUri,
      sizeBytes,
      contentType = 'video/mp4',
      artifactPersistedAt = Date.now(),
      patch = {},
    } = params;

    const advance = async (toStatus: TaskStatus, transitionPatch: Partial<ServerVideoTaskRecord> = {}) => {
      return await this.transitionTask({ taskId, toStatus, patch: transitionPatch });
    };

    let task = await firestoreTaskRepository.getTask(taskId);
    if (!task) {
      throw new Error(`[TaskStateMachine] Task ${taskId} not found while finalizing artifact.`);
    }

    if (task.status === 'completed') {
      if (
        task.artifactPersisted !== true ||
        !task.outputBucket ||
        !task.outputObjectPath ||
        !task.videoUri
      ) {
        throw new Error(`[TaskStateMachine] Completed task ${taskId} violates artifact invariant.`);
      }
      return task;
    }

    // Normalize every legacy/active provider state into the canonical production chain.
    if (task.status === 'created') {
      task = await advance('preparing');
    }
    if (task.status === 'preparing' || task.status === 'submitting' || task.status === 'submitted') {
      task = await advance('generating');
    }
    if (task.status === 'polling_timeout') {
      task = await advance('polling');
    }
    if (task.status === 'generating' || task.status === 'polling') {
      task = await advance('generation_succeeded');
    }
    if (task.status === 'generation_succeeded' || task.status === 'artifact_persist_failed') {
      task = await advance('artifact_persisting');
    }
    if (task.status === 'artifact_persisting') {
      task = await advance('artifact_persisted', {
        ...patch,
        outputBucket,
        outputObjectPath,
        videoUri,
        sizeBytes,
        contentType,
        artifactPersisted: true,
        artifactPersistedAt,
        videoDataUrl: `/api/videos/stream/${taskId}`,
      });
    }
    if (task.status === 'artifact_persisted') {
      task = await advance('qa_pending');
    }
    if (task.status === 'qa_pending') {
      task = await advance('completed', {
        ...patch,
        outputBucket,
        outputObjectPath,
        videoUri,
        sizeBytes,
        contentType,
        artifactPersisted: true,
        artifactPersistedAt,
        videoDataUrl: `/api/videos/stream/${taskId}`,
        completedAt: Date.now(),
      });
    }

    if (task.status !== 'completed') {
      throw new Error(
        `[TaskStateMachine] Task ${taskId} cannot be finalized from state ${task.status}.`
      );
    }

    return task;
  }

'''
    sm = sm[:idx] + method + sm[idx:]
    sm_path.write_text(sm, encoding='utf-8')


# -----------------------------------------------------------------------------
# server.ts: production routes must use the state machine / Firestore authority.
# -----------------------------------------------------------------------------
server_path = Path('server.ts')
src = server_path.read_text(encoding='utf-8')

# Illegal transitions are bugs. Never silently drop the requested status and continue.
src = replace_once(
    src,
    'fail hard on illegal transition',
    '''    } catch (err: any) {
      if (err instanceof InvalidStateTransitionError) {
        console.warn(`[Task State Machine] Blocked illegal status transition for Task ${taskId}: ${err.message}`);
        delete updates.status;
      } else {
        throw err;
      }
    }
''',
    '''    } catch (err: any) {
      if (err instanceof InvalidStateTransitionError) {
        console.error(`[Task State Machine] Illegal production transition for Task ${taskId}: ${err.message}`);
      }
      throw err;
    }
'''
)

# Once Firestore has been consulted, do not return stale process-memory state as authority.
mem_start = src.find('      if (requestedTaskId && serverVideoTaskStore.has(requestedTaskId)) {')
mem_end_marker = '      const taskId = req.body.taskId || `vtask_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;'
mem_end = src.find(mem_end_marker, mem_start)
if mem_start >= 0 and mem_end > mem_start:
    src = src[:mem_start] + src[mem_end:]
else:
    if 'Task Reuse] 复用已有请求 Task' in src:
        raise RuntimeError('requestedTaskId memory fallback block not found')

# The 60-second duplicate scan is process-local and cannot be a correctness boundary.
recent_start = src.find('      // Safeguard: Check if identical request was submitted within the last 60 seconds')
recent_end = src.find('      const sceneImgBuf = sceneFile ? sceneFile.buffer : approvedFirstFrameBuf;', recent_start)
if recent_start >= 0 and recent_end > recent_start:
    src = src[:recent_start] + src[recent_end:]

# Provider submission must pass through submitted -> polling, never submitting -> polling.
op_old = '''          if (startResult.operationName) {
            const updates: Partial<ServerVideoTaskRecord> = {
              status: 'polling',
              operationName: startResult.operationName,
              diagnostics: startResult.diagnostics,
              submitHttpStatus: 200,
            };
            if (firestoreTaskRepository.isAvailable()) {
              await safeUpdateTaskRecord(taskId, updates);
            } else {
              Object.assign(rec, updates);
              serverVideoTaskStore.set(taskId, rec);
              saveTasksToDisk(serverVideoTaskStore);
            }
            await taskStateMachineService.releaseLease(taskId, taskRecord.executionId);
            console.log(`[Video Start Success] 任务 ${taskId} 成功获取 OperationName: ${startResult.operationName}`);
            return;
          }
'''
op_new = '''          if (startResult.operationName) {
            const submitted = await safeUpdateTaskRecord(taskId, {
              status: 'submitted',
              operationName: startResult.operationName,
              diagnostics: startResult.diagnostics,
              submitHttpStatus: 200,
            });
            await safeUpdateTaskRecord(taskId, {
              status: 'polling',
              operationName: startResult.operationName,
              diagnostics: startResult.diagnostics,
              submitHttpStatus: 200,
              stateVersion: submitted.stateVersion,
            });
            await taskStateMachineService.releaseLease(taskId, taskRecord.executionId);
            console.log(`[Video Start Success] 任务 ${taskId} 成功获取 OperationName: ${startResult.operationName}`);
            return;
          }
'''
src = replace_once(src, 'submitted then polling sequence', op_old, op_new)

# Synchronous provider result: verified GCS metadata must flow through the canonical state machine.
sync_section_start = src.find('          if (startResult.videoBuffer) {')
sync_section_end = src.find('          if (startResult.operationName) {', sync_section_start)
if sync_section_start < 0 or sync_section_end < 0:
    raise RuntimeError('synchronous result section not found')
sync_section = src[sync_section_start:sync_section_end]
updates_start = sync_section.find('              const updates: Partial<ServerVideoTaskRecord> = {')
release_marker = '              await taskStateMachineService.releaseLease(taskId, taskRecord.executionId);'
updates_end = sync_section.find(release_marker, updates_start)
if updates_start < 0 or updates_end < 0:
    raise RuntimeError('synchronous completion update block not found')
replacement = '''              const completedTask = await taskStateMachineService.completeWithPersistedArtifact({
                taskId,
                outputBucket: artifactMeta.outputBucket,
                outputObjectPath: artifactMeta.outputObjectPath,
                videoUri: artifactMeta.videoUri,
                sizeBytes: artifactMeta.sizeBytes,
                contentType: artifactMeta.contentType,
                artifactPersistedAt: artifactMeta.artifactPersistedAt,
                patch: {
                  qaReport: {
                    pass: true,
                    firstFrameMode: '首帧模式：原图直通',
                    identityQaStatus: '身份自动质检：未执行',
                    masterImagesSentCount: 0,
                    summary: '首帧原图直通模式已生效，角色母板未发送至Veo',
                    criticalIssues: [],
                  },
                  diagnostics: startResult.diagnostics,
                  submitHttpStatus: 200,
                },
              });
              serverVideoTaskStore.set(taskId, completedTask);
'''
sync_section = sync_section[:updates_start] + replacement + sync_section[updates_end:]
src = src[:sync_section_start] + sync_section + src[sync_section_end:]

# Status re-fetch completion: same canonical completion path.
refetch_anchor = src.find('      // If videoUri is already recorded from a completed cloud operation')
refetch_end = src.find('      const ai = await GeminiClientFactory.getClientForSession(session);', refetch_anchor)
if refetch_anchor < 0 or refetch_end < 0:
    raise RuntimeError('status re-fetch section not found')
refetch_section = src[refetch_anchor:refetch_end]
ref_updates_start = refetch_section.find('            const updates: Partial<ServerVideoTaskRecord> = {')
ref_return = refetch_section.find('            return res.json({', ref_updates_start)
if ref_updates_start < 0 or ref_return < 0:
    raise RuntimeError('status re-fetch completion block not found')
ref_replacement = '''            const completedTask = await taskStateMachineService.completeWithPersistedArtifact({
              taskId,
              outputBucket: artifactMeta.outputBucket,
              outputObjectPath: artifactMeta.outputObjectPath,
              videoUri: artifactMeta.videoUri,
              sizeBytes: artifactMeta.sizeBytes,
              contentType: artifactMeta.contentType,
              artifactPersistedAt: artifactMeta.artifactPersistedAt,
              patch: {
                qaReport: defaultQaReport,
                pollHttpStatus: 200,
                pollAttempt: record.pollAttempt,
              },
            });
            serverVideoTaskStore.set(taskId, completedTask);

'''
refetch_section = refetch_section[:ref_updates_start] + ref_replacement + refetch_section[ref_return:]
src = src[:refetch_anchor] + refetch_section + src[refetch_end:]

# Before persisting a done Veo result, record generation_succeeded -> artifact_persisting.
persist_marker = '      // Persist to GCS and verify existence & non-zero size\n'
if persist_marker in src and 'P0-5 canonical artifact persistence state' not in src:
    src = src.replace(
        persist_marker,
        '''      // P0-5 canonical artifact persistence state: the provider has completed,
      // but the task cannot become completed until the owned GCS object is persisted.
      await safeUpdateTaskRecord(taskId, {
        status: 'generation_succeeded',
        pollHttpStatus: 200,
        pollAttempt: record.pollAttempt,
        ...(pollRes.videoUri ? { videoUri: pollRes.videoUri } : {}),
      });
      await safeUpdateTaskRecord(taskId, { status: 'artifact_persisting' });

''' + persist_marker,
        1,
    )

# Final status-poll completion: use the canonical state machine rather than direct completed write.
final_anchor = src.find('      // Save local cache for fast stream reads')
final_return = src.find('      return res.json({\n        status: \'completed\'', final_anchor)
if final_anchor < 0 or final_return < 0:
    raise RuntimeError('final poll completion section not found')
final_section = src[final_anchor:final_return]
final_updates = final_section.find('      const updates: Partial<ServerVideoTaskRecord> = {')
if final_updates < 0:
    raise RuntimeError('final completion updates block not found')
final_replacement = '''      const completedTask = await taskStateMachineService.completeWithPersistedArtifact({
        taskId,
        outputBucket: artifactMeta.outputBucket,
        outputObjectPath: artifactMeta.outputObjectPath,
        videoUri: artifactMeta.videoUri,
        sizeBytes: artifactMeta.sizeBytes,
        contentType: artifactMeta.contentType,
        artifactPersistedAt: artifactMeta.artifactPersistedAt,
        patch: {
          qaReport: defaultQaReport,
          pollHttpStatus: 200,
          pollAttempt: record.pollAttempt,
        },
      });
      Object.assign(record, completedTask);
      serverVideoTaskStore.set(taskId, completedTask);

'''
final_section = final_section[:final_updates] + final_replacement
src = src[:final_anchor] + final_section + src[final_return:]

# Outer /start catch must never claim an in-memory failure record was durably persisted.
catch_old = '''      let serverPersisted = false;
      if (req.body?.taskId) {
        const rec = serverVideoTaskStore.get(req.body.taskId);
        if (rec) {
          rec.status = 'failed';
          rec.error = errObj.userMessage || '启动视频生成任务失败';
          rec.structuredError = errObj;
          serverVideoTaskStore.set(req.body.taskId, rec);
          saveTasksToDisk(serverVideoTaskStore);
          serverPersisted = true;
        }
      }
'''
catch_new = '''      // A process-memory record is never durable evidence. If Firestore persistence failed,
      // report serverPersisted=false rather than manufacturing a local authoritative task.
      const serverPersisted = false;
'''
src = replace_once(src, 'outer start catch fail closed', catch_old, catch_new)

server_path.write_text(src, encoding='utf-8')
print('[p0-5 production wiring] durable state-machine wiring applied successfully')
