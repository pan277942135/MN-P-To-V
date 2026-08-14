import React, { useState, useEffect } from 'react';
import { taskRepository } from '../repositories/taskRepository';
import type { GenerationTask } from '../types';
import { safeCreateObjectURL } from '../utils/imageHelper';
import { reconcileTasksWithServer, KNOWN_ORPHAN_TASK_IDS } from '../services/tasks/taskReconciler';
import { PromptCompiler } from '../services/prompt/PromptCompiler';
import {
  History,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Play,
  Download,
  Trash2,
  Clock,
  Film,
  X,
  RefreshCw,
  Copy,
  Check,
  Sliders,
  Database,
  ExternalLink,
} from 'lucide-react';
import { buildExecutionTuningPayload, copyExecutionParamsToClipboard, getExplicitTaskFailureReason, humanizeErrorMessage } from '../utils/taskHelper';
import { downloadVideoFile } from '../utils/downloadHelper';
import { GcsLocationCard, parseGcsUri } from '../components/GcsLocationCard';
import { parseJsonResponse } from '../utils/apiClient';

const getStatusBadgeInfo = (status: string) => {
  switch (status) {
    case 'completed':
      return { text: '已完成', cls: 'bg-emerald-950 text-emerald-400 border border-emerald-800/50' };
    case 'completed_with_warning':
      return { text: '完成(含质检警告)', cls: 'bg-amber-950 text-amber-400 border border-amber-800/50' };
    case 'failed':
      return { text: '生成失败', cls: 'bg-rose-950 text-rose-400 border border-rose-800/50' };
    case 'orphaned_local_task':
      return { text: '本地孤儿记录', cls: 'bg-amber-950/80 text-amber-300 border border-amber-800' };
    case 'polling_timeout':
      return { text: '云端渲染较慢 (可继续查询)', cls: 'bg-amber-950 text-amber-300 border border-amber-800/80' };
    case 'submitting':
    case 'submitting_api':
      return { text: '正在提交云端...', cls: 'bg-indigo-950 text-indigo-400 border border-indigo-800/50 animate-pulse' };
    case 'starting_video':
      return { text: '启动视频引擎中...', cls: 'bg-indigo-950 text-indigo-400 border border-indigo-800/50 animate-pulse' };
    case 'polling_video':
    case 'polling':
    case 'processing':
      return { text: '云端视频渲染中...', cls: 'bg-indigo-950 text-indigo-400 border border-indigo-800/50 animate-pulse' };
    case 'generating_first_frame':
      return { text: '生成首帧中...', cls: 'bg-indigo-950 text-indigo-400 border border-indigo-800/50 animate-pulse' };
    case 'waiting_first_frame_approval':
      return { text: '待确认首帧', cls: 'bg-amber-950 text-amber-400 border border-amber-800/50' };
    case 'qa_pending':
      return { text: '身份质检 / 待审核', cls: 'bg-amber-950 text-amber-300 border border-amber-800/70' };
    default:
      return { text: status === 'submitted' ? '已提交等待渲染' : (status || '处理中'), cls: 'bg-zinc-800 text-zinc-300 border border-zinc-700' };
  }
};

const formatSceneMode = (mode?: string) => {
  switch (mode) {
    case 'animate_existing_character':
      return '原图直通驱动';
    case 'replace_primary_person':
      return '角色替换合成';
    case 'multi_angle_view':
      return '多视角生成';
    default:
      return '标准生成模式';
  }
};

const getBlobFromUrlOrDataUrl = async (url: string): Promise<Blob | null> => {
  if (!url) return null;
  if (url.startsWith('data:image/')) {
    try {
      const arr = url.split(',');
      const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
      const bstr = atob(arr[1] || arr[0]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      return new Blob([u8arr], { type: mime });
    } catch (e) {
      console.warn('Failed to convert base64 image URL to Blob:', e);
      return null;
    }
  }
  try {
    const res = await fetch(url);
    if (res.ok) {
      return await res.blob();
    }
  } catch (e) {
    console.warn('Failed to fetch image blob from URL:', url, e);
  }
  return null;
};

const createFallbackSceneBlob = async (): Promise<Blob> => {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 1280;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, 720, 1280);
    ctx.fillStyle = '#e4e4e7';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('造景 AI 动效图层', 360, 600);
    ctx.fillStyle = '#a1a1aa';
    ctx.font = '24px sans-serif';
    ctx.fillText('首帧直通重试预制图层', 360, 650);
  }
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob || new Blob([new Uint8Array(0)], { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.85);
  });
};

const extractSceneBlobFromTask = async (task: GenerationTask): Promise<Blob> => {
  if (task.sceneImageBlob && task.sceneImageBlob.size > 0) {
    return task.sceneImageBlob;
  }

  if (task.firstFrameCandidates && task.firstFrameCandidates.length > 0) {
    for (const cand of task.firstFrameCandidates) {
      if (cand.blob && cand.blob.size > 0) return cand.blob;
      if (cand.dataUrl) {
        const b = await getBlobFromUrlOrDataUrl(cand.dataUrl);
        if (b && b.size > 0) return b;
      }
    }
  }

  const potentialUrls = [
    task.sceneImageUrl,
    task.sceneImageDataUrl,
  ].filter(Boolean) as string[];

  for (const url of potentialUrls) {
    const b = await getBlobFromUrlOrDataUrl(url);
    if (b && b.size > 0) return b;
  }

  return createFallbackSceneBlob();
};

