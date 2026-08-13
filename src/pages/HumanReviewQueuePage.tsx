import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { taskRepository } from '../repositories/taskRepository';
import {
  isHumanReviewEligibleTask,
  isSubmissionOutcomeUnknownTask,
  sortHumanReviewTasks,
  type HumanReviewQueueTask,
} from '../services/review/humanReviewQueueService';

interface HumanReviewQueuePageProps {
  onNavigateToStudio: () => void;
}

const formatTime = (value?: number) => {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
};

const score = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(0) : '—';
};

export const HumanReviewQueuePage: React.FC<HumanReviewQueuePageProps> = ({ onNavigateToStudio }) => {
  const [reviewTasks, setReviewTasks] = useState<HumanReviewQueueTask[]>([]);
  const [unknownTasks, setUnknownTasks] = useState<HumanReviewQueueTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // taskRepository.getAll() first synchronizes the Firestore-backed server task list
      // into IndexedDB, then returns the merged local projection. Review eligibility is
      // still derived from durable server fields (qa_pending / QA REVIEW / GCS authority).
      const tasks = await taskRepository.getAll();
      const durableTasks = tasks as HumanReviewQueueTask[];
      setReviewTasks(sortHumanReviewTasks(durableTasks.filter(isHumanReviewEligibleTask)));
      setUnknownTasks(durableTasks.filter(isSubmissionOutcomeUnknownTask));
      setLastFetchedAt(Date.now());
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue();
    const timer = window.setInterval(() => void loadQueue(), 15000);
    return () => window.clearInterval(timer);
  }, [loadQueue]);

  const minScore = useMemo(() => {
    if (reviewTasks.length === 0) return null;
    const values = reviewTasks
      .map((task) => Number((task.qaReport || task.identityQaReport)?.minimumIdentityScore))
      .filter(Number.isFinite);
    return values.length ? Math.min(...values) : null;
  }, [reviewTasks]);

  const openInStudio = (task: HumanReviewQueueTask) => {
    sessionStorage.setItem('zaojing_bring_task_id', task.taskId);
    onNavigateToStudio();
  };

  return (
    <div className="max-w-[1400px] mx-auto p-4 md:p-7 space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-violet-400">
            <ClipboardCheck className="w-4 h-4" />
            M3 Review Queue
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-white mt-1">待我审核</h1>
          <p className="text-sm text-zinc-400 mt-1">
            聚合跨会话的 QA REVIEW 任务；选择任务后进入创作工作台完成最终接受或拒绝。
          </p>
        </div>
        <button
          onClick={() => void loadQueue()}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-700 text-sm text-zinc-200 hover:border-violet-500 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          刷新队列
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
          <div className="text-xs text-zinc-500">待审核</div>
          <div className="text-2xl font-bold text-amber-300 mt-1">{reviewTasks.length}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
          <div className="text-xs text-zinc-500">队列最低身份分</div>
          <div className="text-2xl font-bold text-zinc-100 mt-1">{minScore === null ? '—' : minScore.toFixed(0)}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
          <div className="text-xs text-zinc-500">提交结果未知</div>
          <div className="text-2xl font-bold text-rose-300 mt-1">{unknownTasks.length}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
          <div className="text-xs text-zinc-500">最后同步</div>
          <div className="text-xs font-medium text-zinc-200 mt-2">{lastFetchedAt ? formatTime(lastFetchedAt) : '尚未同步'}</div>
        </div>
      </div>

      {unknownTasks.length > 0 && (
        <div className="rounded-xl border border-rose-900/70 bg-rose-950/30 p-4 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold text-rose-200">存在 Provider submission outcome unknown 任务</div>
            <div className="text-xs text-rose-300/80 mt-1">
              这些任务不会进入可接受的 Review Queue，必须先恢复或核实 Provider operation，避免重复扣费或伪完成。
            </div>
            <div className="text-[11px] text-zinc-500 mt-2 break-all">
              {unknownTasks.map((task) => task.taskId).join(' · ')}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {reviewTasks.length === 0 ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 py-20 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
          <div className="text-lg font-semibold text-zinc-200">当前没有待审核视频</div>
          <div className="text-sm text-zinc-500 mt-1">AI PASS 会自动完成；硬 FAIL 与提交结果未知任务不会进入人工接受队列。</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {reviewTasks.map((task, index) => {
            const qa = task.qaReport || task.identityQaReport;
            const diagnosis = qa?.failureDiagnosis;
            return (
              <article key={task.taskId} className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-violet-400 font-bold">优先级 #{index + 1}</div>
                    <h2 className="text-base font-semibold text-zinc-100 truncate mt-1">{task.characterName || task.characterId || '未命名角色'}</h2>
                    <div className="text-[10px] font-mono text-zinc-600 truncate mt-1">{task.taskId}</div>
                  </div>
                  <span className="px-2 py-1 rounded-md bg-amber-950 text-amber-300 border border-amber-800 text-[10px] font-bold">REVIEW</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-zinc-950 border border-zinc-800 p-3">
                    <div className="text-[10px] text-zinc-500">最低身份分</div>
                    <div className="text-lg font-bold text-amber-300 mt-1">{score(qa?.minimumIdentityScore)}</div>
                  </div>
                  <div className="rounded-lg bg-zinc-950 border border-zinc-800 p-3">
                    <div className="text-[10px] text-zinc-500">平均身份分</div>
                    <div className="text-lg font-bold text-zinc-100 mt-1">{score(qa?.averageIdentityScore)}</div>
                  </div>
                </div>

                <div className="text-xs text-zinc-400 leading-relaxed min-h-10">
                  {qa?.summary || 'AI 未提供质检摘要'}
                </div>

                {diagnosis?.primaryCode && (
                  <div className="rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs">
                    <span className="text-amber-300 font-semibold">{diagnosis.primaryCode}</span>
                    {diagnosis.summary && <span className="text-zinc-500 ml-2">{diagnosis.summary}</span>}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 text-[11px] text-zinc-500">
                  <div>最差帧：<span className="text-zinc-300">{task.worstFrameTimestamp ?? qa?.worstFrameTimestamp ?? '—'} s</span></div>
                  <div>Provider：<span className="text-zinc-300">#{task.providerAttempt || 1}</span></div>
                </div>

                <div className="flex items-center gap-1.5 text-[11px] text-zinc-600">
                  <Clock className="w-3.5 h-3.5" /> {formatTime(task.createdAt)}
                </div>

                <button
                  onClick={() => openInStudio(task)}
                  className="mt-auto inline-flex items-center justify-center gap-2 rounded-xl border border-violet-700 bg-violet-950/40 px-4 py-2.5 text-sm font-semibold text-violet-200 hover:bg-violet-950/70"
                >
                  <ShieldCheck className="w-4 h-4" />
                  打开审核工作台
                </button>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
