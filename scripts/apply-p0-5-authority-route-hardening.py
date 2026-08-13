from pathlib import Path


def replace_once(src: str, label: str, before: str, after: str) -> str:
    count = src.count(before)
    if count != 1:
        raise RuntimeError(f'[p0-5 authority routes] {label}: expected 1 match, found {count}')
    return src.replace(before, after, 1)


# -----------------------------------------------------------------------------
# Repository: durable delete primitive.
# -----------------------------------------------------------------------------
repo_path = Path('src/server/repositories/firestoreTaskRepository.ts')
repo = repo_path.read_text(encoding='utf-8')
if 'public async deleteTask(taskId: string): Promise<boolean>' not in repo:
    marker = '  public async taskExists(taskId: string): Promise<boolean> {'
    idx = repo.find(marker)
    if idx < 0:
        raise RuntimeError('taskExists marker not found')
    method = '''  public async deleteTask(taskId: string): Promise<boolean> {
    if (!taskId) return false;

    const db = getFirestoreInstance();
    if (!db) {
      throw new Error('[FirestoreTaskRepository] Firestore is unavailable. Cannot delete task.');
    }

    return this.withRetry('deleteTask', true, async () => {
      const docRef = db.collection(this.collectionName).doc(taskId);
      const snap = await docRef.get();
      if (!snap.exists) return false;
      await docRef.delete();
      return true;
    });
  }

'''
    repo = repo[:idx] + method + repo[idx:]
    repo_path.write_text(repo, encoding='utf-8')


# -----------------------------------------------------------------------------
# server.ts: no operational endpoint may use process memory as task authority.
# -----------------------------------------------------------------------------
server_path = Path('server.ts')
src = server_path.read_text(encoding='utf-8')

# Delete single task: Firestore first, memory cache second.
start = src.find('  // Delete Single Video Task Endpoint')
end = src.find('  // Clear All Failed Tasks Endpoint', start)
if start < 0 or end < 0:
    raise RuntimeError('delete task route markers not found')
src = src[:start] + '''  // Delete Single Video Task Endpoint
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

''' + src[end:]

# Clear failed tasks: enumerate and delete authoritative Firestore records.
start = src.find('  // Clear All Failed Tasks Endpoint')
end = src.find('  // Task Recovery Endpoint', start)
if start < 0 or end < 0:
    raise RuntimeError('clear-failed route markers not found')
src = src[:start] + '''  // Clear All Failed Tasks Endpoint
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
      for (const rec of tasks) {
        const matchesConnection = !connectionId || !rec.connectionId || rec.connectionId === connectionId;
        const isFailedOrStuck = rec.status === 'failed' ||
          (rec.status as string) === 'submit_failed_safe_to_retry' ||
          (rec.status as string) === 'orphaned_local_task' ||
          (!rec.operationName && (rec.status === 'polling' || rec.status === 'submitting')) ||
          ((rec.status === 'polling' || rec.status === 'submitting') && (Date.now() - rec.createdAt) > 300000);
        if (!matchesConnection || !isFailedOrStuck) continue;

        if (await firestoreTaskRepository.deleteTask(rec.taskId || rec.id)) {
          serverVideoTaskStore.delete(rec.taskId || rec.id);
          ephemeralVideoStore.delete(rec.taskId || rec.id);
          ephemeralImageStore.delete(rec.taskId || rec.id);
          deletedCount++;
        }
      }

      return res.json({ success: true, deletedCount, storageAuthority: 'firestore' });
    } catch (err) {
      console.error('Failed to clear failed video tasks:', err);
      return res.status(500).json({ error: '清空失败任务失败', storageAuthority: 'firestore' });
    }
  });

''' + src[end:]

# Recovery endpoint: Firestore is the only place a recovered operation may be registered.
start = src.find('  // Task Recovery Endpoint')
end = src.find('  // Debug endpoint for task store inspection', start)
if start < 0 or end < 0:
    raise RuntimeError('recover-task route markers not found')
src = src[:start] + '''  // Task Recovery Endpoint
  app.post('/api/videos/recover-task', async (req, res) => {
    try {
      const { taskId, operationName, modelId, durationSeconds } = req.body;
      if (!taskId || !operationName) {
        return res.status(400).json({ error: 'taskId 与 operationName 为必填项' });
      }
      if (!firestoreTaskRepository.isAvailable()) {
        return res.status(503).json({
          success: false,
          storageAuthority: 'unavailable',
          error: 'Firestore unavailable; recovery record was not created.',
        });
      }

      const existing = await firestoreTaskRepository.getTask(taskId);
      if (existing) {
        serverVideoTaskStore.set(taskId, existing);
        return res.json({
          success: true,
          message: '任务已在 Firestore 持久化存储中',
          task: existing,
          storageAuthority: 'firestore',
        });
      }

      const now = Date.now();
      const recoveredRecord: ServerVideoTaskRecord = {
        id: taskId,
        taskId,
        operationName,
        status: 'polling',
        modelId: modelId || 'veo-3.1-fast-generate-001',
        projectId: 'xp-vertex-project',
        region: 'us-central1',
        durationSeconds: Number(durationSeconds) || 4,
        aspectRatio: '9:16',
        resolution: '720p',
        generateAudio: false,
        submitHttpStatus: 200,
        pollHttpStatus: null,
        pollAttempt: 0,
        createdAt: now - 10000,
        updatedAt: now,
        evidenceSource: 'firestore',
      };

      await firestoreTaskRepository.createTask(recoveredRecord);
      serverVideoTaskStore.set(taskId, recoveredRecord);
      return res.json({
        success: true,
        message: '成功恢复并初始化 Firestore 任务存储',
        task: recoveredRecord,
        storageAuthority: 'firestore',
      });
    } catch (err: any) {
      console.error('Failed to recover video task:', err);
      return res.status(500).json({
        success: false,
        storageAuthority: 'firestore',
        error: err?.message || '恢复视频任务失败',
      });
    }
  });

''' + src[end:]

