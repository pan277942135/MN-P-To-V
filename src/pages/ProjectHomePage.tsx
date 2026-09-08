import React, { useMemo, useState } from 'react';
import { ArrowRight, FolderOpen, Loader2, Plus, RefreshCw } from 'lucide-react';
import { useProjectSession } from '../context/ProjectSessionContext';
import { readProjectBindingHistory, type ProjectBindingHistoryEntry } from '../services/director/projectBindingHistory';

interface ProjectHomePageProps {
  onOpenProject: (projectId: string) => void;
}

function projectStatus(entry: ProjectBindingHistoryEntry, currentProjectId: string): string {
  return entry.projectId === currentProjectId ? '当前项目' : '制作中';
}

export const ProjectHomePage: React.FC<ProjectHomePageProps> = ({ onOpenProject }) => {
  const session = useProjectSession();
  const [history, setHistory] = useState<ProjectBindingHistoryEntry[]>(() => readProjectBindingHistory());
  const [restoring, setRestoring] = useState('');
  const [error, setError] = useState('');

  const projects = useMemo(() => {
    const entries = [...history];
    if (session.projectId && !entries.some((item) => item.projectId === session.projectId)) {
      entries.unshift({
        projectId: session.projectId,
        projectTitle: String(session.project?.projectTitle || session.project?.title || session.projectId),
        bindingCode: session.bindingCode,
        lastOpenedAt: Date.now(),
      });
    }
    return entries;
  }, [history, session.bindingCode, session.project, session.projectId]);

  const open = async (entry: ProjectBindingHistoryEntry) => {
    setError('');
    if (entry.projectId === session.projectId) {
      onOpenProject(entry.projectId);
      return;
    }
    if (!entry.bindingCode) {
      setError('该项目缺少绑定信息，无法安全恢复。');
      return;
    }
    setRestoring(entry.projectId);
    try {
      await session.restoreWithBinding(entry.bindingCode);
      setHistory(readProjectBindingHistory());
      onOpenProject(entry.projectId);
    } catch (cause: any) {
      setError(cause?.message || '项目恢复失败，请稍后重试。');
    } finally {
      setRestoring('');
    }
  };

  return (
    <section className="min-h-full px-5 py-8 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-indigo-300">Director Workspace</p>
            <h1 className="text-3xl font-semibold tracking-tight text-white">项目</h1>
            <p className="mt-2 text-sm text-zinc-400">先选择项目，再进入章节、镜头、素材和审核工作。</p>
          </div>
          <button
            type="button"
            onClick={() => setHistory(readProjectBindingHistory())}
            className="inline-flex items-center gap-2 self-start rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 transition hover:border-indigo-400/60 hover:text-white"
          >
            <RefreshCw size={15} /> 刷新项目列表
          </button>
        </div>

        {error && <div className="mb-5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}

        {projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/60 p-10 text-center">
            <FolderOpen className="mx-auto mb-4 text-zinc-500" size={34} />
            <h2 className="text-lg font-medium text-zinc-200">还没有可打开的项目</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-zinc-500">请先通过项目绑定入口恢复一个项目，恢复后项目会出现在这里。</p>
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((entry) => {
              const isCurrent = entry.projectId === session.projectId;
              const isRestoring = restoring === entry.projectId;
              const project = isCurrent ? session.project : null;
              const episode = isCurrent ? session.episode : null;
              return (
                <article key={entry.projectId} className="group overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/85 shadow-xl shadow-black/10 transition hover:-translate-y-0.5 hover:border-indigo-400/40">
                  <div className="flex h-36 items-end bg-gradient-to-br from-indigo-950 via-zinc-900 to-zinc-950 p-5">
                    <div className="flex w-full items-end justify-between gap-3">
                      <div>
                        <div className="mb-2 flex items-center gap-2 text-xs text-indigo-200"><FolderOpen size={14} /> 项目空间</div>
                        <h2 className="line-clamp-2 text-xl font-semibold text-white">{entry.projectTitle}</h2>
                      </div>
                      {isCurrent && <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] text-emerald-300">当前</span>}
                    </div>
                  </div>
                  <div className="space-y-4 p-5">
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-xl bg-zinc-800/70 p-3"><div className="text-lg font-semibold text-white">{isCurrent ? (episode ? 1 : 0) : '—'}</div><div className="text-[11px] text-zinc-500">Episodes</div></div>
                      <div className="rounded-xl bg-zinc-800/70 p-3"><div className="text-lg font-semibold text-white">{isCurrent ? session.shots.length : '—'}</div><div className="text-[11px] text-zinc-500">Shots</div></div>
                      <div className="rounded-xl bg-zinc-800/70 p-3"><div className="text-lg font-semibold text-white">{isCurrent ? session.assets.length : '—'}</div><div className="text-[11px] text-zinc-500">Assets</div></div>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-zinc-400">{projectStatus(entry, session.projectId)}</span>
                      <button type="button" onClick={() => void open(entry)} disabled={Boolean(restoring)} className="inline-flex items-center gap-2 font-medium text-indigo-300 transition hover:text-indigo-200 disabled:opacity-50">
                        {isRestoring ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />} 进入项目
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
            <div className="flex min-h-[300px] items-center justify-center rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/30 p-6 text-center">
              <div><Plus className="mx-auto mb-3 text-zinc-600" size={28} /><p className="text-sm text-zinc-500">新项目入口保留在项目绑定流程中</p></div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
