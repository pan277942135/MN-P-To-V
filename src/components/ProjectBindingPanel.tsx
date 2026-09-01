import React, { useEffect, useMemo, useState } from 'react';
import { Check, Cloud, Copy, KeyRound, Link2, Loader2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useDirectorCloud } from './DirectorCloudPersistenceProvider';
import { useProjectSession } from '../context/ProjectSessionContext';
import { createProjectBinding, type ProjectBindingRestoreResponse } from '../services/director/projectBindingClient';
import {
  clearProjectBindingHistory,
  readProjectBindingHistory,
  rememberProjectBinding,
  removeProjectBinding,
  type ProjectBindingHistoryEntry,
} from '../services/director/projectBindingHistory';

interface ProjectBindingPanelProps {
  onRestored?: (payload: ProjectBindingRestoreResponse) => void;
}

export const ProjectBindingPanel: React.FC<ProjectBindingPanelProps> = ({ onRestored }) => {
  const { record } = useDirectorCloud();
  const {
    projectId: sessionProjectId,
    project: sessionProject,
    shots: sessionShots,
    restoreWithBinding,
  } = useProjectSession();
  const [bindingCode, setBindingCode] = useState(() => readProjectBindingHistory()[0]?.bindingCode || '');
  const [createdCode, setCreatedCode] = useState('');
  const [restored, setRestored] = useState<ProjectBindingRestoreResponse | null>(null);
  const [history, setHistory] = useState<ProjectBindingHistoryEntry[]>(() => readProjectBindingHistory());
  const [busy, setBusy] = useState<'create' | 'restore' | ''>('');
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const current = record?.snapshot;
  const currentProjectId = sessionProjectId || current?.projectId?.trim() || '';
  const currentProjectTitle = String(sessionProject?.projectTitle || current?.projectTitle || '未命名项目');
  const currentShotCount = useMemo(() => {
    if (sessionShots.length) return sessionShots.length;
    const storyboard = current?.stages?.storyboard as { shots?: unknown[] } | undefined;
    return Array.isArray(storyboard?.shots) ? storyboard.shots.length : 0;
  }, [current, sessionShots.length]);

  useEffect(() => {
    if (!bindingCode && history[0]?.bindingCode) setBindingCode(history[0].bindingCode);
  }, [bindingCode, history]);

  const generateBinding = async () => {
    const projectId = currentProjectId;
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
      setHistory(rememberProjectBinding({
        bindingCode: result.bindingCode,
        projectId,
        projectTitle: currentProjectTitle,
      }));
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

  const restore = async (bindingCodeInput = bindingCode) => {
    const code = bindingCodeInput.trim();
    if (!code) {
      setError('请输入项目绑定码。');
      setMessage('');
      return;
    }
    setBusy('restore');
    setError('');
    setMessage('');
    try {
      const result = await restoreWithBinding(code);
      const payload = result.payload;
      setHistory(readProjectBindingHistory());
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

  const selectHistory = (entry: ProjectBindingHistoryEntry) => {
    setHistory(rememberProjectBinding(entry));
    setBindingCode(entry.bindingCode);
    setMessage(entry.projectTitle + ' 的绑定码已填入。');
    setError('');
  };

  const deleteHistory = (entry: ProjectBindingHistoryEntry) => {
    setHistory(removeProjectBinding(entry.bindingCode));
    if (bindingCode.toUpperCase() === entry.bindingCode.toUpperCase()) setBindingCode('');
  };

  const clearHistory = () => {
    clearProjectBindingHistory();
    setHistory([]);
    setBindingCode('');
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
          {history.length > 0 && (
            <div className="mt-4 rounded-xl border border-[#303044] bg-[#0B0B12] p-3" data-testid="project-binding-history">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="recent-project-binding" className="text-[11px] font-bold uppercase tracking-wider text-slate-500">最近项目</label>
                <button type="button" onClick={clearHistory} className="text-[11px] font-bold text-slate-500 hover:text-rose-300">清空历史</button>
              </div>
              <select
                id="recent-project-binding"
                value={history.some((entry) => entry.bindingCode === bindingCode) ? bindingCode : ''}
                onChange={(event) => {
                  const entry = history.find((item) => item.bindingCode === event.target.value);
                  if (entry) selectHistory(entry);
                }}
                className="mt-2 w-full rounded-xl border border-[#3A3A50] bg-[#09090F] px-3 py-2.5 text-sm text-white outline-none focus:border-indigo-400/70"
              >
                <option value="">选择最近项目…</option>
                {history.map((entry) => (
                  <option key={entry.bindingCode} value={entry.bindingCode}>
                    {entry.projectTitle} · {new Date(entry.lastOpenedAt).toLocaleDateString('zh-CN')}
                  </option>
                ))}
              </select>
              <div className="mt-2 space-y-1">
                {history.slice(0, 3).map((entry) => (
                  <div key={entry.bindingCode} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-white/[0.03]">
                    <button type="button" onClick={() => selectHistory(entry)} className="min-w-0 flex-1 truncate text-left font-bold text-indigo-100 hover:text-white">{entry.projectTitle}</button>
                    <span className="shrink-0 text-[10px] text-slate-600">{new Date(entry.lastOpenedAt).toLocaleDateString('zh-CN')}</span>
                    <button type="button" onClick={() => void restore(entry.bindingCode)} disabled={busy !== ''} className="shrink-0 rounded-lg border border-emerald-400/20 px-2 py-1 text-[10px] font-black text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40">打开</button>
                    <button type="button" aria-label={'删除 ' + entry.projectTitle + ' 绑定历史'} onClick={() => deleteHistory(entry)} className="rounded p-1 text-slate-600 hover:bg-rose-500/10 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
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
