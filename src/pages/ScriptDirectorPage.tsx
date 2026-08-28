import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Clock3,
  FileText,
  LockKeyhole,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

const DRAFT_KEY = 'zaojing_director_v01_brief';
const STORYBOARD_KEY = 'zaojing_director_v02_storyboard';

export interface DirectorBriefDraft {
  version: 'director-brief-v0.1';
  title: string;
  sourceType: 'idea' | 'outline' | 'script';
  targetFormat: 'story_short' | 'vlog' | 'cosplay' | 'other';
  targetDurationSeconds: number;
  aspectRatio: '9:16';
  creativeBrief: string;
  fullScript: string;
  productionNotes: string;
  savedAt?: number;
}

export interface ManualShotDraft {
  uid: string;
  title: string;
  durationSeconds: number;
  scene: string;
  action: string;
  camera: string;
  dialogue: string;
  notes: string;
}

export interface ManualStoryboardDraft {
  version: 'manual-storyboard-v0.2';
  shots: ManualShotDraft[];
  savedAt?: number;
}

const EMPTY_DRAFT: DirectorBriefDraft = {
  version: 'director-brief-v0.1',
  title: '',
  sourceType: 'idea',
  targetFormat: 'story_short',
  targetDurationSeconds: 30,
  aspectRatio: '9:16',
  creativeBrief: '',
  fullScript: '',
  productionNotes: '',
};

const EMPTY_STORYBOARD: ManualStoryboardDraft = {
  version: 'manual-storyboard-v0.2',
  shots: [],
};