const formatDuration = (seconds: number) => {
  if (seconds < 60) return `${seconds}秒`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}分${s}秒`;
};

const isTaskFailedState = (task: GenerationTask): boolean => {
  if (!task || !task.id) return false;
  if (Boolean(task.error)) return true;
  if (
    (task.status === 'completed' || task.status === 'completed_with_warning') &&
    !task.resultVideoUrl &&
    !task.videoResult?.blob &&
    !(task as any).videoDataUrl
  ) {
    return true;
  }
  if (task.status === 'completed' || task.status === 'completed_with_warning') {
    return false;
  }
  const statusStr = String(task.status || '');
  if (
    [
      'starting_video',
      'polling_video',
      'submitting',
      'submitted',
      'polling',
      'polling_timeout',
      'processing',
      'starting_first_frame',
      'local_draft',
      'waiting_first_frame_approval',
    ].includes(statusStr)
  ) {
    return false;
  }
  return (
    task.status === 'failed' ||
    task.status === 'submit_failed_safe_to_retry' ||
    task.status === 'submission_outcome_unknown' ||
    task.status === 'orphaned_local_task' ||
    Boolean(task.error) ||
    (typeof task.progressStage === 'string' && (task.progressStage.includes('失败') || task.progressStage.includes('错误') || task.progressStage.includes('超时') || task.progressStage.includes('中断')))
  );
};

const isTaskHumanReviewState = (task?: GenerationTask | null): boolean => {
  if (!task) return false;
  return task.status === 'qa_pending' && (
    task.identityQaStatus === 'review' ||
    (typeof task.progressStage === 'string' && task.progressStage.includes('人工复核'))
  );
};

const isTaskInputRewriteRequired = (task?: GenerationTask | null): boolean => {
  if (!task) return false;
  const failureReason = (task as any).failureReason;
  const retryMode = (task as any).retryMode;
  const err = task.error as any;
  const legacyErrorCode = typeof err === 'object' && err ? String(err.code || '') : '';
  const legacyErrorText = [
    typeof err === 'string' ? err : '',
    typeof err === 'object' && err ? err.messageChinese : '',
    typeof err === 'object' && err ? err.userMessage : '',
    typeof err === 'object' && err ? err.technicalMessageRedacted : '',
    task.progressStage,
  ]
    .filter(Boolean)
    .map(String)
    .join(' ')
    .toLowerCase();
  const legacyIdentityGate =
    legacyErrorCode === 'IDENTITY_QA_FAILED' ||
    legacyErrorCode === 'IDENTITY_QA_REVIEW_REQUIRED' ||
    legacyErrorText.includes('identity_qa_failed') ||
    legacyErrorText.includes('identity qa failed') ||
    legacyErrorText.includes('角色一致性质检未通过') ||
    legacyErrorText.includes('角色一致性处于人工复核区间');
  return (
    failureReason === 'output_rai_filtered' ||
    failureReason === 'identity_qa_failed' ||
    failureReason === 'identity_qa_review_required' ||
    retryMode === 'REWRITE_INPUT_THEN_REGENERATE' ||
    legacyIdentityGate
  );
};

const getVideoUrl = (task?: GenerationTask | null): string | null => {
  if (!task) return null;
  if (isTaskFailedState(task)) return null;
  if (task.videoResult?.blob) {
    return safeCreateObjectURL(task.videoResult.blob);
  }
  if (task.resultVideoUrl) {
    return task.resultVideoUrl;
  }
  if (task.id && (task.status === 'completed' || task.status === 'completed_with_warning')) {
    return `/api/videos/stream/${task.id}`;
  }
  return null;
};

interface TaskHistoryPageProps {
  onNavigateToStudio?: () => void;
}

export const TaskHistoryPage: React.FC<TaskHistoryPageProps> = ({ onNavigateToStudio }) => {
  const [tasks, setTasks] = useState<GenerationTask[]>([]);
  const [filter, setFilter] = useState<'all' | 'completed' | 'failed' | 'in_progress' | 'review'>('all');
  const [selectedTask, setSelectedTask] = useState<GenerationTask | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isRetryingTaskId, setIsRetryingTaskId] = useState<string | null>(null);
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
  const [downloadingTaskId, setDownloadingTaskId] = useState<string | null>(null);

  const handleRecoverArtifact = async (task: GenerationTask) => {
    if (!task.id) return;
    try {
      const res = await fetch(`/api/videos/recover/${task.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (res.ok && data.success) {
        alert(`【重新获取视频成功】：${data.message}`);
        await loadTasks();
        if (selectedTask?.id === task.id) {
          setSelectedTask({ ...task, status: 'completed', resultVideoUrl: data.videoDataUrl });
        }
      } else {
        alert(`【重新获取视频失败】：${data.error || '视频产物不存在，请点击【重新生成】'}`);
      }
    } catch (err: any) {
      alert(`恢复视频产物发生异常: ${err?.message || String(err)}`);
    }
  };

  const handleDownloadTaskVideo = async (url: string | null, taskId: string, task?: GenerationTask) => {
    if (!taskId) return;

    if (!url) {
      if (task && (task.status === 'failed' || task.error)) {
        alert('该任务生成失败或算力中断，未能在服务器生成 MP4 视频文件。请点击【重新生成】或修复算力凭据。');
      } else {
        alert('当前视频文件未就绪。可点击【重新获取视频】尝试从 Cloud Storage 恢复。');
      }
      return;
    }

    setDownloadingTaskId(taskId);

    try {
      let targetUrl = url;
      if (task && targetUrl.startsWith('/api/videos/stream/')) {
        const vUri = task.videoUri || (task as any).outputUri;
        const opName = task.externalOperationName || (task as any).operationName;
        const params = new URLSearchParams();
        if (vUri && !targetUrl.includes('videoUri=')) params.set('videoUri', vUri);
        if (opName && !targetUrl.includes('operationName=')) params.set('operationName', opName);
        const queryString = params.toString();
        if (queryString) {
          targetUrl += (targetUrl.includes('?') ? '&' : '?') + queryString;
        }
      }

      const success = await downloadVideoFile(targetUrl, `zaojing_${taskId.slice(0, 8)}.mp4`);

      if (!success && task) {
        if (confirm('当前视频在 Cloud Storage 侧未就绪或无法直接下载。是否尝试【重新获取视频】从云端恢复？')) {
          await handleRecoverArtifact(task);
        }
      }
    } catch (err: any) {
      alert(`视频下载处理发生异常: ${err?.message || String(err)}`);
    } finally {
      setDownloadingTaskId(null);
    }
  };

  const handleCopyParams = async (task: GenerationTask) => {
    const success = await copyExecutionParamsToClipboard(task);
    if (success) {
      setCopiedTaskId(task.id);
      setTimeout(() => setCopiedTaskId(null), 2500);
    } else {
      alert('复制失败，请重试');
    }
  };

  const loadTasks = async () => {
    const connectionId = localStorage.getItem('zaojing_connection_id') || '';
    const reconciledList = await reconcileTasksWithServer(connectionId);
    
    // Deduplicate by unique task ID
    const taskMap = new Map<string, GenerationTask>();
    for (const task of reconciledList) {
      if (!task.id) continue;
      if (!taskMap.has(task.id)) {
        taskMap.set(task.id, task);
      } else {
        const prev = taskMap.get(task.id)!;
        const prevHasImg = !!(prev.sceneImageBlob || prev.sceneImageUrl);
        const currHasImg = !!(task.sceneImageBlob || task.sceneImageUrl);
        if (!prevHasImg && currHasImg) {
          taskMap.set(task.id, task);
        }
      }
    }

    const finalTaskList = Array.from(taskMap.values()).sort(
      (a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0) || (b.id || '').localeCompare(a.id || '')
    );
    setTasks(finalTaskList);

    // Check status for active server tasks (including polling_timeout, starting_video, polling, polling_video, submitting, processing)
    const activeTasks = finalTaskList.filter(
      (t) =>
        t &&
        t.id &&
        !KNOWN_ORPHAN_TASK_IDS.has(t.id) &&
        t.status &&
        ['polling', 'polling_video', 'starting_video', 'submitting', 'processing', 'polling_timeout', 'qa_pending'].includes(t.status) &&
        !isTaskFailedState(t)
    );

    if (activeTasks.length > 0) {
      for (const t of activeTasks) {
        try {
          const res = await fetch(`/api/videos/status/${t.id}`, {
            headers: { 'x-connection-id': connectionId },
          });

          if (res.status === 404) {
            if (Date.now() - (Number(t.createdAt) || 0) > 300000) {
              t.status = 'orphaned_local_task';
              t.progressStage = '该任务仅存在于本地缓存，服务端没有对应任务记录';
              t.updatedAt = Date.now();
              await taskRepository.save(t);
            }
            continue;
          }

          if (res.ok) {
            const data = await parseJsonResponse(res).catch(() => ({}));
            if (data.status === 'completed' && data.videoDataUrl) {
              t.status = 'completed';
              t.resultVideoUrl = data.videoDataUrl;
              t.qaReport = data.qaReport || t.qaReport;
              t.identityQaStatus = data.identityQaStatus || t.identityQaStatus;
              t.humanReviewDecision = data.humanReviewDecision || t.humanReviewDecision;
              t.humanReviewRecord = data.humanReviewRecord || t.humanReviewRecord;
              t.progressStage = '合成与全帧视频生成完成';
              t.progressPercent = 100;
              t.error = undefined;
              t.updatedAt = Date.now();
              await taskRepository.save(t);
            } else if (data.status === 'qa_pending') {
              t.status = 'qa_pending';
              t.identityQaStatus = data.identityQaStatus || t.identityQaStatus;
              t.qaReport = data.qaReport || t.qaReport;
              t.humanReviewDecision = data.humanReviewDecision || t.humanReviewDecision;
              t.humanReviewRecord = data.humanReviewRecord || t.humanReviewRecord;
              if (data.videoDataUrl || data.resultVideoUrl) {
                t.resultVideoUrl = data.videoDataUrl || data.resultVideoUrl;
              }
              t.progressStage = data.requiresManualApproval
                ? '视频身份质检需要人工复核'
                : '视频已持久化，等待身份质检';
              t.progressPercent = 95;
              t.error = undefined;
              t.updatedAt = Date.now();
              await taskRepository.save(t);
            } else if (data.status === 'failed') {
              t.status = 'failed';
              (t as any).failureReason = data.failureReason || (t as any).failureReason;
              (t as any).retryMode = data.retryMode || (t as any).retryMode;
              (t as any).raiStatus = data.raiStatus || (t as any).raiStatus;
              if (data.raiMediaFilteredCount !== undefined && data.raiMediaFilteredCount !== null) {
                (t as any).raiMediaFilteredCount = data.raiMediaFilteredCount;
              }
              if (Array.isArray(data.raiMediaFilteredReasons)) {
                (t as any).raiMediaFilteredReasons = data.raiMediaFilteredReasons;
              }
              t.progressStage = '视频生成失败';
              const errStr = typeof data.error === 'string'
                ? data.error
                : (data.error?.message ? String(data.error.message) : (data.error ? JSON.stringify(data.error) : ''));
              const userMsgStr = typeof data.userMessage === 'string'
                ? data.userMessage
                : (data.userMessage ? String(data.userMessage) : '');
              const techStr = typeof data.technicalMessageRedacted === 'string'
                ? data.technicalMessageRedacted
                : (data.technicalMessageRedacted ? String(data.technicalMessageRedacted) : '');

              t.error = data.structuredError || {
                code: typeof data.source === 'string' ? data.source.toUpperCase() : 'FAILED',
                stage: typeof data.failureStage === 'string' ? data.failureStage : 'polling',
                messageChinese: errStr || userMsgStr || '视频生成失败',
                technicalMessageRedacted: techStr || errStr || '云端生成故障',
                httpStatus: typeof data.httpStatus === 'number' ? data.httpStatus : 500,
                googleStatus: data.googleStatus ? String(data.googleStatus) : undefined,
                googleReason: data.googleReason ? String(data.googleReason) : undefined,
                retryable: true,
                recommendedAction: '请在下方【一键重试】或重新带入动效工坊编辑',
              };
              t.updatedAt = Date.now();
              await taskRepository.save(t);
            } else if (data.status === 'polling_timeout') {
              t.status = 'polling_timeout';
              t.progressStage = '云端渲染较慢，已保留 OperationName。可在任务记录随时「手动查询」';
              t.error = undefined;
              t.updatedAt = Date.now();
              await taskRepository.save(t);
            } else if (data.status === 'polling') {
              t.status = 'polling_video';
              t.progressStage = `云端视频渲染中... (已耗时 ${data.elapsedSeconds || 0}s)`;
              t.progressPercent = Math.min(95, 75 + Math.floor((data.elapsedSeconds || 0) / 6));
              t.error = undefined;
              t.updatedAt = Date.now();
              await taskRepository.save(t);
            }
          }
        } catch {}
      }
      const reloaded = await taskRepository.getAll();
      const reloadedSorted = reloaded
        .filter((t) => t && (t.id || t.createdAt))
        .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0) || (b.id || '').localeCompare(a.id || ''));
      setTasks(reloadedSorted);
    }
  };

  useEffect(() => {
    loadTasks();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        loadTasks();
      }
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    await loadTasks();
    setTimeout(() => setIsRefreshing(false), 500);
  };

  const handleDeleteTask = async (id: string) => {
    if (confirm('确认删除此任务及本地产物记录？')) {
      await taskRepository.delete(id);
      if (selectedTask?.id === id) {
        setSelectedTask(null);
      }
      await loadTasks();
    }
  };

  const failedTaskCount = tasks.filter(isTaskFailedState).length;
  const completedTaskCount = tasks.filter((t) => t.status === 'completed' || t.status === 'completed_with_warning').length;
  const reviewTaskCount = tasks.filter(isTaskHumanReviewState).length;
  const inProgressTaskCount = tasks.filter((t) =>
    t.status !== 'completed' &&
    t.status !== 'completed_with_warning' &&
    !isTaskFailedState(t) &&
    !isTaskHumanReviewState(t)
  ).length;

  const handleOpenHumanReview = (task: GenerationTask) => {
    if (!task?.id) return;
    sessionStorage.setItem('zaojing_bring_task_id', task.id);
    setSelectedTask(null);
    onNavigateToStudio?.();
  };

  const handleOpenInputRewrite = (task: GenerationTask) => {
    if (!task?.id) return;
    sessionStorage.setItem('zaojing_bring_task_id', task.id);
    setSelectedTask(null);
    onNavigateToStudio?.();
  };

  const handleClearFailedTasks = async () => {
    if (failedTaskCount === 0) return;
    if (confirm(`确认批量清空所有已失败或卡死的任务 (${failedTaskCount} 个)，并清理云端后台渲染进程？`)) {
      await taskRepository.clearFailed();
      if (selectedTask && isTaskFailedState(selectedTask)) {
        setSelectedTask(null);
      }
      await loadTasks();
    }
  };

  const [isCheckingTask, setIsCheckingTask] = useState(false);

  const handleRetryTask = async (task: GenerationTask) => {
    if (!task || !task.id) {
      alert('未选定有效任务 ID，无法重试');
      return;
    }
    if (isTaskInputRewriteRequired(task)) {
      const reason = (task as any).failureReason;
      if (reason === 'identity_qa_failed' || reason === 'identity_qa_review_required') {
        alert('该任务在提交 Veo 前被首帧角色质检拦截。原样一键重试已禁用，请返回创作工作台核对角色、母板与输入图。');
      } else {
        alert('该任务已被 Google Veo 安全过滤。原样一键重试已禁用，请返回创作工作台修改提示词或更换图片后重新生成。');
      }
      return;
    }
    setIsRetryingTaskId(task.id);
    try {
      const connectionId = localStorage.getItem('zaojing_connection_id') || '';

      const hasOpName = Boolean(task.externalOperationName || (task as any).operationName);
      const hasVideoUri = Boolean(task.videoUri || (task as any).outputUri || task.resultVideoUrl);
      const isOutcomeUnknown = task.status === 'submission_outcome_unknown' || (task as any).submissionState === 'outcome_unknown';
      const isNotSubmitted = task.status === 'submit_failed_safe_to_retry' || (task as any).submissionState === 'not_submitted' || (!hasOpName && !isOutcomeUnknown);

      // Pre-check status if operationName or videoUri or outcome_unknown exists
      if (hasOpName || task.retryMode === 'RETRY_POLL' || isOutcomeUnknown || hasVideoUri) {
        try {
          const checkRes = await fetch(`/api/videos/status/${task.id}?forceQuery=true&retry=true`, {
            headers: { 'x-connection-id': connectionId },
          });
          const checkData = await parseJsonResponse(checkRes).catch(() => ({}));
          if (checkData.status === 'completed' && checkData.videoDataUrl) {
            task.status = 'completed';
            task.resultVideoUrl = checkData.videoDataUrl;
            task.qaReport = checkData.qaReport;
            task.error = undefined;
            task.progressStage = '已成功从云端恢复视频生成数据';
            task.progressPercent = 100;
            await taskRepository.save(task);
            if (selectedTask?.id === task.id) setSelectedTask({ ...task });
            await loadTasks();
            let dlUrl = checkData.videoDataUrl;
            const vUri = task.videoUri || (task as any).outputUri;
            if (vUri && dlUrl.startsWith('/api/videos/stream/') && !dlUrl.includes('videoUri=')) {
              dlUrl += (dlUrl.includes('?') ? '&' : '?') + `videoUri=${encodeURIComponent(vUri)}`;
            }
            downloadVideoFile(dlUrl, `zaojing_${task.id.slice(0, 8)}.mp4`);
            return;
          }
        } catch (e) {
          console.warn('Pre-check before retry failed:', e);
        }

        if (hasOpName) {
          alert('网络连接暂时中断，但云端任务已提交。请稍后继续查询已有任务。');
          return;
        }

        if (isOutcomeUnknown) {
          alert('当前无法确认云端提交结果，请勿重复提交。请稍后继续查询。');
          return;
        }

        if (hasVideoUri) {
          alert('云端已有视频输出链接，优先拉取保存产物，禁止重复发起生成。');
          return;
        }
      }

      if (!isNotSubmitted && task.retryMode !== 'SAFE_TO_REGENERATE') {
        alert('当前无法确认云端提交结果，请勿重复提交。请稍后继续查询。');
        return;
      }

      const formData = new FormData();
      formData.append('taskId', task.id);
      formData.append('characterId', task.characterId || '');
      formData.append('sceneMode', task.sceneMode || 'animate_existing_character');
      formData.append('durationSeconds', String(task.settings?.durationSeconds || 8));
      formData.append('aspectRatio', task.settings?.aspectRatio || '9:16');
      formData.append('resolution', task.settings?.resolution || '720p');
      formData.append('cameraPreset', (task.settings as any)?.cameraPreset || (task as any).cameraPreset || 'locked_camera');
      formData.append('motionIntensity', (task.settings as any)?.motionIntensity || (task as any).motionIntensity || 'natural');
      formData.append('visualStyle', (task.settings as any)?.visualStyle || (task as any).visualStyle || 'photorealistic');

      // Clean prompt automatically before retrying
      const rawPrompt = task.userPromptChinese || task.normalizedPromptEnglish || '';
      const cleanedPrompt = PromptCompiler.cleanUserMotionPrompt(rawPrompt);
      formData.append('normalizedPrompt', cleanedPrompt || 'A character action motion video');
      formData.append('rawUserPrompt', cleanedPrompt || '');

      const sceneBlob = await extractSceneBlobFromTask(task);
      formData.append('sceneImage', new File([sceneBlob], 'scene.jpg', { type: 'image/jpeg' }));
      formData.append('firstFrame', new File([sceneBlob], 'ff.jpg', { type: 'image/jpeg' }));

      task.status = 'polling_video';
      task.progressStage = '正在重新启动云端视频渲染引擎...';
      task.error = undefined;
      task.retryCount = (task.retryCount || 0) + 1;
      task.updatedAt = Date.now();
      await taskRepository.save(task);
      if (selectedTask?.id === task.id) {
        setSelectedTask({ ...task });
      }
      await loadTasks();

      const res = await fetch('/api/videos/start', {
        method: 'POST',
        headers: { 'x-connection-id': connectionId },
        body: formData,
      });

      const data = await parseJsonResponse(res);
      if (res.ok && data.taskId) {
        if (data.operationName) {
          task.externalOperationName = data.operationName;
        }
        task.status = data.status === 'completed' ? 'completed' : 'polling_video';
        task.progressStage = '云端视频渲染中...';
        if (data.status === 'completed' && data.videoDataUrl) {
          task.resultVideoUrl = data.videoDataUrl;
          task.progressPercent = 100;
        }
        task.updatedAt = Date.now();
        await taskRepository.save(task);
        alert('【一键重试】指令已成功下发！视频生成渲染引擎已重新启动。');
      } else {
        const userErrMsg = data.userMessage || data.error || '重试启动失败，请检查算力账号凭据或连接状态';
        task.status = 'failed';
        task.error = {
          code: data.source?.toUpperCase() || 'RETRY_FAILED',
          stage: 'submit',
          messageChinese: humanizeErrorMessage(userErrMsg),
          technicalMessageRedacted: data.technicalMessageRedacted || data.error || '无法建立重试连接',
          httpStatus: res.status,
          retryable: true,
          recommendedAction: '检查算力连接配置后重试，或在【动效工坊】重新上传生成',
        };
        await taskRepository.save(task);
        alert(`一键重试启动失败（HTTP ${res.status}）：${humanizeErrorMessage(userErrMsg)}`);
      }
      if (selectedTask?.id === task.id) {
        setSelectedTask({ ...task });
      }
      await loadTasks();
    } catch (err: any) {
      console.error('Retry task error:', err);
      const errText = err.message || String(err);
      const friendlyErr = humanizeErrorMessage(errText);
      task.status = 'failed';
      task.error = {
        code: 'NETWORK_ERROR',
        stage: 'submit',
        messageChinese: friendlyErr,
        technicalMessageRedacted: errText,
        httpStatus: 500,
        retryable: true,
        recommendedAction: '请检查算力环境连接状态或点击【手动查询】',
      };
      await taskRepository.save(task);
      if (selectedTask?.id === task.id) {
        setSelectedTask({ ...task });
      }
      await loadTasks();
      alert(`重试异常：${friendlyErr}`);
    } finally {
      setIsRetryingTaskId(null);
    }
  };

  const handleCheckTask = async (task: GenerationTask) => {
    if (!task.id) return;
    setIsCheckingTask(true);
    try {
      const connectionId = localStorage.getItem('zaojing_connection_id') || '';
      const res = await fetch(`/api/videos/status/${task.id}?forceQuery=true`, {
        headers: { 'x-connection-id': connectionId },
      });
      const data = await parseJsonResponse(res).catch(() => ({}));
      if (res.status === 404 || data?.httpStatus === 404) {
        if (!task.resultVideoUrl && task.status !== 'completed' && task.status !== 'completed_with_warning') {
          task.status = 'orphaned_local_task';
          task.progressStage = '该任务仅存在于本地缓存，服务端没有对应任务记录';
          await taskRepository.save(task);
        }
        if (selectedTask?.id === task.id) setSelectedTask({ ...task });
        await loadTasks();
        return;
      }
      if (data.status === 'completed' && data.videoDataUrl) {
        task.status = 'completed';
        task.resultVideoUrl = data.videoDataUrl;
        task.qaReport = data.qaReport;
        task.identityQaStatus = data.identityQaStatus || task.identityQaStatus;
        task.humanReviewDecision = data.humanReviewDecision || task.humanReviewDecision;
        task.humanReviewRecord = data.humanReviewRecord || task.humanReviewRecord;
        task.error = undefined;
        task.progressStage = '合成与全帧视频生成完成';
        task.progressPercent = 100;
        await taskRepository.save(task);
        if (selectedTask?.id === task.id) setSelectedTask({ ...task });
        await loadTasks();
      } else if (data.status === 'qa_pending') {
        task.status = 'qa_pending';
        task.identityQaStatus = data.identityQaStatus || task.identityQaStatus;
        task.qaReport = data.qaReport || task.qaReport;
        task.humanReviewDecision = data.humanReviewDecision || task.humanReviewDecision;
        task.humanReviewRecord = data.humanReviewRecord || task.humanReviewRecord;
        if (data.videoDataUrl || data.resultVideoUrl) {
          task.resultVideoUrl = data.videoDataUrl || data.resultVideoUrl;
        }
        task.error = undefined;
        task.progressStage = data.requiresManualApproval
          ? '视频身份质检需要人工复核'
          : '视频已持久化，等待身份质检';
        task.progressPercent = 95;
        await taskRepository.save(task);
        if (selectedTask?.id === task.id) setSelectedTask({ ...task });
        await loadTasks();
      } else if (data.status === 'failed') {
        task.status = 'failed';
        (task as any).failureReason = data.failureReason || (task as any).failureReason;
        (task as any).retryMode = data.retryMode || (task as any).retryMode;
        (task as any).raiStatus = data.raiStatus || (task as any).raiStatus;
        if (data.raiMediaFilteredCount !== undefined && data.raiMediaFilteredCount !== null) {
          (task as any).raiMediaFilteredCount = data.raiMediaFilteredCount;
        }
        if (Array.isArray(data.raiMediaFilteredReasons)) {
          (task as any).raiMediaFilteredReasons = data.raiMediaFilteredReasons;
        }
        const errStr = typeof data.error === 'string'
          ? data.error
          : (data.error?.message ? String(data.error.message) : (data.error ? JSON.stringify(data.error) : '视频生成失败'));

        task.error = data.structuredError || {
          code: 'FAILED',
          stage: 'polling',
          messageChinese: errStr,
          technicalMessageRedacted: errStr,
          httpStatus: 500,
          retryable: true,
          recommendedAction: '请在确认后重新发起提交或点击一键重试',
        };
        await taskRepository.save(task);
        if (selectedTask?.id === task.id) setSelectedTask({ ...task });
        await loadTasks();
      } else if (data.status === 'polling_timeout') {
        task.status = 'polling_timeout';
        task.progressStage = '云端渲染较慢，已保留 OperationName。可在任务记录随时「手动查询」';
        task.error = undefined;
        await taskRepository.save(task);
        if (selectedTask?.id === task.id) setSelectedTask({ ...task });
        await loadTasks();
      } else {
        task.status = 'polling_video';
        task.progressStage = `云端视频渲染中... (已耗时 ${data.elapsedSeconds || 0}s)`;
        task.progressPercent = Math.min(95, 75 + Math.floor((data.elapsedSeconds || 0) / 6));
        task.error = undefined;
        await taskRepository.save(task);
        if (selectedTask?.id === task.id) setSelectedTask({ ...task });
        await loadTasks();
      }
    } catch (err) {
      console.error('Check task error:', err);
    } finally {
      setIsCheckingTask(false);
    }
  };

  const filteredTasks = tasks
    .filter((t) => {
      if (filter === 'completed') return t.status === 'completed' || t.status === 'completed_with_warning';
      if (filter === 'failed') return isTaskFailedState(t);
      if (filter === 'review') return isTaskHumanReviewState(t);
      if (filter === 'in_progress')
        return (
          t.status !== 'completed' &&
          t.status !== 'completed_with_warning' &&
          !isTaskFailedState(t) &&
          !isTaskHumanReviewState(t)
        );
      return true;
    })
    .sort(
      (a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0) || (b.id || '').localeCompare(a.id || '')
    );

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-6 sm:space-y-8">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-zinc-100 flex items-center gap-2">
            <History className="w-5 h-5 text-indigo-400" />
            任务历史与质检归档
            <button
              onClick={handleManualRefresh}
              className={`p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition ml-2 ${
                isRefreshing ? 'animate-spin text-indigo-400' : ''
              }`}
              title="刷新任务列表"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </h2>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            实时监测云端视频渲染进度、全帧抽取质检与任务归档。
          </p>
        </div>

        {/* Filters and Clear Failed */}
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 w-full sm:w-auto">
          <button
            onClick={handleClearFailedTasks}
            disabled={failedTaskCount === 0}
            className={`px-3 py-1.5 rounded-lg border transition flex items-center gap-1.5 text-xs font-semibold shrink-0 ${
              failedTaskCount > 0
                ? 'bg-rose-950/80 hover:bg-rose-900 border-rose-800 text-rose-200 hover:text-white shadow-sm cursor-pointer'
                : 'bg-zinc-900/60 border-zinc-800/80 text-zinc-600 cursor-not-allowed'
            }`}
            title={failedTaskCount > 0 ? `一键批量清空 ${failedTaskCount} 个失败任务` : '当前暂无失败任务'}
          >
            <Trash2 className={`w-3.5 h-3.5 ${failedTaskCount > 0 ? 'text-rose-400' : 'text-zinc-600'}`} />
            <span>批量清空失败任务{failedTaskCount > 0 ? ` (${failedTaskCount})` : ''}</span>
          </button>

          <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-lg text-xs w-full sm:w-auto overflow-x-auto">
            <button
              onClick={() => setFilter('all')}
              className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md font-medium transition whitespace-nowrap ${
                filter === 'all' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              全部 ({tasks.length})
            </button>
            <button
              onClick={() => setFilter('in_progress')}
              className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md font-medium transition whitespace-nowrap ${
                filter === 'in_progress' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              生成中 ({inProgressTaskCount})
            </button>
            <button
              onClick={() => setFilter('review')}
              className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md font-medium transition whitespace-nowrap ${
                filter === 'review' ? 'bg-amber-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              待审核 ({reviewTaskCount})
            </button>
            <button
              onClick={() => setFilter('completed')}
              className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md font-medium transition whitespace-nowrap ${
                filter === 'completed' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              已完成 ({completedTaskCount})
            </button>
            <button
              onClick={() => setFilter('failed')}
              className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md font-medium transition whitespace-nowrap ${
                filter === 'failed' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              失败 ({failedTaskCount})
            </button>
          </div>
        </div>
      </div>

      {failedTaskCount > 0 && filter === 'failed' && (
        <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-800/60 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Trash2 className="w-5 h-5 text-rose-400 shrink-0" />
            <div>
              <h4 className="text-sm font-bold text-rose-200">发现 {failedTaskCount} 个失败或异常断开的任务</h4>
              <p className="text-xs text-rose-300/80 mt-0.5">点击批量清空可以一键删除所有失败任务并清理云端僵尸渲染进程。</p>
            </div>
          </div>
          <button
            onClick={handleClearFailedTasks}
            className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition shadow-lg shrink-0 flex items-center gap-1.5 cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
            批量清空 ({failedTaskCount})
          </button>
        </div>
      )}

      {filteredTasks.length === 0 ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 sm:p-12 text-center space-y-4">
          <Film className="w-10 h-10 text-zinc-600 mx-auto" />
          <p className="text-sm text-zinc-500">暂无符合条件的任务记录</p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredTasks.map((task) => {
            const isFinished = task.status === 'completed' || task.status === 'completed_with_warning' || task.status === 'failed';
            const elapsedSec = isFinished
              ? Math.max(0, Math.floor(((task.updatedAt || Date.now()) - task.createdAt) / 1000))
              : Math.max(0, Math.floor((Date.now() - task.createdAt) / 1000));
            const promptText = task.userPromptChinese || (task as any).normalizedPromptChinese || '写实细腻人物动作演绎';
            const videoUrl = getVideoUrl(task);

            return (
              <div
                key={task.id}
                onClick={() => setSelectedTask(task)}
                className="bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl p-3 sm:p-4 cursor-pointer transition flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 group"
              >
                <div className="flex items-start sm:items-center space-x-3 sm:space-x-4 overflow-hidden w-full">
                  {/* Scene thumbnail */}
                  <div className="w-14 h-20 sm:w-16 sm:h-24 bg-zinc-950 rounded-lg overflow-hidden shrink-0 border border-zinc-800 flex items-center justify-center">
                    {task.sceneImageBlob ? (
                      <img
                        src={safeCreateObjectURL(task.sceneImageBlob)}
                        alt="scene"
                        className="w-full h-full object-cover"
                      />
                    ) : task.sceneImageUrl ? (
                      <img
                        src={task.sceneImageUrl}
                        alt="scene"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Film className="w-6 h-6 text-zinc-700" />
                    )}
                  </div>

                  <div className="space-y-1.5 overflow-hidden flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                      <span className="font-semibold text-xs sm:text-sm text-zinc-200 group-hover:text-indigo-400 transition truncate max-w-full">
                        {promptText}
                      </span>
                      {(() => {
                        const badge = isTaskHumanReviewState(task)
                          ? { text: '待人工审核', cls: 'bg-amber-950 text-amber-300 border border-amber-700/70' }
                          : getStatusBadgeInfo(task.status);
                        return (
                          <span className={`text-[10px] px-2 py-0.5 rounded font-medium shrink-0 ${badge.cls}`}>
                            {badge.text}
                          </span>
                        );
                      })()}
                    </div>

                    <div className="text-[11px] sm:text-xs text-zinc-400 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>场景模式: {formatSceneMode(task.sceneMode)}</span>
                      <span>执行用时: {formatDuration(elapsedSec)}</span>
                      <span>
                        {task.retryCount && task.retryCount > 0
                          ? `重试轮数: ${task.retryCount} 轮`
                          : '执行轮次: 第 1 轮'}
                      </span>
                      <span>创建于: {new Date(task.createdAt).toLocaleString()}</span>
                    </div>

                    {!isFinished && task.progressStage && !isTaskFailedState(task) && !isTaskHumanReviewState(task) && (
                      <div className="text-[11px] sm:text-xs text-indigo-400 flex items-center gap-1.5 font-medium animate-pulse">
                        <Clock className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{task.progressStage}</span>
                      </div>
                    )}

                    {isTaskHumanReviewState(task) && (
                      <div className="mt-2.5 p-3 bg-amber-950/35 border border-amber-700/60 rounded-lg text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex items-start gap-2 min-w-0">
                          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                          <div>
                            <div className="font-bold text-amber-200">视频已生成，等待人工复核</div>
                            <div className="text-[11px] text-amber-100/70 mt-1">这不是生成卡住。AI QA 判定为 REVIEW，需要人工接受或拒绝后任务才会结束。</div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenHumanReview(task);
                          }}
                          className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs shrink-0"
                        >
                          进入人工审核
                        </button>
                      </div>
                    )}

                    {isTaskFailedState(task) && task.status !== 'orphaned_local_task' && (() => {
                      const failInfo = getExplicitTaskFailureReason(task);
                      const requiresInputRewrite = isTaskInputRewriteRequired(task);
                      return (
                        <div className="mt-2.5 p-3 bg-rose-950/60 border border-rose-800/80 rounded-lg text-xs space-y-2.5">
                          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2.5">
                            <div className="flex items-start gap-2 min-w-0 flex-1">
                              <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                              <div className="space-y-1.5 min-w-0 flex-1">
                                <div className="font-bold text-rose-200 text-xs leading-relaxed break-words">
                                  失败原因: <span className="text-rose-100 font-semibold">{String(failInfo.primaryReason || '视频生成中断')}</span>
                                </div>
                                {failInfo.technicalDetails && (
                                  <div className="text-[11px] font-mono text-rose-300/80 bg-black/50 p-2 rounded border border-rose-900/60 break-words leading-relaxed">
                                    {String(failInfo.technicalDetails)}
                                  </div>
                                )}
                                <div className="text-[11px] text-amber-300/90 font-medium leading-relaxed">
                                  建议: {String(failInfo.recommendedAction || '请点击一键重试')}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 pt-1 sm:pt-0 self-end sm:self-auto w-full sm:w-auto justify-end">
                              {requiresInputRewrite ? (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleOpenInputRewrite(task);
                                  }}
                                  className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs flex items-center gap-1 shadow transition shrink-0 cursor-pointer"
                                  title="安全过滤任务必须先修改提示词或图片；不会从任务记录原样重新提交 Veo"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                  返回工作台调整输入
                                </button>
                              ) : (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRetryTask(task);
                                  }}
                                  disabled={isRetryingTaskId === task.id}
                                  className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs flex items-center gap-1 shadow transition disabled:opacity-50 shrink-0 cursor-pointer"
                                >
                                  <RefreshCw className={`w-3.5 h-3.5 ${isRetryingTaskId === task.id ? 'animate-spin' : ''}`} />
                                  一键重试
                                </button>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteTask(task.id);
                                }}
                                className="px-2.5 py-1.5 rounded bg-rose-950 hover:bg-rose-900 border border-rose-800/80 text-rose-300 hover:text-rose-200 font-semibold text-xs flex items-center gap-1 shadow transition shrink-0 cursor-pointer"
                                title="删除此失败任务及云端记录"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                删除
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {task.status === 'polling_timeout' && (
                      <div className="mt-2.5 p-3 bg-amber-950/50 border border-amber-800/80 rounded-lg text-xs space-y-2">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-amber-200 font-medium">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <Clock className="w-4 h-4 text-amber-400 shrink-0" />
                            <span className="truncate">
                              云端渲染耗时较长（15分钟+），任务仍保留在 Google 云端生成队列中
                            </span>
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCheckTask(task);
                            }}
                            disabled={isCheckingTask}
                            className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow transition shrink-0 cursor-pointer disabled:opacity-50 self-end sm:self-auto"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${isCheckingTask ? 'animate-spin' : ''}`} />
                            手动查询最新结果
                          </button>
                        </div>
                        <div className="text-[11px] text-amber-300/80 leading-relaxed">
                          提示：系统后台依然在自动跟进，您也可以随时点击【手动查询最新结果】同步拉取高质 9:16 MP4 视频。
                        </div>
                      </div>
                    )}

                    {(task.status === 'polling_video' || task.status === 'polling' || task.status === 'starting_video' || task.status === 'processing') && (
                      <div className="mt-2.5 p-2.5 bg-indigo-950/40 border border-indigo-800/60 rounded-lg text-xs flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-indigo-300 text-[11px] font-medium min-w-0 truncate">
                          <Clock className="w-3.5 h-3.5 text-indigo-400 animate-spin shrink-0" />
                          <span className="truncate">{task.progressStage || '云端视频渲染中...'}</span>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCheckTask(task);
                          }}
                          disabled={isCheckingTask}
                          className="px-2.5 py-1 rounded bg-indigo-900/80 hover:bg-indigo-800 text-indigo-200 border border-indigo-700/60 font-semibold text-[11px] flex items-center gap-1 transition shrink-0 cursor-pointer disabled:opacity-50"
                          title="主动向服务端发送查询请求"
                        >
                          <RefreshCw className={`w-3 h-3 ${isCheckingTask ? 'animate-spin' : ''}`} />
                          实时查验进度
                        </button>
                      </div>
                    )}

                    {task.status === 'orphaned_local_task' && (
                      <div className="mt-2 p-2.5 bg-amber-950/50 border border-amber-800/80 rounded-lg text-xs space-y-2">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-amber-200 font-medium min-w-0">
                            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                            <span className="truncate">
                              {task.progressStage || '该任务仅存在于本地缓存，服务端没有对应任务记录'}
                            </span>
                          </span>
                          <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRetryTask(task);
                              }}
                              disabled={isRetryingTaskId === task.id}
                              className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold text-[11px] flex items-center gap-1 shadow transition disabled:opacity-50 cursor-pointer"
                              title="使用保存的本地参数向云端重新发起生成任务"
                            >
                              <RefreshCw className={`w-3 h-3 ${isRetryingTaskId === task.id ? 'animate-spin' : ''}`} />
                              重新提交到云端
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteTask(task.id);
                              }}
                              className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium text-[11px] flex items-center gap-1 transition cursor-pointer"
                            >
                              <Trash2 className="w-3 h-3" />
                              删除记录
                            </button>
                          </div>
                        </div>
                        <div className="text-[11px] text-amber-300/80 leading-relaxed">
                          说明：由于服务重启或集群重建，云端原记录已失效。您可以点击【重新提交到云端】使用已有参数直接重新发起，或删除该记录。
                        </div>
                      </div>
                    )}

                    {task.qaReport && typeof task.qaReport.averageIdentityScore === 'number' && (
                      <div className="text-[11px] sm:text-xs text-indigo-400 font-mono truncate">
                        全帧抽帧均分: {task.qaReport.averageIdentityScore} 分
                        {typeof task.qaReport.minimumIdentityScore === 'number' && (
                          <span> | 最小分: {task.qaReport.minimumIdentityScore} 分</span>
                        )}
                      </div>
                    )}

                    {/* Tuning Parameters Summary Card */}
                    <div className="mt-2.5 p-2.5 bg-zinc-950/90 border border-zinc-800/90 rounded-lg text-xs space-y-1.5 font-mono">
                      <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
                        <span className="text-indigo-300 font-sans font-bold flex items-center gap-1.5 truncate">
                          <Sliders className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                          <span className="truncate">
                            入参: {task.settings?.durationSeconds || 8}s | {task.settings?.aspectRatio || '9:16'} | {task.settings?.resolution || '1080p'} | {formatSceneMode(task.sceneMode)}
                          </span>
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyParams(task);
                          }}
                          className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white font-sans text-[10px] flex items-center gap-1 transition shrink-0"
                          title="一键复制本任务调整用入参和出参"
                        >
                          {copiedTaskId === task.id ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-400" />
                              <span>已复制参数</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3 text-indigo-400" />
                              <span>复制执行参数</span>
                            </>
                          )}
                        </button>
                      </div>
                      {task.status === 'failed' && (
                        <div className="text-rose-300 font-sans text-[11px] pt-1.5 border-t border-zinc-800/80 flex items-center gap-1.5 min-w-0">
                          <XCircle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
                          <span className="truncate min-w-0 flex-1">
                            出参 [HTTP {typeof task.error === 'object' && task.error?.httpStatus ? task.error.httpStatus : 500}]: {humanizeErrorMessage(task.error?.messageChinese || task.error?.technicalMessageRedacted || task.progressStage || '生成中断')}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center space-x-2 sm:space-x-2.5 self-end sm:self-center shrink-0">
                  {videoUrl && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownloadTaskVideo(videoUrl, task.id, task);
                      }}
                      disabled={downloadingTaskId === task.id}
                      className="px-3 py-1.5 rounded-lg bg-indigo-900/60 hover:bg-indigo-800 text-indigo-200 border border-indigo-700/50 transition flex items-center gap-1.5 text-xs font-medium disabled:opacity-50 cursor-pointer"
                      title="点击持久化下载高清 MP4 视频"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">
                        {downloadingTaskId === task.id ? '下载中...' : '下载视频'}
                      </span>
                    </button>
                  )}

                  {!['output_rai_filtered', 'upstream_empty_response', 'artifact_invalid', 'input_safety_blocked', 'legacy_invalid_artifact'].includes(task.failureReason as string) && (task.videoUri || task.externalOperationName || task.status === ('artifact_persist_failed' as any)) && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRecoverArtifact(task);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-teal-900/60 hover:bg-teal-800 text-teal-200 border border-teal-700/50 transition flex items-center gap-1.5 text-xs font-medium cursor-pointer"
                      title="不触发 Veo 重新生成，仅从云端获取或恢复视频产物"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">重新获取视频</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRetryTask(task);
                    }}
                    disabled={isRetryingTaskId === task.id}
                    className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-indigo-600/90 text-zinc-300 hover:text-white border border-zinc-700/80 hover:border-indigo-500 transition flex items-center gap-1.5 text-xs font-medium disabled:opacity-50 cursor-pointer"
                    title="重新提交 Veo 生成任务"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRetryingTaskId === task.id ? 'animate-spin' : ''}`} />
                    <span className="hidden sm:inline">重新生成</span>
                  </button>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteTask(task.id);
                    }}
                    className="p-1.5 rounded-lg hover:bg-rose-950/40 text-zinc-500 hover:text-rose-400 transition cursor-pointer"
                    title="删除记录"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Task detail drawer */}
      {selectedTask && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end">
          <div className="bg-zinc-900 border-l border-zinc-800 w-full max-w-xl h-full overflow-y-auto p-6 space-y-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
              <h3 className="text-base font-bold text-zinc-100 truncate pr-2">任务详情归档 ({selectedTask.id.slice(0, 8)})</h3>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleCopyParams(selectedTask)}
                  className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow-lg transition cursor-pointer"
                  title="一键复制本任务调整用入参与出参"
                >
                  {copiedTaskId === selectedTask.id ? (
                    <>
                      <Check className="w-4 h-4 text-emerald-300" />
                      <span>已复制执行参数！</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 text-indigo-200" />
                      <span>复制执行参数</span>
                    </>
                  )}
                </button>
                <button onClick={() => setSelectedTask(null)} className="text-zinc-400 hover:text-zinc-200 p-1">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {isTaskHumanReviewState(selectedTask) && (
              <div className="p-4 rounded-xl bg-amber-950/35 border border-amber-700/60 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold text-amber-200 text-sm">视频已生成，当前等待人工审核</div>
                    <div className="text-[11px] text-amber-100/70 mt-1">QA REVIEW 是人工决策状态，不属于“生成中”。进入创作工作台后可查看 QA 证据并执行接受 / 拒绝。</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleOpenHumanReview(selectedTask)}
                  className="w-full px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs"
                >
                  进入人工审核工作台
                </button>
              </div>
            )}

            {/* Video preview or Failure Panel */}
            {getVideoUrl(selectedTask) ? (
              <div className="space-y-3">
                <div className="aspect-[9/16] max-w-xs mx-auto rounded-xl bg-black overflow-hidden border border-zinc-800 shadow-xl">
                  <video
                    src={getVideoUrl(selectedTask)!}
                    controls
                    loop
                    autoPlay
                    className="w-full h-full object-contain"
                  />
                </div>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      const url = getVideoUrl(selectedTask);
                      if (url) handleDownloadTaskVideo(url, selectedTask.id, selectedTask);
                    }}
                    disabled={downloadingTaskId === selectedTask.id}
                    className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-xs flex items-center gap-2 shadow-lg transition cursor-pointer"
                  >
                    <Download className="w-4 h-4" />
                    {downloadingTaskId === selectedTask.id ? '下载处理中...' : '下载高清 MP4 视频'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRecoverArtifact(selectedTask)}
                    className="px-3.5 py-2 rounded-lg bg-teal-900/60 hover:bg-teal-800 text-teal-200 font-medium text-xs flex items-center gap-1.5 transition border border-teal-700/80 shadow cursor-pointer"
                    title="不触发 Veo 重新生成，仅从云端获取或恢复视频产物"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    重新获取视频
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRetryTask(selectedTask)}
                    disabled={isRetryingTaskId === selectedTask.id}
                    className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-indigo-600 text-zinc-200 hover:text-white font-medium text-xs flex items-center gap-1.5 transition border border-zinc-700/80 shadow cursor-pointer disabled:opacity-50"
                    title="重新发起 Veo 渲染任务"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRetryingTaskId === selectedTask.id ? 'animate-spin' : ''}`} />
                    重新生成
                  </button>
                  <a
                    href={getVideoUrl(selectedTask)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium text-xs flex items-center gap-1.5 transition border border-zinc-700/60"
                  >
                    <Film className="w-3.5 h-3.5 text-zinc-400" />
                    新窗口播放/保存
                  </a>
                </div>
              </div>
            ) : isTaskFailedState(selectedTask) ? (() => {
              const failInfo = getExplicitTaskFailureReason(selectedTask);
              return (
                <div className="p-4 bg-rose-950/60 border border-rose-800/80 rounded-xl space-y-3.5 text-xs shadow-lg">
                  <div className="flex items-center justify-between text-rose-200 font-bold border-b border-rose-800/60 pb-2">
                    <div className="flex items-center gap-2 text-sm">
                      <XCircle className="w-5 h-5 text-rose-400 shrink-0" />
                      <span>视频生成失败显性诊断</span>
                    </div>
                    <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-rose-900/80 text-rose-300 border border-rose-700">
                      {failInfo.errorCode}
                    </span>
                  </div>

                  <div className="space-y-2 text-rose-100">
                    <div className="p-3 bg-black/60 rounded-lg border border-rose-800/80 leading-relaxed font-medium text-xs break-words space-y-1">
                      <div className="text-[11px] font-bold text-rose-400 flex items-center gap-1">
                        🚫 明确失败原因:
                      </div>
                      <div className="text-rose-100 text-xs leading-relaxed">
                        {String(failInfo.primaryReason)}
                      </div>
                    </div>

                    {/* Negative prompt block diagnosis warning */}
                    {(() => {
                      const promptText = typeof selectedTask.userPromptChinese === 'string' ? selectedTask.userPromptChinese : '';
                      if (!promptText) return null;
                      if (!promptText.includes('负向提示词') && !promptText.includes('【')) return null;
                      return (
                        <div className="p-2.5 bg-amber-950/70 rounded-lg border border-amber-800/80 text-amber-200 text-xs flex items-start gap-2">
                          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-bold text-amber-300">检测到提示词包含“负向提示词”标识块：</span>
                            <div className="mt-1 text-amber-200/90 leading-relaxed">
                              Veo 原生 AI 引擎不支持独立的负向提示词输入框。若将包含“【负向提示词】夸张大笑、人物换脸…”的原始模版文字直接发往模型，会导致模型安全拦截或生成中断。
                              <br />
                              <span className="text-emerald-300 font-medium">现已启用自动清洗过滤。点击下方的【一键重新发起生成】，系统将自动抹除负向提示词块并重新发起高品质渲染。</span>
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {failInfo.technicalDetails && (
                      <div className="p-2.5 bg-black/50 rounded-lg border border-rose-900/80 font-mono text-[11px] text-rose-300/90 leading-relaxed break-words">
                        <div className="text-[10px] text-zinc-500 mb-1">底座调测与日志追踪 (Technical Logs):</div>
                        {String(failInfo.technicalDetails)}
                      </div>
                    )}

                    <div className="text-zinc-200 bg-black/40 p-2.5 rounded-lg border border-zinc-800 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold text-amber-300">推荐解法: </span>
                        {failInfo.recommendedAction}
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 flex flex-wrap items-center gap-2 justify-end">
                    {onNavigateToStudio && (
                      <button
                        onClick={() => {
                          if (selectedTask && selectedTask.id) {
                            sessionStorage.setItem('zaojing_bring_task_id', selectedTask.id);
                          }
                          setSelectedTask(null);
                          onNavigateToStudio();
                        }}
                        className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition cursor-pointer"
                      >
                        带入【动效工坊】重新编辑
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteTask(selectedTask.id)}
                      className="px-3 py-1.5 rounded-lg bg-rose-950 hover:bg-rose-900 border border-rose-800/80 text-rose-300 font-semibold text-xs flex items-center gap-1.5 shadow transition cursor-pointer"
                      title="删除任务并清理云端进程"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      删除失败任务与云端进程
                    </button>
                    <button
                      onClick={() => handleRetryTask(selectedTask)}
                      disabled={isRetryingTaskId === selectedTask.id}
                      className="px-4 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow-lg transition disabled:opacity-50 cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isRetryingTaskId === selectedTask.id ? 'animate-spin' : ''}`} />
                      一键重新发起生成
                    </button>
                  </div>
                </div>
              );
            })() : (
              <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-lg text-xs text-zinc-400 space-y-2">
                <div className="flex items-center gap-2 text-indigo-400 font-medium">
                  <Clock className="w-4 h-4 animate-spin" />
                  <span>当前云端算力渲染状态: {selectedTask.progressStage || '正在后台处理...'}</span>
                </div>
                <p>视频生成完全在云侧由 Veo 引擎异步完成，完成后即可在上方直接在线预览并下载。</p>
              </div>
            )}

            {/* Dedicated Execution & Tuning Parameters Inspector Block */}
            {(() => {
              const payload = buildExecutionTuningPayload(selectedTask);
              return (
                <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-xl space-y-3 text-xs">
                  <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                    <div className="flex items-center gap-2 font-bold text-zinc-200">
                      <Sliders className="w-4 h-4 text-indigo-400" />
                      <span>接口调优与执行参数 (Inputs & Outputs)</span>
                    </div>
                    <button
                      onClick={() => handleCopyParams(selectedTask)}
                      className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-indigo-300 font-semibold text-[11px] flex items-center gap-1 transition cursor-pointer"
                    >
                      {copiedTaskId === selectedTask.id ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span>已复制</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3 text-indigo-400" />
                          <span>一键复制执行参数</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px] font-mono">
                    {/* Inputs */}
                    <div className="p-3 bg-zinc-900/90 rounded-lg border border-zinc-800/80 space-y-1.5">
                      <div className="font-sans font-bold text-indigo-300 text-xs border-b border-zinc-800 pb-1">
                        调优入参 (Inputs)
                      </div>
                      <div className="text-zinc-300"><span className="text-zinc-500">场景模式: </span>{formatSceneMode(payload.sceneMode)}</div>
                      <div className="text-zinc-300"><span className="text-zinc-500">基座模型: </span>{payload.modelId}</div>
                      <div className="text-zinc-300"><span className="text-zinc-500">生成规格: </span>{payload.inputs.durationSeconds}s / {payload.inputs.aspectRatio} / {payload.inputs.resolution}</div>
                      <div className="text-zinc-300"><span className="text-zinc-500">镜位预设: </span>{payload.inputs.cameraPreset}</div>
                      <div className="text-zinc-300"><span className="text-zinc-500">动作幅度: </span>{payload.inputs.motionIntensity}</div>
                      <div className="text-zinc-300"><span className="text-zinc-500">视觉风格: </span>{payload.inputs.visualStyle}</div>
                      <div className="text-zinc-300"><span className="text-zinc-500">首帧情况: </span>{payload.inputs.hasSceneImage ? '包含场景首帧图' : '无场景首帧图'}</div>
                    </div>

                    {/* Outputs */}
                    <div className="p-3 bg-zinc-900/90 rounded-lg border border-zinc-800/80 space-y-1.5">
                      <div className="font-sans font-bold text-indigo-300 text-xs border-b border-zinc-800 pb-1">
                        调优出参 (Outputs)
                      </div>
                      <div className="text-zinc-300">
                        <span className="text-zinc-500">执行状态: </span>
                        <span className={payload.outputs.status === 'failed' ? 'text-rose-400 font-bold' : payload.outputs.status === 'completed' ? 'text-emerald-400 font-bold' : 'text-amber-300'}>
                          {payload.outputs.status}
                        </span>
                      </div>
                      <div className="text-zinc-300"><span className="text-zinc-500">HTTP Status: </span>{payload.outputs.httpStatus ?? 'N/A'}</div>
                      <div className="text-zinc-300"><span className="text-zinc-500">错误代码: </span>{payload.outputs.errorCode}</div>
                      <div className="text-zinc-300"><span className="text-zinc-500">执行用时: </span>{payload.executionTimeSeconds} 秒</div>
                      {payload.outputs.operationName && (
                        <div className="text-zinc-300 truncate" title={payload.outputs.operationName}>
                          <span className="text-zinc-500">Operation: </span>{payload.outputs.operationName}
                        </div>
                      )}
                    </div>
                  </div>

                  {payload.outputs.messageChinese && (
                    <div className="p-2.5 bg-rose-950/40 border border-rose-800/60 rounded-lg text-rose-200 text-[11px] font-sans break-words">
                      <span className="font-bold text-rose-300">调优报错提示: </span>
                      {humanizeErrorMessage(payload.outputs.messageChinese)}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Google Cloud Storage Location & Direct Links */}
            <GcsLocationCard task={selectedTask} payload={buildExecutionTuningPayload(selectedTask)} />

            {/* Prompt Chinese */}
            <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg space-y-1 text-xs">
              <div className="font-semibold text-zinc-300">动作指令 (中文)</div>
              <div className="text-zinc-200 leading-relaxed">
                {selectedTask.userPromptChinese || (selectedTask as any).normalizedPromptChinese || '无动作描述'}
              </div>
            </div>

            {/* Normalized Prompt English */}
            <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg space-y-1 text-xs">
              <div className="font-semibold text-zinc-300">标准化 Prompt (英文)</div>
              <div className="font-mono text-zinc-400 leading-relaxed text-[11px]">
                {selectedTask.normalizedPromptEnglish || '未生成'}
              </div>
            </div>

            {/* QA Report */}
            {selectedTask.qaReport && typeof selectedTask.qaReport.averageIdentityScore === 'number' && (
              <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-lg space-y-2 text-xs">
                <div className="font-semibold text-zinc-200 flex items-center justify-between">
                  <span>视频 6 关键帧 AI 质检报告</span>
                  <span className="text-indigo-400 font-mono">
                    均分 {selectedTask.qaReport.averageIdentityScore}
                  </span>
                </div>
                <p className="text-zinc-400 leading-relaxed">{selectedTask.qaReport.summary}</p>
              </div>
            )}

            {/* Attempt logs */}
            {(selectedTask.attempts || []).length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-zinc-300">重试履历日志</div>
                <div className="space-y-1.5 text-xs font-mono">
                  {(selectedTask.attempts || []).map((att, idx) => (
                    <div key={idx} className="p-2 bg-zinc-950 rounded border border-zinc-800/80 flex items-center justify-between">
                      <span className="text-zinc-400">
                        第 {att.attemptIndex} 轮 [{att.actionType}]
                      </span>
                      <span className={att.success ? 'text-emerald-400' : 'text-rose-400'}>
                        {att.success ? 'PASS' : 'FAIL'} ({att.qaScore ?? 0}分)
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="pt-4 border-t border-zinc-800 flex items-center justify-between gap-3">
              {selectedTask.status !== 'completed' && selectedTask.status !== 'completed_with_warning' && (
                selectedTask.externalOperationName || (selectedTask as any).operationName ? (
                  <button
                    onClick={() => handleCheckTask(selectedTask)}
                    disabled={isCheckingTask}
                    className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-2 transition disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isCheckingTask ? 'animate-spin' : ''}`} />
                    继续查询
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      if (confirm('无云端OperationName记录。重新提交将发起全新的付费视频模型算力请求，是否确认？')) {
                        alert('请在主控制台【动效工坊】重新发起任务。');
                      }
                    }}
                    className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold flex items-center gap-2 transition"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    重新提交 (须二次扣费确认)
                  </button>
                )
              )}
              <button
                onClick={() => handleDeleteTask(selectedTask.id)}
                className="px-4 py-2 rounded bg-rose-950 text-rose-400 text-xs font-medium hover:bg-rose-900/60 transition ml-auto"
              >
                删除任务记录
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
