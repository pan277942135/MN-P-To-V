import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  ListOrdered,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import type { GeneratedStoryboardShot } from '../services/director/localStoryboardGenerator';
import {
  readCurrentStoryboard,
  saveStoryboardAndSync,
  type StoryboardDraftForWorkflow,
} from '../services/director/shotProductionWorkflow';
import {
  insertStoryboardShot,
  moveStoryboardShotBy,
  moveStoryboardShotToOrder,
} from '../services/director/storyboardShotOrder';
import {
  LEGACY_FORMAT_POLICY,
  hasFormatPolicy,
  normalizeFormatPolicy,
  SUPPORTED_ASPECT_RATIOS,
  type AspectRatio,
  type ProductionFormatPolicy,
} from '../services/formatPolicy/formatPolicy';
import { DIRECTOR_DRAFT_KEY } from '../services/director/keyframeBlueprint';
import { useProjectSession } from '../context/ProjectSessionContext';

function createShot(): GeneratedStoryboardShot {
  return {
    uid: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: '',
    durationSeconds: 4,
    scene: '',
    action: '',
    camera: '',
    dialogue: '',
    notes: '',
  };
}

function label(index: number) {
  return `S${String(index + 1).padStart(2, '0')}`;
}

function emptyStoryboard(): StoryboardDraftForWorkflow {
  return { version: 'manual-storyboard-v0.2', shots: [] };
}

function readFormatPolicy(): ProductionFormatPolicy {
  try {
    const raw = window.localStorage.getItem(DIRECTOR_DRAFT_KEY);
    const draft = raw ? JSON.parse(raw) as { formatPolicy?: unknown } : {};
    return normalizeFormatPolicy(
      hasFormatPolicy(draft.formatPolicy) ? draft.formatPolicy : undefined,
      LEGACY_FORMAT_POLICY,
    );
  } catch {
    return LEGACY_FORMAT_POLICY;
  }
}