function createShot(): ManualShotDraft {
  return {
    uid: `shot-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    title: '',
    durationSeconds: 4,
    scene: '',
    action: '',
    camera: '',
    dialogue: '',
    notes: '',
  };
}

function readSavedDraft(): DirectorBriefDraft {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<DirectorBriefDraft>;
    return {
      ...EMPTY_DRAFT,
      ...parsed,
      version: 'director-brief-v0.1',
      aspectRatio: '9:16',
      targetDurationSeconds: Math.max(4, Number(parsed.targetDurationSeconds || 30)),
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

function readSavedStoryboard(): ManualStoryboardDraft {
  try {
    const raw = window.localStorage.getItem(STORYBOARD_KEY);
    if (!raw) return EMPTY_STORYBOARD;
    const parsed = JSON.parse(raw) as Partial<ManualStoryboardDraft>;
    const shots = Array.isArray(parsed.shots)
      ? parsed.shots.map((shot, index) => ({
          ...createShot(),
          ...shot,
          uid: typeof shot?.uid === 'string' && shot.uid ? shot.uid : `restored-${index}-${Date.now()}`,
          durationSeconds: Math.max(1, Number(shot?.durationSeconds || 4)),
        }))
      : [];
    return {
      version: 'manual-storyboard-v0.2',
      shots,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : undefined,
    };
  } catch {
    return EMPTY_STORYBOARD;
  }
}

function formatSavedAt(value?: number) {
  if (!value) return '尚未保存';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function shotLabel(index: number) {
  return `S${String(index + 1).padStart(2, '0')}`;
}

export const ScriptDirectorPage: React.FC = () => {
  const [draft, setDraft] = useState<DirectorBriefDraft>(() => readSavedDraft());
  const [storyboard, setStoryboard] = useState<ManualStoryboardDraft>(() => readSavedStoryboard());
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const hasContent = useMemo(
    () => Boolean(draft.creativeBrief.trim() || draft.fullScript.trim()),
    [draft.creativeBrief, draft.fullScript],
  );

  const totalShotDuration = useMemo(
    () => storyboard.shots.reduce((sum, shot) => sum + Math.max(1, Number(shot.durationSeconds || 1)), 0),
    [storyboard.shots],
  );

  const durationDelta = totalShotDuration - draft.targetDurationSeconds;

  const clearFeedback = () => {
    setMessage('');
    setError('');
  };

  const update = <K extends keyof DirectorBriefDraft>(key: K, value: DirectorBriefDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    clearFeedback();
  };

  const updateShot = <K extends keyof ManualShotDraft>(uid: string, key: K, value: ManualShotDraft[K]) => {
    setStoryboard((current) => ({
      ...current,
      shots: current.shots.map((shot) => (shot.uid === uid ? { ...shot, [key]: value } : shot)),
    }));
    clearFeedback();
  };

  const saveDraft = () => {
    if (!draft.title.trim()) {
      setError('请先填写项目标题。');
      return;
    }
    if (!hasContent) {
      setError('创意描述或完整脚本至少填写一项。');
      return;
    }
    const next: DirectorBriefDraft = {
      ...draft,
      title: draft.title.trim(),
      creativeBrief: draft.creativeBrief.trim(),
      fullScript: draft.fullScript.trim(),
      productionNotes: draft.productionNotes.trim(),
      savedAt: Date.now(),
    };
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    setDraft(next);
    setError('');
    setMessage('Step 1 草稿已保存；可继续进行人工分镜。');
  };

  const addShot = () => {
    setStoryboard((current) => ({ ...current, shots: [...current.shots, createShot()] }));
    clearFeedback();
  };

  const deleteShot = (uid: string) => {
    setStoryboard((current) => ({ ...current, shots: current.shots.filter((shot) => shot.uid !== uid) }));
    clearFeedback();
  };

  const moveShot = (index: number, delta: -1 | 1) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= storyboard.shots.length) return;
    setStoryboard((current) => {
      const next = [...current.shots];
      const [moved] = next.splice(index, 1);
      next.splice(targetIndex, 0, moved);
      return { ...current, shots: next };
    });
    clearFeedback();
  };

  const saveStoryboard = () => {
    if (storyboard.shots.length === 0) {
      setError('请至少新增一个镜头后再保存分镜。');
      return;
    }

    const normalizedShots = storyboard.shots.map((shot) => ({
      ...shot,
      title: shot.title.trim(),
      durationSeconds: Math.max(1, Math.min(60, Number(shot.durationSeconds || 1))),
      scene: shot.scene.trim(),
      action: shot.action.trim(),
      camera: shot.camera.trim(),
      dialogue: shot.dialogue.trim(),
      notes: shot.notes.trim(),
    }));

    const next: ManualStoryboardDraft = {
      version: 'manual-storyboard-v0.2',
      shots: normalizedShots,
      savedAt: Date.now(),
    };
    window.localStorage.setItem(STORYBOARD_KEY, JSON.stringify(next));
    setStoryboard(next);
    setError('');
    setMessage(`Step 2 分镜已保存：${next.shots.length} 个镜头，共 ${next.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)} 秒。`);
  };

  const resetDraft = () => {
    if ((draft.title || hasContent || storyboard.shots.length > 0) && !window.confirm('确认新建空白项目？当前浏览器中的脚本与人工分镜都会被清空。')) {
      return;
    }
    window.localStorage.removeItem(DRAFT_KEY);
    window.localStorage.removeItem(STORYBOARD_KEY);
    setDraft(EMPTY_DRAFT);
    setStoryboard(EMPTY_STORYBOARD);
    setMessage('已新建空白项目。');
    setError('');
  };

  return (
    <div className="mx-auto max-w-[1380px] px-4 py-6 sm:px-6 lg:px-8 space-y-6">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-purple-400">
            <Clapperboard className="h-4 w-4" />
            Director Console · Step 2 / Manual MVP
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">导演台｜人工分镜拆解</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
            Step 1 已通过验收。本环节只把已录入的创意/脚本手工拆成可编辑 Shot List，并验证新增、编辑、删除、排序、保存与刷新恢复。当前不做 AI 自动拆镜，不生成图片，不调用 Veo。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300">STEP 1 · 已验收</span>
          <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs font-bold text-purple-300">STEP 2 · 待验收</span>
          <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-bold text-zinc-300">NO PROVIDER CALLS</span>
        </div>
      </header>

      <section className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4 sm:p-5">
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" />
          <div>
            <div className="text-sm font-bold text-sky-100">Step 2 验收边界</div>
            <p className="mt-1 text-xs leading-5 text-sky-100/70">
              分镜仍只保存在当前浏览器 localStorage。Shot 编号按当前顺序自动显示为 S01、S02…；排序后编号自动重排。这个阶段不创建 Firestore Episode / Shot，也没有任何 AI、图片或视频 Provider 调用。
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-[#27272A] bg-[#111114] p-5 sm:p-6 space-y-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-emerald-400">STEP 1 · ACCEPTED</div>
            <h2 className="mt-1 text-lg font-black text-white">创意 / 脚本基础信息</h2>
          </div>
          <div className="text-xs text-slate-500">最后保存：<span className="font-mono text-slate-300">{formatSavedAt(draft.savedAt)}</span></div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="director-title" className="mb-2 block text-xs font-bold text-slate-300">项目标题 *</label>
            <input
              id="director-title"
              value={draft.title}
              onChange={(event) => update('title', event.target.value)}
              placeholder="例如：押金扣光的第七天，我在出租屋手搓法杖"
              className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none transition focus:border-purple-500/70"
            />
          </div>
          <div>
            <label htmlFor="director-source-type" className="mb-2 block text-xs font-bold text-slate-300">当前输入成熟度</label>
            <select
              id="director-source-type"
              value={draft.sourceType}
              onChange={(event) => update('sourceType', event.target.value as DirectorBriefDraft['sourceType'])}
              className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70"
            >
              <option value="idea">一句创意 / 核心想法</option>
              <option value="outline">故事梗概 / 大纲</option>
              <option value="script">已有完整脚本</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label htmlFor="director-format" className="mb-2 block text-xs font-bold text-slate-300">目标内容形式</label>
            <select
              id="director-format"
              value={draft.targetFormat}
              onChange={(event) => update('targetFormat', event.target.value as DirectorBriefDraft['targetFormat'])}
              className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70"
            >
              <option value="story_short">剧情短视频</option>
              <option value="vlog">Vlog</option>
              <option value="cosplay">AI Cosplay</option>
              <option value="other">其他</option>
            </select>
          </div>
          <div>
            <label htmlFor="director-duration" className="mb-2 block text-xs font-bold text-slate-300">目标总时长（秒）</label>
            <input
              id="director-duration"
              type="number"
              min={4}
              max={600}
              value={draft.targetDurationSeconds}
              onChange={(event) => update('targetDurationSeconds', Math.max(4, Number(event.target.value || 4)))}
              className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70"
            />
          </div>
          <div>
            <label className="mb-2 block text-xs font-bold text-slate-300">画幅</label>
            <div className="flex h-[46px] items-center justify-between rounded-xl border border-[#303036] bg-[#09090B] px-4 text-sm text-white">
              <span>9:16 竖屏</span>
              <LockKeyhole className="h-4 w-4 text-slate-500" />
            </div>
          </div>
        </div>

        <div>
          <label htmlFor="director-brief" className="mb-2 flex items-center gap-2 text-xs font-bold text-slate-300">
            <FileText className="h-4 w-4 text-purple-400" /> 创意 / 故事梗概 *
          </label>
          <textarea
            id="director-brief"
            value={draft.creativeBrief}
            onChange={(event) => update('creativeBrief', event.target.value)}
            placeholder="描述故事发生什么、希望观众感受到什么。"
            rows={5}
            className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-purple-500/70"
          />
        </div>

        <details className="rounded-xl border border-[#2A2A30] bg-[#0B0B0E] p-4">
          <summary className="cursor-pointer text-sm font-bold text-slate-300">展开完整脚本与生产备注</summary>
          <div className="mt-4 space-y-4">
            <div>
              <label htmlFor="director-script" className="mb-2 block text-xs font-bold text-slate-300">完整脚本（可选）</label>
              <textarea
                id="director-script"
                value={draft.fullScript}
                onChange={(event) => update('fullScript', event.target.value)}
                rows={8}
                className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 font-mono text-sm leading-6 text-white outline-none transition focus:border-purple-500/70"
              />
            </div>
            <div>
              <label htmlFor="director-notes" className="mb-2 block text-xs font-bold text-slate-300">生产备注（可选）</label>
              <textarea
                id="director-notes"
                value={draft.productionNotes}
                onChange={(event) => update('productionNotes', event.target.value)}
                rows={3}
                className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-purple-500/70"
              />
            </div>
          </div>
        </details>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={saveDraft}
            className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200 transition hover:bg-[#232329]"
          >
            <Save className="h-4 w-4" /> 保存 Step 1 修改
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-purple-500/25 bg-[#111114] p-5 sm:p-6 space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-purple-400">STEP 2 · MANUAL STORYBOARD</div>
            <h2 className="mt-1 text-xl font-black text-white">人工分镜 Shot List</h2>
            <p className="mt-2 text-xs leading-5 text-slate-500">先人工决定“要哪些镜头、每镜拍什么、持续多久”。提示词、关键帧与视频生产留给后续独立环节。</p>
          </div>
          <button
            type="button"
            onClick={addShot}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-black text-white transition hover:bg-purple-500"
          >
            <Plus className="h-4 w-4" /> 新增镜头
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">镜头数</div>
            <div data-testid="shot-count" className="mt-1 text-2xl font-black text-white">{storyboard.shots.length}</div>
          </div>
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">分镜总时长</div>
            <div data-testid="shot-duration-total" className="mt-1 flex items-center gap-2 text-2xl font-black text-white"><Clock3 className="h-5 w-5 text-purple-400" />{totalShotDuration}s</div>
          </div>
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">对目标时长</div>
            <div className={`mt-1 text-sm font-black ${durationDelta === 0 ? 'text-emerald-300' : 'text-amber-300'}`}>
              {durationDelta === 0 ? '完全一致' : durationDelta > 0 ? `超出 ${durationDelta}s` : `还差 ${Math.abs(durationDelta)}s`}
            </div>
          </div>
        </div>

        {storyboard.shots.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#34343A] bg-[#0B0B0E] px-6 py-12 text-center">
            <div className="text-base font-black text-slate-300">还没有分镜</div>
            <p className="mt-2 text-xs leading-5 text-slate-500">点击“新增镜头”，从 S01 开始手工拆解。系统不会自动替你生成固定的 S01–S06。</p>
          </div>
        ) : (
          <div className="space-y-4">
            {storyboard.shots.map((shot, index) => {
              const label = shotLabel(index);
              return (
                <article key={shot.uid} data-testid={`shot-card-${label}`} className="rounded-2xl border border-[#2D2D33] bg-[#0B0B0E] p-4 sm:p-5 space-y-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center">
                    <div className="flex items-center gap-3">
                      <span className="inline-flex h-9 min-w-14 items-center justify-center rounded-lg border border-purple-500/30 bg-purple-500/10 px-2 font-mono text-sm font-black text-purple-300">{label}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <label htmlFor={`${shot.uid}-title`} className="sr-only">{label} 标题</label>
                      <input
                        id={`${shot.uid}-title`}
                        value={shot.title}
                        onChange={(event) => updateShot(shot.uid, 'title', event.target.value)}
                        placeholder="镜头标题，例如：手机拒信特写"
                        className="w-full rounded-xl border border-[#303036] bg-[#111114] px-4 py-2.5 text-sm font-bold text-white outline-none focus:border-purple-500/70"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <button type="button" aria-label={`${label} 上移`} disabled={index === 0} onClick={() => moveShot(index, -1)} className="rounded-lg border border-[#34343A] p-2 text-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
                      <button type="button" aria-label={`${label} 下移`} disabled={index === storyboard.shots.length - 1} onClick={() => moveShot(index, 1)} className="rounded-lg border border-[#34343A] p-2 text-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
                      <button type="button" aria-label={`${label} 删除`} onClick={() => deleteShot(shot.uid)} className="rounded-lg border border-rose-500/20 p-2 text-rose-400 hover:bg-rose-500/10"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-[150px_1fr_1fr]">
                    <div>
                      <label htmlFor={`${shot.uid}-duration`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 时长（秒）</label>
                      <input
                        id={`${shot.uid}-duration`}
                        type="number"
                        min={1}
                        max={60}
                        value={shot.durationSeconds}
                        onChange={(event) => updateShot(shot.uid, 'durationSeconds', Math.max(1, Number(event.target.value || 1)))}
                        className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white outline-none focus:border-purple-500/70"
                      />
                    </div>
                    <div>
                      <label htmlFor={`${shot.uid}-scene`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 场景</label>
                      <input
                        id={`${shot.uid}-scene`}
                        value={shot.scene}
                        onChange={(event) => updateShot(shot.uid, 'scene', event.target.value)}
                        placeholder="出租屋 / 阳台雨夜 / 街道…"
                        className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white outline-none focus:border-purple-500/70"
                      />
                    </div>
                    <div>
                      <label htmlFor={`${shot.uid}-camera`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 镜头语言</label>
                      <input
                        id={`${shot.uid}-camera`}
                        value={shot.camera}
                        onChange={(event) => updateShot(shot.uid, 'camera', event.target.value)}
                        placeholder="特写 / 中景 / 低机位 / 跟拍…"
                        className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white outline-none focus:border-purple-500/70"
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div>
                      <label htmlFor={`${shot.uid}-action`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 画面 / 动作</label>
                      <textarea
                        id={`${shot.uid}-action`}
                        value={shot.action}
                        onChange={(event) => updateShot(shot.uid, 'action', event.target.value)}
                        rows={3}
                        placeholder="这个镜头里具体发生什么。"
                        className="w-full resize-y rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm leading-5 text-white outline-none focus:border-purple-500/70"
                      />
                    </div>
                    <div>
                      <label htmlFor={`${shot.uid}-dialogue`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 对白 / 旁白（可选）</label>
                      <textarea
                        id={`${shot.uid}-dialogue`}
                        value={shot.dialogue}
                        onChange={(event) => updateShot(shot.uid, 'dialogue', event.target.value)}
                        rows={3}
                        placeholder="对白、字幕或旁白；没有可留空。"
                        className="w-full resize-y rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm leading-5 text-white outline-none focus:border-purple-500/70"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor={`${shot.uid}-notes`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 分镜备注（可选）</label>
                    <input
                      id={`${shot.uid}-notes`}
                      value={shot.notes}
                      onChange={(event) => updateShot(shot.uid, 'notes', event.target.value)}
                      placeholder="人物状态、必须保留细节、连续性要求等。"
                      className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white outline-none focus:border-purple-500/70"
                    />
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}
        {message && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}

        <div className="flex flex-col gap-3 border-t border-[#27272A] pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-slate-500">分镜最后保存：<span data-testid="storyboard-saved-at" className="font-mono text-slate-300">{formatSavedAt(storyboard.savedAt)}</span></div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={resetDraft}
              className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200 transition hover:bg-[#232329]"
            >
              <RotateCcw className="h-4 w-4" /> 新建空白项目
            </button>
            <button
              type="button"
              onClick={saveStoryboard}
              className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-black text-white shadow-[0_0_20px_rgba(124,58,237,0.25)] transition hover:bg-purple-500"
            >
              <Save className="h-4 w-4" /> 保存分镜
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
          <div className="flex items-center gap-2 text-sm font-black text-emerald-200">
            <CheckCircle2 className="h-5 w-5" /> Step 2 验收标准
          </div>
          <div className="mt-4 grid gap-2 text-xs leading-5 text-emerald-100/75 sm:grid-cols-2">
            <div>① 能从零手工新增任意数量 Shot</div>
            <div>② 每镜可编辑标题、时长、场景、动作与镜头语言</div>
            <div>③ 镜头可上移、下移，S01/S02 自动随顺序更新</div>
            <div>④ 可删除镜头，剩余镜头自动连续编号</div>
            <div>⑤ 保存后刷新页面，完整 Shot List 仍能恢复</div>
            <div>⑥ 全过程不自动拆镜、不调用 AI / 图片 / Veo Provider</div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#27272A] bg-[#111114] p-5 opacity-80">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500">NEXT · NOT IN THIS STAGE</div>
          <div className="mt-2 text-base font-black text-white">Step 3｜逐镜关键帧准备与确认</div>
          <p className="mt-2 text-xs leading-5 text-slate-500">Step 2 由你验收通过后，再为每个 Shot 增加关键帧任务信息、ChatGPT 提示词交接与人工确认状态。本阶段不提前实现。</p>
        </div>
      </section>
    </div>
  );
};
