import React, { useMemo, useState } from 'react';
import { Check, Cloud, Copy, KeyRound, Link2, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useDirectorCloud } from './DirectorCloudPersistenceProvider';
import {
  createProjectBinding,
  restoreProjectByBinding,
  type ProjectBindingRestoreResponse,
} from '../services/director/projectBindingClient';
import type { DirectorCloudRecord } from '../services/director/directorCloudPersistence';

interface ProjectBindingPanelProps {
  onRestored?: (payload: ProjectBindingRestoreResponse) => void;
}

function restoredCloudRecord(payload: ProjectBindingRestoreResponse): DirectorCloudRecord {
  return {
    snapshot: {
      schema: 'zaojing.director.cloud.v1',
      projectId: payload.project.projectId,
      episodeId: payload.episode.episodeId,
      seriesTitle: payload.project.seriesTitle,
      projectTitle: payload.project.projectTitle,
      clientUpdatedAt: Number(payload.episode.clientUpdatedAt || 0),
      stages: payload.stages,
      ...(payload.project.formatPolicy ? { formatPolicy: payload.project.formatPolicy } : {}),
    },
    serverUpdatedAt: payload.serverUpdatedAt,
  };
}

export const ProjectBindingPanel: React.FC<ProjectBindingPanelProps> = ({ onRestored }) => {
  const { record, setRecord } = useDirectorCloud();
  const [bindingCode, setBindingCode] = useState('');
  const [createdCode, setCreatedCode] = useState('');
  const [restored, setRestored] = useState<ProjectBindingRestoreResponse | null>(null);
  const [busy, setBusy] = useState<'create' | 'restore' | ''>('');
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const current = record?.snapshot;
  const currentShotCount = useMemo(() => {
    const storyboard = current?.stages?.storyboard as { shots?: unknown[] } | undefined;
    return Array.isArray(storyboard?.shots) ? storyboard.shots.length : 0;
  }, [current]);

  const generateBinding = async () => {
    const projectId = current?.projectId?.trim() || '';
    if (!projectId) {
      setError('当前项目尚未同步到 Director Cloud，请先保存项目或等待云端同步完成。');
      setMessage('');
      return;
    }
    setBusy('create');
    setError('');
    setMessage('');
    try {
      const result = await createProjectBinding(projectId);
      setCreatedCode(result.bindingCode);
      setCopied(false);
      setMessage('项目绑定码已生成。请将它输入到另一台设备的“恢复已有项目”入口。');
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setBusy('');
    }
  };

  const copyBinding = async () => {
    if (!createdCode) return;
    try {
      await navigator.clipboard.writeText(createdCode);
      setCopied(true);
      setMessage('绑定码已复制。');
    } catch {
      setCopied(false);
      setError('当前浏览器不允许自动复制，请手动选择绑定码复制。');
    }
  };

  const restore = async () => {
    const code = bindingCode.trim();
    if (!code) {
      setError('请输入项目绑定码。');
      setMessage('');
      return;
    }
    setBusy('restore');
    setError('');
    setMessage('');
    try {
      const payload = await restoreProjectByBinding(code);
      setRecord(restoredCloudRecord(payload));
      setRestored(payload);
      setBindingCode('');
      onRestored?.(payload);
      setMessage(`已恢复 ${payload.project.projectTitle || '项目'} · ${payload.episode.episodeId}，${payload.shots.length} 个 Shot。`);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="space-y-5 rounded-2xl border border-indigo-500/25 bg-indigo-500/5 p-5 sm:p-6" data-testid="project-binding-panel">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex gap-3">
          <div className="rounded-xl border border-indigo-400/30 bg-indigo-500/15 p-2.5 text-indigo-200"><Link2 className="h-5 w-5" /></div>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-300">Project Identity Layer · Step 4.0.1-C</div>
            <h2 className="mt-1 text-xl font-black text-white">Project Restore</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-indigo-100/70">项目、Episode、Shot、分镜、关键帧、视频蓝图和生产状态均从 Firestore / GCS 恢复；绑定码不是 Firestore 项目 ID。</p>
          </div>
        </div>
        <div className="inline-flex items-center gap-1.5 self-start rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-bold text-emerald-300"><ShieldCheck className="h-3.5 w-3.5" /> Firestore + GCS</div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-[#303044] bg-[#11111A] p-4">
          <div className="flex items-center gap-2 text-sm font-black text-white"><Cloud className="h-4 w-4 text-sky-300" /> 当前项目</div>
          {current ? (
            <>
              <div className="mt-3 text-base font-bold text-indigo-100">{current.projectTitle || '未命名项目'}</div>
              <div className="mt-1 text-xs text-slate-400">{current.episodeId} · {currentShotCount} 个 Shot</div>
              <button type="button" onClick={generateBinding} disabled={busy !== ''} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50">
                {busy === 'create' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                生成项目绑定码
              </button>
              {createdCode && (
                <div className="mt-4 rounded-xl border border-indigo-400/30 bg-indigo-500/10 p-3">
                  <div className="text-[11px] font-bold text-indigo-200/70">Project Binding Code</div>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all text-xl font-black tracking-[0.12em] text-white">{createdCode}</code>
                    <button type="button" aria-label="复制项目绑定码" onClick={copyBinding} className="rounded-lg border border-indigo-300/30 p-2 text-indigo-200 hover:bg-indigo-500/15">{copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}</button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-amber-100/75">当前没有已同步的 Director 项目。先完成项目保存，云端状态就绪后即可生成绑定码。</div>
          )}
        </div>

        <div className="rounded-xl border border-[#303044] bg-[#11111A] p-4">
          <div className="flex items-center gap-2 text-sm font-black text-white"><RefreshCw className="h-4 w-4 text-emerald-300" /> 新设备</div>
          <p className="mt-1 text-xs leading-5 text-slate-400">在电脑 B、手机或新浏览器输入电脑 A 生成的绑定码。</p>
          <label htmlFor="project-binding-code" className="mt-4 block text-[11px] font-bold uppercase tracking-wider text-slate-500">Binding Code</label>
          <input id="project-binding-code" value={bindingCode} onChange={(event) => setBindingCode(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void restore(); }} placeholder="ZJ-Ab7K-x2M8" autoComplete="off" spellCheck={false} className="mt-1.5 w-full rounded-xl border border-[#3A3A50] bg-[#09090F] px-3 py-3 font-mono text-sm tracking-[0.08em] text-white outline-none focus:border-indigo-400/70" />
          <button type="button" onClick={restore} disabled={busy !== ''} className="mt-3 inline-flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/15 px-4 py-2.5 text-sm font-black text-emerald-100 disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'restore' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            恢复已有项目
          </button>
        </div>
      </div>

      {(message || error) && <div className={`rounded-xl border px-4 py-3 text-sm ${error ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'}`}>{error || message}</div>}

      {restored && (
        <div className="grid gap-2 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 text-xs text-sky-100/80 sm:grid-cols-2 lg:grid-cols-4">
          <div><span className="text-slate-500">项目</span><div className="mt-1 font-bold text-white">{restored.project.projectTitle}</div></div>
          <div><span className="text-slate-500">Episode</span><div className="mt-1 font-bold text-white">{restored.episode.episodeId}</div></div>
          <div><span className="text-slate-500">Shot List</span><div className="mt-1 font-bold text-white">{restored.shots.length} 个</div></div>
          <div><span className="text-slate-500">Image Assets</span><div className="mt-1 font-bold text-white">{restored.assets.length} 个</div></div>
        </div>
      )}
    </section>
  );
};
