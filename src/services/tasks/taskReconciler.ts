import { db } from '../../db/database';
import type { GenerationTask, TaskStatus } from '../../types';
import { parseJsonResponse } from '../../utils/apiClient';

export const KNOWN_ORPHAN_TASK_IDS = new Set(['task_290cf8d8', 'task_14edc4cc']);

export async function reconcileTasksWithServer(connectionId?: string): Promise<GenerationTask[]> {
  const localConnectionId = connectionId || (typeof window !== 'undefined' ? localStorage.getItem('zaojing_connection_id') || '' : '');
  const allLocalTasks = await db.tasks.toArray();

  // 1. Repair hardcoded orphan task IDs if present in IndexedDB
  for (const localTask of allLocalTasks) {
    if (KNOWN_ORPHAN_TASK_IDS.has(localTask.id)) {
      localTask.status = 'orphaned_local_task';
      localTask.progressStage = '该任务仅存在于本地缓存，服务端没有对应任务记录';
      localTask.updatedAt = Date.now();
      await db.tasks.put(localTask);
    }
  }

  // 2. Query server for authoritative tasks
  let serverTasksMap = new Map<string, any>();
  let serverListFetched = false;

  try {
    const res = await fetch('/api/videos/list', {
      headers: { 'x-connection-id': localConnectionId },
    });
    if (res.ok) {
      const data = await parseJsonResponse(res).catch(() => null);
      if (data && Array.isArray(data.tasks)) {
        serverListFetched = true;
        for (const st of data.tasks) {
          if (st.id || st.taskId) {
            serverTasksMap.set(st.id || st.taskId, st);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[taskReconciler] Failed to fetch /api/videos/list:', err);
  }

  // 3. Reconcile IndexedDB tasks against server authority
  const refreshedTasks = await db.tasks.toArray();
  const resultTasks: GenerationTask[] = [];

  for (const localTask of refreshedTasks) {
    if (!localTask || !localTask.id) continue;

    // Self-healing: If a completed task with local video result was misclassified as orphaned, restore it
    if (
      localTask.status === 'orphaned_local_task' &&
      Boolean(localTask.resultVideoUrl)
    ) {
      localTask.status = 'completed';
      localTask.progressStage = '生成与质检全部完成';
      localTask.progressPercent = 100;
      localTask.updatedAt = Date.now();
      await db.tasks.put(localTask);
    }

    // Hardcoded known orphans stay orphaned
    if (KNOWN_ORPHAN_TASK_IDS.has(localTask.id)) {
      if (!localTask.resultVideoUrl) {
        localTask.status = 'orphaned_local_task';
        localTask.progressStage = '该任务仅存在于本地缓存，服务端没有对应任务记录';
        resultTasks.push(localTask);
        continue;
      }
    }

    // Unsubmitted draft/validating in frontend session
    if (localTask.status === 'local_draft' || localTask.status === 'validating') {
      resultTasks.push(localTask);
      continue;
    }

    if (serverListFetched) {
      const serverMatch = serverTasksMap.get(localTask.id);

      if (serverMatch) {
        // Server status overrides local status
        const serverStatus = serverMatch.status;
        if (serverStatus === 'completed') {
          const effectiveVideoUrl = serverMatch.videoDataUrl || localTask.resultVideoUrl;
          if (effectiveVideoUrl) {
            localTask.status = 'completed';
            localTask.progressStage = '生成与质检全部完成';
            localTask.progressPercent = 100;
            localTask.resultVideoUrl = effectiveVideoUrl;
          } else {
            const isRai = serverMatch.failureReason === 'output_rai_filtered' || serverMatch.failureReason === 'input_safety_blocked';
            localTask.status = 'failed';
            localTask.failureReason = isRai ? 'output_rai_filtered' : 'artifact_missing';
            localTask.retryMode = isRai ? 'REWRITE_INPUT_THEN_REGENERATE' : 'RETRY_DOWNLOAD';
            localTask.progressStage = isRai ? 'Google安全过滤未返回视频' : '视频持久化未完成';
            localTask.error = {
              code: isRai ? 'RAI_FILTERED' : 'ARTIFACT_MISSING',
              stage: isRai ? 'video_generation' : 'output_download',
              failureReason: localTask.failureReason,
              retryMode: localTask.retryMode,
              messageChinese: isRai
                ? 'Google安全过滤未返回视频，请调整输入图片或动作描述后重新生成。'
                : '云端任务已完成，但视频文件尚未成功持久化，正在恢复已有产物。',
              technicalMessageRedacted: isRai
                ? 'Server reported RAI safety filter'
                : 'Server status completed but videoDataUrl is missing',
              httpStatus: 400,
              retryable: !isRai,
              recommendedAction: isRai
                ? '请修改提示词或首帧图片后重新生成'
                : '点击【恢复产物】或重新拉取视频',
            };
          }
        } else if (serverStatus === 'failed') {
          localTask.status = 'failed';
          localTask.progressStage = '视频生成失败';
          if (serverMatch.error || serverMatch.structuredError) {
            localTask.error = serverMatch.structuredError || {
              code: 'SERVER_FAILED',
              stage: 'polling',
              messageChinese: serverMatch.error || '视频生成失败',
              technicalMessageRedacted: serverMatch.error || '云端渲染失败',
              httpStatus: 500,
              retryable: true,
              recommendedAction: '在下方点击【一键重试】',
            };
          }
        } else if (serverStatus === 'polling' || serverStatus === 'submitting' || serverStatus === 'processing') {
          // Do NOT downgrade a failed or completed task back to polling_video
          if (
            localTask.status !== 'failed' &&
            localTask.status !== 'completed' &&
            localTask.status !== 'completed_with_warning' &&
            localTask.status !== 'orphaned_local_task' &&
            !localTask.error
          ) {
            localTask.status = 'polling_video';
            localTask.progressStage = `云端视频渲染中...`;
          }
        } else if (serverStatus === 'polling_timeout') {
          if (localTask.status !== 'completed') {
            localTask.status = 'polling_timeout';
            localTask.progressStage = '云端渲染较慢，请点击【继续查询】';
          }
        }

        if (serverMatch.operationName) {
          localTask.externalOperationName = serverMatch.operationName;
        }

        localTask.updatedAt = Date.now();
        await db.tasks.put(localTask);
      } else {
        // Local task is NOT on server
        // If it's already completed with video result, keep completed. Otherwise if completed without video, convert to failed!
        if (
          (localTask.status === 'completed' || localTask.status === 'completed_with_warning') &&
          !localTask.resultVideoUrl
        ) {
          localTask.status = 'failed';
          localTask.failureReason = 'artifact_missing';
          localTask.retryMode = 'RETRY_DOWNLOAD';
          localTask.progressStage = '视频持久化未完成';
          localTask.error = {
            code: 'ARTIFACT_MISSING',
            stage: 'output_download',
            failureReason: 'artifact_missing',
            retryMode: 'RETRY_DOWNLOAD',
            messageChinese: '云端任务已完成，但视频文件尚未成功持久化，正在恢复已有产物。',
            technicalMessageRedacted: 'Local task marked completed without resultVideoUrl',
            httpStatus: 400,
            retryable: true,
            recommendedAction: '在视频历史中点击【恢复产物】或重新拉取',
          };
          await db.tasks.put(localTask);
        } else if (
          localTask.status === 'completed' ||
          localTask.status === 'completed_with_warning' ||
          Boolean(localTask.resultVideoUrl)
        ) {
          if (localTask.status !== 'completed' && localTask.status !== 'completed_with_warning') {
            localTask.status = 'completed';
            localTask.progressStage = '生成与质检全部完成';
          }
        } else if (localTask.status === 'failed') {
          // Keep as failed
        } else if (
          Date.now() - (Number(localTask.createdAt) || 0) < 600000 ||
          ['starting_video', 'polling_video', 'submitting', 'polling', 'processing', 'local_draft', 'starting_first_frame', 'waiting_first_frame_approval'].includes(localTask.status as string)
        ) {
          // Task was created recently or is actively running locally; preserve active status
        } else {
          // Unfinished task lost on server and older than 10 minutes -> mark as orphaned_local_task
          localTask.status = 'orphaned_local_task';
          localTask.progressStage = '该任务仅存在于本地缓存，服务端没有对应任务记录';
          localTask.updatedAt = Date.now();
          await db.tasks.put(localTask);
        }
      }
    }

    resultTasks.push(localTask);
  }

  resultTasks.sort(
    (a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0) || (b.id || '').localeCompare(a.id || '')
  );

  return resultTasks;
}