# Debug-store is diagnostic evidence; it must never silently substitute memory for Firestore.
start = src.find('  // Debug endpoint for task store inspection')
end = src.find('  // Task Audit Endpoint', start)
if start < 0 or end < 0:
    raise RuntimeError('debug-store route markers not found')
src = src[:start] + '''  // Debug endpoint for task store inspection
  app.get('/api/videos/debug-store', async (_req, res) => {
    if (!firestoreTaskRepository.isAvailable()) {
      return res.status(503).json({
        storageAuthority: 'unavailable',
        evidenceSource: 'unavailable',
        memoryCacheEnabled: true,
        memoryCacheCount: serverVideoTaskStore.size,
        count: 0,
        tasks: [],
        error: 'Firestore unavailable; memory cache is intentionally not returned as authoritative evidence.',
      });
    }

    try {
      const tasksFromStore = await firestoreTaskRepository.listTasks(100);
      for (const task of tasksFromStore) {
        serverVideoTaskStore.set(task.taskId || task.id, task);
      }
      const tasks = tasksFromStore.map((rec) => ({
        id: rec.id || rec.taskId,
        connectionId: rec.connectionId,
        status: rec.status,
        operationName: rec.operationName || null,
        modelId: rec.modelId,
        durationSeconds: rec.durationSeconds,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        idempotencyKey: rec.idempotencyKey || null,
        error: rec.error || null,
        evidenceSource: 'firestore',
      }));
      return res.json({
        storageAuthority: 'firestore',
        memoryCacheEnabled: true,
        memoryCacheCount: serverVideoTaskStore.size,
        count: tasks.length,
        tasks,
      });
    } catch (err: any) {
      return res.status(503).json({
        storageAuthority: 'firestore',
        evidenceSource: 'firestore',
        count: 0,
        tasks: [],
        error: err?.message || 'Firestore diagnostic read failed.',
      });
    }
  });

''' + src[end:]

# Status polling: a provider output URI is a valid artifact source even when poll() did
# not inline the bytes. Do not misclassify it as an empty upstream response.
status_start = src.find("  app.get('/api/videos/status/:taskId'")
status_end = src.find('  // Scene Image Streaming Endpoint', status_start)
if status_start < 0 or status_end < 0:
    raise RuntimeError('status route markers not found')
status = src[status_start:status_end]
status = status.replace(
    '      if (!pollRes.videoBuffer) {',
    '      if (!pollRes.videoBuffer && !pollRes.videoUri && !record.videoUri) {',
    1,
)

# All ordinary status mutations use the guarded state-machine-aware helper.
status = status.replace('await firestoreTaskRepository.updateTask(taskId, updates);', 'await safeUpdateTaskRecord(taskId, updates);')

# A completed provider operation with no retrievable artifact is a generation/output failure,
# not an artifact-persist state transition (there is nothing to persist).
needle = "status: 'artifact_persist_failed',\n          error: 'Veo 渲染完成，但未能获取视频产物 Buffer 存储至 Cloud Storage。'"
if needle in status:
    status = status.replace(
        needle,
        "status: 'failed',\n          error: 'Veo 渲染完成，但未能获取视频产物 Buffer 存储至 Cloud Storage。'",
        1,
    )
status = status.replace(
    'await firestoreTaskRepository.updateTask(taskId, failUpdates).catch(() => {});',
    'await safeUpdateTaskRecord(taskId, failUpdates);',
)

# Persist every polling attempt, not only status/videoUri changes, so Firestore contains
# the real durable polling history used for recovery/observability.
old_poll_write = '''        if (statusChanged || videoUriChanged) {
          try {
            await safeUpdateTaskRecord(taskId, updates);
          } catch (updateErr) {
            console.error(`[Firestore Status Polling Update Error] Task ${taskId}:`, updateErr);
            const saveErrObj = createStructuredError({
              source: 'internal_api',
              failureStage: 'internal_api',
              httpStatus: 500,
              customUserMessage: '无法在 Firestore 持久化任务轮询状态',
              endpointPathRedacted: `/api/videos/status/${taskId}`,
            });
            return res.status(500).json({
              storageAuthority: 'firestore',
              status: 'failed',
              error: '存储服务更新失败',
              structuredError: saveErrObj,
            });
          }
        }
'''
if old_poll_write in status:
    status = status.replace(
        old_poll_write,
        '''        try {
          await safeUpdateTaskRecord(taskId, updates);
        } catch (updateErr) {
          console.error(`[Firestore Status Polling Update Error] Task ${taskId}:`, updateErr);
          const saveErrObj = createStructuredError({
            source: 'internal_api',
            failureStage: 'internal_api',
            httpStatus: 500,
            customUserMessage: '无法在 Firestore 持久化任务轮询状态',
            endpointPathRedacted: `/api/videos/status/${taskId}`,
          });
          return res.status(500).json({
            storageAuthority: 'firestore',
            status: 'failed',
            error: '存储服务更新失败',
            structuredError: saveErrObj,
          });
        }
''',
        1,
    )

src = src[:status_start] + status + src[status_end:]
server_path.write_text(src, encoding='utf-8')
print('[p0-5 authority routes] Firestore-authoritative operational routes applied successfully')