export const ShotListPage: React.FC = () => {
  const { projectId: sessionProjectId, episodeId: sessionEpisodeId } = useProjectSession();
  const initial = useMemo(() => readCurrentStoryboard() || emptyStoryboard(), [sessionEpisodeId, sessionProjectId]);
  const formatPolicy = useMemo(() => readFormatPolicy(), []);
  const [storyboard, setStoryboard] = useState<StoryboardDraftForWorkflow>(initial);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!sessionProjectId) return;
    setStoryboard(readCurrentStoryboard() || emptyStoryboard());
  }, [sessionEpisodeId, sessionProjectId]);

  const totalDuration = storyboard.shots.reduce(
    (sum, shot) => sum + Math.max(1, Number(shot.durationSeconds || 1)),
    0,
  );

  const commit = (next: StoryboardDraftForWorkflow, feedback: string) => {
    try {
      const synced = saveStoryboardAndSync(next);
      setStoryboard(synced.storyboard);
      setError('');
      const invalidated = synced.invalidatedKeyframeShotUids.length;
      setMessage(invalidated > 0
        ? `${feedback}；${invalidated} 个受影响 Shot 的关键帧人工 PASS 已自动撤销，请重新人工复核。`
        : feedback);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
      setMessage('');
    }
  };

  const updateShot = <K extends keyof GeneratedStoryboardShot>(
    uid: string,
    key: K,
    value: GeneratedStoryboardShot[K],
  ) => {
    setStoryboard((current) => ({
      ...current,
      shots: current.shots.map((shot) => shot.uid === uid ? { ...shot, [key]: value } : shot),
    }));
    setMessage('');
    setError('');
  };

  const handleSave = () => {
    if (!storyboard.shots.length) {
      setError('当前没有 Shot。');
      return;
    }
    commit(storyboard, `Shot List 已保存：${storyboard.shots.length} 镜，共 ${totalDuration}s`);
  };

  const insertAt = (anchorUid: string, position: 'before' | 'after') => {
    const newShot = createShot();
    const next = {
      ...storyboard,
      shots: insertStoryboardShot(storyboard.shots, anchorUid, position, newShot),
    };
    commit(next, `已在当前镜头${position === 'before' ? '前' : '后'}插入新 Shot`);
  };

  const moveBy = (uid: string, delta: -1 | 1) => {
    const next = { ...storyboard, shots: moveStoryboardShotBy(storyboard.shots, uid, delta) };
    commit(next, 'Shot order 已调整');
  };

  const moveTo = (uid: string, order: number) => {
    const next = { ...storyboard, shots: moveStoryboardShotToOrder(storyboard.shots, uid, order) };
    commit(next, `Shot 已移动到第 ${Math.max(1, Math.min(storyboard.shots.length, Math.round(order || 1)))} 位`);
  };

  const removeShot = (uid: string) => {
    const target = storyboard.shots.find((shot) => shot.uid === uid);
    if (!target) return;
    if (!window.confirm(`确认删除“${target.title || uid}”？该 Shot 的下游生产记录将从当前 Episode 中移除。`)) return;
    const next = { ...storyboard, shots: storyboard.shots.filter((shot) => shot.uid !== uid) };
    commit(next, 'Shot 已删除并重新编号');
  };

  if (!storyboard.shots.length) {
    return (
      <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-purple-400"><ListOrdered className="h-4 w-4" /> Shot Workspace</div>
          <h1 className="text-2xl font-black text-white sm:text-3xl">Shot List｜编排 / 插入 / 调整 Order</h1>
        </header>
        <section className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-6 text-sm text-amber-100/80">请先在“导演台”生成或导入 Storyboard。之后可随时回到这里调整 Shot，不要求按阶段线性推进。</section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-purple-400"><ListOrdered className="h-4 w-4" /> Shot Workspace</div>
          <h1 className="text-2xl font-black text-white sm:text-3xl">Shot List｜编排 / 插入 / 调整 Order</h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">Shot 是生产主键。S01 / S02 只是当前显示顺序；插入、删除、移动不会改变已有 Shot 的稳定 uid。剧情、关键帧和视频都可以在制作中持续调整。</p>
        </div>
        <div className="flex gap-2">
          <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-300">{storyboard.shots.length} SHOTS</span>
          <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-xs font-bold text-violet-300">{totalDuration}s</span>
        </div>
      </header>

      <section className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4 text-xs leading-5 text-sky-100/75">
        调整规则：已有 Shot 依靠 <span className="font-mono">shot.uid</span> 继续绑定关键帧和视频；新插入 Shot 新建一条生产链。若 order 改变导致某 Shot 的“上一镜”变化，该 Shot 的关键帧人工 PASS 会撤销，提醒你重新检查连续性；其他不受影响的 Shot 继续保持当前生产状态。
      </section>

      {message && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}
      {error && <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      <section className="space-y-4">
        {storyboard.shots.map((shot, index) => {
          const shotLabel = label(index);
          return (
            <article key={shot.uid} className="space-y-4 rounded-2xl border border-[#2D2D33] bg-[#111114] p-4 sm:p-5">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-10 min-w-16 items-center justify-center rounded-lg border border-purple-500/30 bg-purple-500/10 px-2 font-mono text-sm font-black text-purple-300">{shotLabel}</span>
                  <div className="text-[10px] font-mono text-slate-600">uid: {shot.uid}</div>
                </div>
                <input value={shot.title} onChange={(event) => updateShot(shot.uid, 'title', event.target.value)} aria-label={`${shotLabel} 标题`} placeholder="镜头标题" className="min-w-0 flex-1 rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm font-bold text-white" />
                <div className="flex flex-wrap items-center gap-1.5">
                  <button onClick={() => insertAt(shot.uid, 'before')} className="inline-flex items-center gap-1 rounded-lg border border-sky-500/25 bg-sky-500/10 px-2.5 py-2 text-xs font-bold text-sky-200"><Plus className="h-3.5 w-3.5" /> 前插</button>
                  <button onClick={() => insertAt(shot.uid, 'after')} className="inline-flex items-center gap-1 rounded-lg border border-sky-500/25 bg-sky-500/10 px-2.5 py-2 text-xs font-bold text-sky-200"><Plus className="h-3.5 w-3.5" /> 后插</button>
                  <button aria-label={`${shotLabel} 上移`} disabled={index === 0} onClick={() => moveBy(shot.uid, -1)} className="rounded-lg border border-[#34343A] p-2 text-slate-400 disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
                  <button aria-label={`${shotLabel} 下移`} disabled={index === storyboard.shots.length - 1} onClick={() => moveBy(shot.uid, 1)} className="rounded-lg border border-[#34343A] p-2 text-slate-400 disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
                  <div className="flex items-center rounded-lg border border-[#34343A] bg-[#09090B] px-2">
                    <span className="text-[10px] text-slate-500">ORDER</span>
                    <input type="number" min={1} max={storyboard.shots.length} defaultValue={index + 1} key={`${shot.uid}-${index}`} onBlur={(event) => moveTo(shot.uid, Number(event.target.value || index + 1))} className="w-12 bg-transparent px-1 py-2 text-center text-xs font-bold text-white outline-none" />
                  </div>
                  <button aria-label={`${shotLabel} 删除`} onClick={() => removeShot(shot.uid)} className="rounded-lg border border-rose-500/20 p-2 text-rose-400"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-[130px_1fr_1fr_170px]">
                <div><label className="mb-1 block text-[11px] font-bold text-slate-500">时长</label><input type="number" min={1} max={60} value={shot.durationSeconds} onChange={(event) => updateShot(shot.uid, 'durationSeconds', Math.max(1, Number(event.target.value || 1)))} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" /></div>
                <div><label className="mb-1 block text-[11px] font-bold text-slate-500">场景</label><input value={shot.scene} onChange={(event) => updateShot(shot.uid, 'scene', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" /></div>
                <div><label className="mb-1 block text-[11px] font-bold text-slate-500">镜头语言</label><input value={shot.camera} onChange={(event) => updateShot(shot.uid, 'camera', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" /></div>
                <div>
                  <label htmlFor={`${shot.uid}-aspect-ratio`} className="mb-1 block text-[11px] font-bold text-slate-500">画幅覆盖</label>
                  <select
                    id={`${shot.uid}-aspect-ratio`}
                    aria-label={`${shotLabel} 画幅覆盖`}
                    value={shot.formatPolicy?.aspectRatio || ''}
                    disabled={!formatPolicy.allowShotOverride}
                    onChange={(event) => updateShot(
                      shot.uid,
                      'formatPolicy',
                      event.target.value ? { aspectRatio: event.target.value as AspectRatio } : undefined,
                    )}
                    className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="">继承项目策略</option>
                    {SUPPORTED_ASPECT_RATIOS.filter((aspectRatio) => formatPolicy.allowedAspectRatios.includes(aspectRatio)).map((aspectRatio) => (
                      <option key={aspectRatio} value={aspectRatio}>{aspectRatio}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <div><label className="mb-1 block text-[11px] font-bold text-slate-500">画面 / 动作</label><textarea rows={3} value={shot.action} onChange={(event) => updateShot(shot.uid, 'action', event.target.value)} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" /></div>
                <div><label className="mb-1 block text-[11px] font-bold text-slate-500">对白 / 旁白</label><textarea rows={3} value={shot.dialogue} onChange={(event) => updateShot(shot.uid, 'dialogue', event.target.value)} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" /></div>
              </div>
              <div><label className="mb-1 block text-[11px] font-bold text-slate-500">连续性 / 生产备注</label><input value={shot.notes} onChange={(event) => updateShot(shot.uid, 'notes', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" /></div>
            </article>
          );
        })}
      </section>

      <div className="sticky bottom-4 flex justify-end">
        <button onClick={handleSave} className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-3 text-sm font-black text-white shadow-xl hover:bg-purple-500"><Save className="h-4 w-4" /> 保存 Shot List</button>
      </div>
    </div>
  );
};
