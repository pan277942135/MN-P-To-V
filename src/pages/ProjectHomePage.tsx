import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, FolderOpen, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import {
  createDirectorProject,
  getDirectorProjects,
  type DirectorProjectListItem,
} from '../services/director/projectClient';

interface ProjectHomePageProps {
  onOpenProject: (projectId: string) => void;
}

function formatDate(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'medium' });
}

export const ProjectHomePage: React.FC<ProjectHomePageProps> = ({ onOpenProject }) => {
  const [projects, setProjects] = useState<DirectorProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ projectTitle: '', description: '', defaultAspectRatio: '16:9' });

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setProjects(await getDirectorProjects());
    } catch (cause: any) {
      setError(cause?.message || '项目列表加载失败，请重试。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.projectTitle.trim()) return;
    setCreating(true);
    setError('');
    try {
      await createDirectorProject({
        projectTitle: draft.projectTitle.trim(),
        description: draft.description.trim(),
        defaultAspectRatio: draft.defaultAspectRatio,
      });
      setDraft({ projectTitle: '', description: '', defaultAspectRatio: '16:9' });
      setCreateOpen(false);
      await loadProjects();
    } catch (cause: any) {
      setError(cause?.message || '项目创建失败，请重试。');
    } finally {
      setCreating(false);
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
          <div className="flex gap-3">
            <button type="button" onClick={() => void loadProjects()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 hover:border-indigo-400/60 disabled:opacity-50">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> 刷新
            </button>
            <button type="button" onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-2 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400">
              <Plus size={16} /> 创建项目
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-5 flex items-start justify-between gap-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            <span>{error}</span>
            <button type="button" onClick={() => void loadProjects()} className="shrink-0 underline">重试</button>
          </div>
        )}

        {loading ? (
          <div className="flex min-h-[280px] items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/60 text-sm text-zinc-400">
            <Loader2 className="mr-2 animate-spin" size={18} /> 正在加载项目列表…
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/60 p-10 text-center">
            <FolderOpen className="mx-auto mb-4 text-zinc-500" size={34} />
            <h2 className="text-lg font-medium text-zinc-200">暂无项目</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-zinc-500">请创建项目后进入项目工作空间。</p>
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <article key={project.projectId} className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/85 shadow-xl shadow-black/10 transition hover:-translate-y-0.5 hover:border-indigo-400/40">
                <div className="flex h-36 items-end bg-gradient-to-br from-indigo-950 via-zinc-900 to-zinc-950 p-5">
                  <div className="flex w-full items-end justify-between gap-3">
                    <div>
                      <div className="mb-2 flex items-center gap-2 text-xs text-indigo-200"><FolderOpen size={14} /> 项目空间</div>
                      <h2 className="line-clamp-2 text-xl font-semibold text-white">{project.projectTitle}</h2>
                    </div>
                    <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] text-emerald-300">{project.status}</span>
                  </div>
                </div>
                <div className="space-y-4 p-5">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-xl bg-zinc-800/70 p-3"><div className="text-lg font-semibold text-white">{project.episodeCount}</div><div className="text-[11px] text-zinc-500">Episodes</div></div>
                    <div className="rounded-xl bg-zinc-800/70 p-3"><div className="text-lg font-semibold text-white">{project.shotCount}</div><div className="text-[11px] text-zinc-500">Shots</div></div>
                    <div className="rounded-xl bg-zinc-800/70 p-3"><div className="text-lg font-semibold text-white">{project.assetCount}</div><div className="text-[11px] text-zinc-500">Assets</div></div>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-zinc-500">更新于 {formatDate(project.updatedAt)}</span>
                    <button type="button" onClick={() => onOpenProject(project.projectId)} className="inline-flex items-center gap-2 font-medium text-indigo-300 hover:text-indigo-200">
                      <ArrowRight size={15} /> 进入项目
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {createOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 px-4" role="dialog" aria-modal="true" aria-label="创建项目">
          <form onSubmit={submitCreate} className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-white">创建项目</h2>
              <button type="button" onClick={() => setCreateOpen(false)} className="text-zinc-400 hover:text-white"><X size={18} /></button>
            </div>
            <label className="mt-5 block text-sm text-zinc-300">项目名称<input required value={draft.projectTitle} onChange={(event) => setDraft({ ...draft, projectTitle: event.target.value })} className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none focus:border-indigo-400" /></label>
            <label className="mt-4 block text-sm text-zinc-300">项目描述<textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className="mt-2 min-h-24 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none focus:border-indigo-400" /></label>
            <label className="mt-4 block text-sm text-zinc-300">默认画幅<select value={draft.defaultAspectRatio} onChange={(event) => setDraft({ ...draft, defaultAspectRatio: event.target.value })} className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none focus:border-indigo-400"><option>16:9</option><option>9:16</option><option>1:1</option></select></label>
            <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setCreateOpen(false)} className="rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300">取消</button><button type="submit" disabled={creating} className="inline-flex items-center gap-2 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{creating && <Loader2 size={15} className="animate-spin" />}创建</button></div>
          </form>
        </div>
      )}
    </section>
  );
};
