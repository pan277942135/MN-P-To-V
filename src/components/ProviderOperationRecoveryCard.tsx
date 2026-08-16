import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCheck, Loader2, ShieldAlert } from 'lucide-react';

interface ProviderOperationRecoveryCardProps {
  taskId: string;
  onRecovered?: () => void | Promise<void>;
}

type RecoveryResult = {
  tone: 'success' | 'warning' | 'error';
  title: string;
  detail: string;
};

const classifyRecoveryResult = (status: number, payload: any): RecoveryResult => {
  if (status >= 200 && status < 300 && payload?.success && payload?.providerTaskLinked) {
    return {
      tone: 'success',
      title: 'Provider Operation 已安全绑定',
      detail: payload?.message || '已恢复原任务轮询，没有发起新的 Veo 生成。',
    };
  }

  if (payload?.failureReason === 'provider_operation_linkage_not_proven') {
    const running = payload?.linkageReason === 'operation_still_running';
    return {
      tone: 'warning',
      title: running ? 'Operation 已核实，但仍在运行' : 'Operation 与当前任务的关联尚未证明',
      detail: payload?.error || (running
        ? '请等待 Provider Operation 完成后再次核实；当前任务继续锁定，不会重新提交 Veo。'
        : '该 Operation 的输出不属于当前 taskId，或没有可验证的视频输出；当前任务继续锁定。'),
    };
  }

  if (payload?.failureReason === 'provider_operation_not_verified') {
    return {
      tone: 'error',
      title: '无法核实 Provider Operation',
      detail: payload?.error || '请确认 Operation Name 来自当前 Google Cloud 项目，并检查算力连接后重试核实。',
    };
  }

  if (payload?.failureReason === 'compute_session_unavailable') {
    return {
      tone: 'warning',
      title: '算力连接已失效',
      detail: payload?.error || '请先恢复 Google Cloud 算力连接，再核实该 Provider Operation。',
    };
  }

  return {
    tone: 'error',
    title: '安全恢复未完成',
    detail: payload?.error || `Provider Operation 核实失败 (HTTP ${status})。当前任务仍保持锁定。`,
  };
};

export const ProviderOperationRecoveryCard: React.FC<ProviderOperationRecoveryCardProps> = ({ taskId, onRecovered }) => {
  const [operationName, setOperationName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [scanningGcs, setScanningGcs] = useState(false);
  const [result, setResult] = useState<RecoveryResult | null>(null);

  const normalized = operationName.trim();
  const looksValid = useMemo(() => (
    normalized.length > 0 &&
    normalized.length <= 2048 &&
    !/\s/.test(normalized) &&
    /(^|\/)operations\/[^/]+$/.test(normalized)
  ), [normalized]);

  const scanTaskGcs = async () => {
    if (scanningGcs || submitting) return;
    setScanningGcs(true);
    setResult(null);
    try {
      const connectionId = localStorage.getItem('zaojing_connection_id') || '';
      const response = await fetch(`/api/videos/recover/${encodeURIComponent(taskId)}`, {
        method: 'POST',
        headers: {
          ...(connectionId ? { 'x-connection-id': connectionId } : {}),
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload?.success && payload?.recoveredBy === 'task_gcs_prefix' && payload?.providerTaskLinked) {
        setResult({
          tone: 'success',
          title: '已从任务专属 GCS 找回原视频',
          detail: payload?.message || '已找回原 Provider 产物并进入身份质检，没有发起新的 Veo 生成。',
        });
        await onRecovered?.();
      } else if (payload?.failureReason === 'task_gcs_artifact_not_found') {
        setResult({
          tone: 'warning',
          title: '暂未发现任务视频产物',
          detail: payload?.error || '任务保持锁定。可稍后再次检查，或在下方使用完整 Operation Name 核实。',
        });
      } else if (payload?.failureReason === 'task_gcs_artifact_ambiguous') {
        setResult({
          tone: 'warning',
          title: '发现多个候选视频，未自动解除锁定',
          detail: payload?.error || '为避免误绑定，系统拒绝自动选择候选产物。',
        });
      } else {
        setResult({
          tone: 'error',
          title: 'GCS 安全恢复未完成',
          detail: payload?.error || `任务专属 GCS 检查失败 (HTTP ${response.status})。当前任务继续锁定。`,
        });
      }
    } catch (err: any) {
      setResult({
        tone: 'error',
        title: '无法检查任务 GCS 产物',
        detail: err?.message || String(err),
      });
    } finally {
      setScanningGcs(false);
    }
  };

  const recover = async () => {
    if (!looksValid || submitting) return;
    setSubmitting(true);
    setResult(null);
    try {
      const connectionId = localStorage.getItem('zaojing_connection_id') || '';
      const response = await fetch('/api/videos/recover-task', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(connectionId ? { 'x-connection-id': connectionId } : {}),
        },
        body: JSON.stringify({ taskId, operationName: normalized }),
      });
      const payload = await response.json().catch(() => ({}));
      const nextResult = classifyRecoveryResult(response.status, payload);
      setResult(nextResult);
      if (nextResult.tone === 'success') {
        await onRecovered?.();
      }
    } catch (err: any) {
      setResult({
        tone: 'error',
        title: '无法连接恢复接口',
        detail: err?.message || String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-2xl border border-amber-700/60 bg-amber-950/20 p-4 space-y-4">
      <div className="flex items-start gap-3">
        <ShieldAlert className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
        <div>
          <h4 className="text-sm font-bold text-amber-100">提交结果待核实 · 已阻止新的 Veo 提交</h4>
          <p className="text-xs text-amber-200/70 leading-relaxed mt-1">
            服务器未能确认最初提交是否已被 Veo 接收。为避免重复扣费，本任务不能删除或重新生成。只有核实到属于本 taskId 的原 Provider Operation 后，才能恢复原任务轮询。
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-emerald-900/70 bg-emerald-950/20 p-3 space-y-2">
        <div className="text-xs font-semibold text-emerald-200">优先自动恢复 · 不需要 Operation Name</div>
        <div className="text-[11px] text-emerald-200/70 leading-relaxed">
          系统只读检查本次 Provider 尝试对应的 task 专属 GCS 前缀。只有找到唯一有效 MP4（或已写入的 canonical video.mp4）才会恢复；不会重新提交 Veo。
        </div>
        <button
          type="button"
          onClick={scanTaskGcs}
          disabled={scanningGcs || submitting}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-700 bg-emerald-950/60 px-4 py-2.5 text-sm font-semibold text-emerald-100 hover:bg-emerald-900/60 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {scanningGcs ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
          {scanningGcs ? '正在检查任务 GCS…' : '自动检查并找回原视频'}
        </button>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
          <ClipboardCheck className="w-4 h-4 text-violet-300" />
          粘贴已确认的完整 Operation Name
        </div>
        <input
          value={operationName}
          onChange={(event) => setOperationName(event.target.value)}
          placeholder="projects/.../locations/.../publishers/google/models/.../operations/..."
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-xs font-mono text-zinc-100 outline-none focus:border-violet-500"
        />
        <div className="text-[11px] text-zinc-500 leading-relaxed">
          当前任务：<span className="font-mono text-zinc-400">{taskId}</span>。系统会先查询 Provider，再用该任务专属 GCS 输出路径证明关联；仅“Operation 存在”不会解除锁定。
        </div>
      </div>

      <button
        type="button"
        onClick={recover}
        disabled={!looksValid || submitting}
        className="inline-flex items-center justify-center gap-2 rounded-xl border border-violet-700 bg-violet-950/60 px-4 py-2.5 text-sm font-semibold text-violet-100 hover:bg-violet-900/60 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
        {submitting ? '正在核实 Provider…' : '安全核实并恢复原任务'}
      </button>

      {result && (
        <div className={`rounded-xl border px-3 py-3 flex items-start gap-2 ${
          result.tone === 'success'
            ? 'border-emerald-800 bg-emerald-950/40 text-emerald-200'
            : result.tone === 'warning'
              ? 'border-amber-800 bg-amber-950/40 text-amber-200'
              : 'border-rose-800 bg-rose-950/40 text-rose-200'
        }`}>
          {result.tone === 'success'
            ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
          <div>
            <div className="text-xs font-bold">{result.title}</div>
            <div className="text-[11px] opacity-80 mt-1 leading-relaxed">{result.detail}</div>
          </div>
        </div>
      )}
    </section>
  );
};
