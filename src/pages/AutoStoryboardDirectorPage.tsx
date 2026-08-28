import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Clock3,
  LockKeyhole,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  generateLocalStoryboard,
  type GeneratedStoryboardShot,
} from '../services/director/localStoryboardGenerator';

const DRAFT_KEY = 'zaojing_director_v01_brief';
const STORYBOARD_KEY = 'zaojing_director_v02_storyboard';
const APPROVAL_KEY = 'zaojing_director_v021_storyboard_approval';

interface DirectorBriefDraft {
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

interface StoryboardDraft {
  version: 'manual-storyboard-v0.2';
  shots: GeneratedStoryboardShot[];
  savedAt?: number;
  generatedAt?: number;
  generationEngine?: 'local-director-v0.1' | 'manual';
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

const EMPTY_STORYBOARD: StoryboardDraft = {
  version: 'manual-storyboard-v0.2',
  shots: [],
};

function createManualShot(): GeneratedStoryboardShot {
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

function readSavedStoryboard(): StoryboardDraft {
  try {
    const raw = window.localStorage.getItem(STORYBOARD_KEY);
    if (!raw) return EMPTY_STORYBOARD;
    const parsed = JSON.parse(raw) as Partial<StoryboardDraft>;
    const shots = Array.isArray(parsed.shots)
      ? parsed.shots.map((shot, index) => ({
          ...createManualShot(),
          ...shot,
          uid: typeof shot?.uid === 'string' && shot.uid ? shot.uid : `restored-${index}-${Date.now()}`,
          durationSeconds: Math.max(1, Number(shot?.durationSeconds || 4)),
        }))
      : [];
    return {
      version: 'manual-storyboard-v0.2',
      shots,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : undefined,
      generatedAt: typeof parsed.generatedAt === 'number' ? parsed.generatedAt : undefined,
      generationEngine: parsed.generationEngine === 'local-director-v0.1' ? 'local-director-v0.1' : 'manual',
    };
  } catch {
    return EMPTY_STORYBOARD;
  }
}

function readApproval() {
  try {
    const raw = window.localStorage.getItem(APPROVAL_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { approvedAt?: number };
    return typeof parsed.approvedAt === 'number' ? parsed.approvedAt : undefined;
  } catch {
    return undefined;
  }
}

function formatSavedAt(value?: number) {
  if (!value) return '尚未保存';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function shotLabel(index: number) {
  return `S${String(index + 1).padStart(2, '0')}`;
}

function normalizeStoryboard(storyboard: StoryboardDraft): StoryboardDraft {
  return {
    ...storyboard,
    version: 'manual-storyboard-v0.2',
    shots: storyboard.shots.map((shot) => ({
      ...shot,
      title: shot.title.trim(),
      durationSeconds: Math.max(1, Math.min(60, Number(shot.durationSeconds || 1))),
      scene: shot.scene.trim(),
      action: shot.action.trim(),
      camera: shot.camera.trim(),
      dialogue: shot.dialogue.trim(),
      notes: shot.notes.trim(),
    })),
  };
}

export const AutoStoryboardDirectorPage: React.FC = () => {
  const [draft, setDraft] = useState<DirectorBriefDraft>(() => readSavedDraft());
  const [storyboard, setStoryboard] = useState<StoryboardDraft>(() => readSavedStoryboard());
  const [approvedAt, setApprovedAt] = useState<number | undefined>(() => readApproval());
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

  const invalidateApproval = () => {
    window.localStorage.removeItem(APPROVAL_KEY);
    setApprovedAt(undefined);
  };

  const updateDraft = <K extends keyof DirectorBriefDraft>(key: K, value: DirectorBriefDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    invalidateApproval();
    clearFeedback();
  };

  const updateShot = <K extends keyof GeneratedStoryboardShot>(uid: string, key: K, value: GeneratedStoryboardShot[K]) => {
    setStoryboard((current) => ({
      ...current,
      shots: current.shots.map((shot) => (shot.uid === uid ? { ...shot, [key]: value } : shot)),
    }));
    invalidateApproval();
    clearFeedback();
  };

  const buildSavedDraft = (): DirectorBriefDraft => ({
    ...draft,
    title: draft.title.trim(),
    creativeBrief: draft.creativeBrief.trim(),
    fullScript: draft.fullScript.trim(),
    productionNotes: draft.productionNotes.trim(),
    savedAt: Date.now(),
  });

  const validateStep1 = () => {
    if (!draft.title.trim()) {
      setError('请先填写项目标题。');
      return false;
    }
    if (!hasContent) {
      setError('创意描述或完整脚本至少填写一项。');
      return false;
    }
    return true;
  };

  const saveDraft = () => {
    if (!validateStep1()) return;
    const next = buildSavedDraft();
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    setDraft(next);
    setError('');
    setMessage('Step 1 草稿已保存；可点击“生成分镜”进入 Step 2.1。');
  };

  const generateStoryboard = () => {
    if (!validateStep1()) return;
    if (storyboard.shots.length > 0) {
      const accepted = window.confirm('重新生成会覆盖当前 Shot List，包括你已经做过的人工修改。确认重新生成吗？');
      if (!accepted) return;
    }

    const savedDraft = buildSavedDraft();
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(savedDraft));
    setDraft(savedDraft);

    try {
      const shots = generateLocalStoryboard({
        title: savedDraft.title,
        creativeBrief: savedDraft.creativeBrief,
        fullScript: savedDraft.fullScript,
        productionNotes: savedDraft.productionNotes,
        targetDurationSeconds: savedDraft.targetDurationSeconds,
        targetFormat: savedDraft.targetFormat,
      });
      const now = Date.now();
      const next: StoryboardDraft = {
        version: 'manual-storyboard-v0.2',
        shots,
        generatedAt: now,
        savedAt: now,
        generationEngine: 'local-director-v0.1',
      };
      window.localStorage.setItem(STORYBOARD_KEY, JSON.stringify(next));
      window.localStorage.removeItem(APPROVAL_KEY);
      setStoryboard(next);
      setApprovedAt(undefined);
      setError('');
      setMessage(`系统已自动生成 ${shots.length} 个 Shot。请人工审核、修改后再点击“确认分镜”。`);
    } catch (generationError) {
      setMessage('');
      setError(generationError instanceof Error ? generationError.message : '分镜生成失败。');
    }
  };

  const addShot = () => {
    setStoryboard((current) => ({ ...current, shots: [...current.shots, createManualShot()] }));
    invalidateApproval();
    clearFeedback();
  };

  const deleteShot = (uid: string) => {
    setStoryboard((current) => ({ ...current, shots: current.shots.filter((shot) => shot.uid !== uid) }));
    invalidateApproval();
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
    invalidateApproval();
    clearFeedback();
  };

  const persistStoryboard = () => {
    if (storyboard.shots.length === 0) {
      setError('请先生成分镜，或至少手工新增一个镜头。');
      return null;
    }
    const next = {
      ...normalizeStoryboard(storyboard),
      savedAt: Date.now(),
    };
    window.localStorage.setItem(STORYBOARD_KEY, JSON.stringify(next));
    setStoryboard(next);
    return next;
  };

  const saveStoryboard = () => {
    const next = persistStoryboard();
    if (!next) return;
    setError('');
    setMessage(`分镜修改已保存：${next.shots.length} 个镜头，共 ${next.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)} 秒。`);
  };

  const confirmStoryboard = () => {
    const incompleteIndex = storyboard.shots.findIndex(
      (shot) => !shot.title.trim() || !shot.scene.trim() || !shot.action.trim() || !shot.camera.trim(),
    );
    if (storyboard.shots.length === 0) {
      setError('当前没有可确认的分镜。');
      return;
    }
    if (incompleteIndex >= 0) {
      setError(`${shotLabel(incompleteIndex)} 仍缺少标题、场景、画面/动作或镜头语言，请补齐后再确认。`);
      return;
    }
    const next = persistStoryboard();
    if (!next) return;
    const now = Date.now();
    window.localStorage.setItem(APPROVAL_KEY, JSON.stringify({
      version: 'storyboard-approval-v0.2.1',
      approvedAt: now,
      shotCount: next.shots.length,
      storyboardSavedAt: next.savedAt,
    }));
    setApprovedAt(now);
    setError('');
    setMessage('Step 2.1 分镜已人工确认。Step 3 尚未开放，本次不会继续自动生产。');
  };

  const resetProject = () => {
    if ((draft.title || hasContent || storyboard.shots.length > 0) && !window.confirm('确认新建空白项目？当前浏览器中的脚本与分镜都会被清空。')) return;
    window.localStorage.removeItem(DRAFT_KEY);
    window.localStorage.removeItem(STORYBOARD_KEY);
    window.localStorage.removeItem(APPROVAL_KEY);
    setDraft(EMPTY_DRAFT);
    setStoryboard(EMPTY_STORYBOARD);
    setApprovedAt(undefined);
    setMessage('已新建空白项目。');
    setError('');
  };

  return (
    <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-purple-400">
            <Clapperboard className="h-4 w-4" /> Director Console · Step 2.1
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">导演台｜Script → Storyboard 自动拆镜</h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">
            正常路径改为“Step 1 脚本 → 系统生成 Shot List → 人工导演审核”。系统只生成分镜初稿；人工编辑、排序、删除、新增仍全部保留，只有你点击“确认分镜”才算本环节 PASS。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300">STEP 1 · 已验收</span>
          <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs font-bold text-purple-300">STEP 2.1 · 待验收</span>
          <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-300">LOCAL DIRECTOR ENGINE</span>
        </div>
      </header>

      <section className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4 sm:p-5">
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" />
          <div>
            <div className="text-sm font-bold text-sky-100">本阶段安全边界</div>
            <p className="mt-1 text-xs leading-5 text-sky-100/70">
              当前自动拆镜由浏览器内本地导演规则引擎完成，用来先验收 Script → Storyboard 产品链路；不调用 Gemini/OpenAI/Veo 等真实付费 Provider，不生成图片、不生成视频、不创建 Firestore Episode。后续可在不改变 Shot 数据结构的前提下替换为 LLM Provider。
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-5 rounded-2xl border border-[#27272A] bg-[#111114] p-5 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-emerald-400">STEP 1 · ACCEPTED</div>
            <h2 className="mt-1 text-lg font-black text-white">创意 / 脚本输入</h2>
          </div>
          <div className="text-xs text-slate-500">最后保存：<span className="font-mono text-slate-300">{formatSavedAt(draft.savedAt)}</span></div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="auto-director-title" className="mb-2 block text-xs font-bold text-slate-300">项目标题 *</label>
            <input id="auto-director-title" value={draft.title} onChange={(event) => updateDraft('title', event.target.value)} placeholder="例如：押金扣光的第七天，我在出租屋手搓法杖" className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70" />
          </div>
          <div>
            <label htmlFor="auto-director-source" className="mb-2 block text-xs font-bold text-slate-300">当前输入成熟度</label>
            <select id="auto-director-source" value={draft.sourceType} onChange={(event) => updateDraft('sourceType', event.target.value as DirectorBriefDraft['sourceType'])} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70">
              <option value="idea">一句创意 / 核心想法</option><option value="outline">故事梗概 / 大纲</option><option value="script">已有完整脚本</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label htmlFor="auto-director-format" className="mb-2 block text-xs font-bold text-slate-300">目标内容形式</label>
            <select id="auto-director-format" value={draft.targetFormat} onChange={(event) => updateDraft('targetFormat', event.target.value as DirectorBriefDraft['targetFormat'])} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70">
              <option value="story_short">剧情短视频</option><option value="vlog">Vlog</option><option value="cosplay">AI Cosplay</option><option value="other">其他</option>
            </select>
          </div>
          <div>
            <label htmlFor="auto-director-duration" className="mb-2 block text-xs font-bold text-slate-300">目标总时长（秒）</label>
            <input id="auto-director-duration" type="number" min={4} max={600} value={draft.targetDurationSeconds} onChange={(event) => updateDraft('targetDurationSeconds', Math.max(4, Number(event.target.value || 4)))} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70" />
          </div>
          <div>
            <label className="mb-2 block text-xs font-bold text-slate-300">画幅</label>
            <div className="flex h-[46px] items-center justify-between rounded-xl border border-[#303036] bg-[#09090B] px-4 text-sm text-white"><span>9:16 竖屏</span><LockKeyhole className="h-4 w-4 text-slate-500" /></div>
          </div>
        </div>

        <div>
          <label htmlFor="auto-director-brief" className="mb-2 block text-xs font-bold text-slate-300">创意 / 故事梗概 *</label>
          <textarea id="auto-director-brief" value={draft.creativeBrief} onChange={(event) => updateDraft('creativeBrief', event.target.value)} rows={5} placeholder="输入一句创意、故事梗概或主要剧情。" className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none focus:border-purple-500/70" />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="auto-director-script" className="mb-2 block text-xs font-bold text-slate-300">完整脚本（可选）</label>
            <textarea id="auto-director-script" value={draft.fullScript} onChange={(event) => updateDraft('fullScript', event.target.value)} rows={6} placeholder="如已有完整脚本可粘贴；填写后系统优先按完整脚本拆镜。" className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none focus:border-purple-500/70" />
          </div>
          <div>
            <label htmlFor="auto-director-notes" className="mb-2 block text-xs font-bold text-slate-300">生产备注（可选）</label>
            <textarea id="auto-director-notes" value={draft.productionNotes} onChange={(event) => updateDraft('productionNotes', event.target.value)} rows={6} placeholder="角色连续性、视觉风格、必须保留的情节等。" className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none focus:border-purple-500/70" />
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[#27272A] pt-5">
          <button type="button" onClick={saveDraft} className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200 hover:bg-[#232329]"><Save className="h-4 w-4" /> 保存 Step 1 修改</button>
          <button type="button" onClick={generateStoryboard} className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-black text-white shadow-[0_0_20px_rgba(124,58,237,0.25)] hover:bg-purple-500"><Sparkles className="h-4 w-4" /> {storyboard.shots.length > 0 ? '重新生成分镜' : '生成分镜'}</button>
        </div>
      </section>

      <section className="space-y-5 rounded-2xl border border-[#27272A] bg-[#111114] p-5 sm:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-purple-400">STEP 2.1 · SYSTEM DRAFT → HUMAN REVIEW</div>
            <h2 className="mt-1 text-lg font-black text-white">Storyboard / Shot List</h2>
            <p className="mt-1 text-xs text-slate-500">系统先生成初稿；你负责最终导演判断。镜头数量不固定。</p>
          </div>
          <button type="button" onClick={addShot} className="inline-flex items-center gap-2 rounded-xl border border-purple-500/30 bg-purple-500/10 px-4 py-2.5 text-sm font-bold text-purple-200 hover:bg-purple-500/20"><Plus className="h-4 w-4" /> 新增镜头</button>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">镜头数</div><div data-testid="auto-shot-count" className="mt-1 text-2xl font-black text-white">{storyboard.shots.length}</div></div>
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">分镜总时长</div><div className="mt-1 flex items-center gap-2 text-2xl font-black text-white"><Clock3 className="h-5 w-5 text-purple-400" />{totalShotDuration}s</div></div>
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">对目标时长</div><div className={`mt-1 text-sm font-black ${durationDelta === 0 ? 'text-emerald-300' : 'text-amber-300'}`}>{durationDelta === 0 ? '完全一致' : durationDelta > 0 ? `超出 ${durationDelta}s` : `还差 ${Math.abs(durationDelta)}s`}</div></div>
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">人工验收</div><div data-testid="storyboard-approval-status" className={`mt-1 text-sm font-black ${approvedAt ? 'text-emerald-300' : 'text-slate-400'}`}>{approvedAt ? 'PASS' : '待确认'}</div></div>
        </div>

        {storyboard.shots.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#34343A] bg-[#0B0B0E] px-6 py-12 text-center">
            <Sparkles className="mx-auto h-7 w-7 text-purple-400" />
            <div className="mt-3 text-base font-black text-slate-300">等待自动生成分镜</div>
            <p className="mt-2 text-xs leading-5 text-slate-500">先填写 Step 1，然后点击“生成分镜”。系统会根据剧情动态决定 Shot 数量，不固定为 S01–S06。</p>
          </div>
        ) : (
          <div className="space-y-4">
            {storyboard.shots.map((shot, index) => {
              const label = shotLabel(index);
              return (
                <article key={shot.uid} className="space-y-4 rounded-2xl border border-[#2D2D33] bg-[#0B0B0E] p-4 sm:p-5">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center">
                    <span className="inline-flex h-9 min-w-14 items-center justify-center rounded-lg border border-purple-500/30 bg-purple-500/10 px-2 font-mono text-sm font-black text-purple-300">{label}</span>
                    <div className="min-w-0 flex-1"><label htmlFor={`${shot.uid}-title`} className="sr-only">{label} 标题</label><input id={`${shot.uid}-title`} value={shot.title} onChange={(event) => updateShot(shot.uid, 'title', event.target.value)} placeholder="镜头标题" className="w-full rounded-xl border border-[#303036] bg-[#111114] px-4 py-2.5 text-sm font-bold text-white outline-none focus:border-purple-500/70" /></div>
                    <div className="flex items-center gap-1">
                      <button type="button" aria-label={`${label} 上移`} disabled={index === 0} onClick={() => moveShot(index, -1)} className="rounded-lg border border-[#34343A] p-2 text-slate-400 hover:text-white disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
                      <button type="button" aria-label={`${label} 下移`} disabled={index === storyboard.shots.length - 1} onClick={() => moveShot(index, 1)} className="rounded-lg border border-[#34343A] p-2 text-slate-400 hover:text-white disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
                      <button type="button" aria-label={`${label} 删除`} onClick={() => deleteShot(shot.uid)} className="rounded-lg border border-rose-500/20 p-2 text-rose-400 hover:bg-rose-500/10"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-[150px_1fr_1fr]">
                    <div><label htmlFor={`${shot.uid}-duration`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 时长（秒）</label><input id={`${shot.uid}-duration`} type="number" min={1} max={60} value={shot.durationSeconds} onChange={(event) => updateShot(shot.uid, 'durationSeconds', Math.max(1, Number(event.target.value || 1)))} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white outline-none focus:border-purple-500/70" /></div>
                    <div><label htmlFor={`${shot.uid}-scene`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 场景</label><input id={`${shot.uid}-scene`} value={shot.scene} onChange={(event) => updateShot(shot.uid, 'scene', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white outline-none focus:border-purple-500/70" /></div>
                    <div><label htmlFor={`${shot.uid}-camera`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 镜头语言</label><input id={`${shot.uid}-camera`} value={shot.camera} onChange={(event) => updateShot(shot.uid, 'camera', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white outline-none focus:border-purple-500/70" /></div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div><label htmlFor={`${shot.uid}-action`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 画面 / 动作</label><textarea id={`${shot.uid}-action`} value={shot.action} onChange={(event) => updateShot(shot.uid, 'action', event.target.value)} rows={3} className="w-full resize-y rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm leading-5 text-white outline-none focus:border-purple-500/70" /></div>
                    <div><label htmlFor={`${shot.uid}-dialogue`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 对白 / 旁白（可选）</label><textarea id={`${shot.uid}-dialogue`} value={shot.dialogue} onChange={(event) => updateShot(shot.uid, 'dialogue', event.target.value)} rows={3} className="w-full resize-y rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm leading-5 text-white outline-none focus:border-purple-500/70" /></div>
                  </div>

                  <div><label htmlFor={`${shot.uid}-notes`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 分镜备注 / 连续性要求</label><input id={`${shot.uid}-notes`} value={shot.notes} onChange={(event) => updateShot(shot.uid, 'notes', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white outline-none focus:border-purple-500/70" /></div>
                </article>
              );
            })}
          </div>
        )}

        {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}
        {message && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}

        <div className="flex flex-col gap-3 border-t border-[#27272A] pt-5 md:flex-row md:items-center md:justify-between">
          <div className="text-xs text-slate-500">生成：<span className="font-mono text-slate-300">{formatSavedAt(storyboard.generatedAt)}</span> · 保存：<span className="font-mono text-slate-300">{formatSavedAt(storyboard.savedAt)}</span></div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={resetProject} className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200 hover:bg-[#232329]"><RotateCcw className="h-4 w-4" /> 新建空白项目</button>
            <button type="button" onClick={saveStoryboard} className="inline-flex items-center gap-2 rounded-xl border border-purple-500/30 bg-purple-500/10 px-4 py-2.5 text-sm font-bold text-purple-200 hover:bg-purple-500/20"><Save className="h-4 w-4" /> 保存分镜修改</button>
            <button type="button" onClick={confirmStoryboard} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-black text-white hover:bg-emerald-500"><CheckCircle2 className="h-4 w-4" /> 确认分镜</button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
          <div className="flex items-center gap-2 text-sm font-black text-emerald-200"><CheckCircle2 className="h-5 w-5" /> Step 2.1 验收标准</div>
          <div className="mt-4 grid gap-2 text-xs leading-5 text-emerald-100/75 sm:grid-cols-2">
            <div>① Step 1 内容可直接生成动态 Shot List</div><div>② 每镜自动填写标题、时长、场景、镜头、动作等字段</div><div>③ 自动生成后仍可人工增删改排</div><div>④ 重新生成前必须提示会覆盖人工修改</div><div>⑤ 保存/刷新后 Shot List 完整恢复</div><div>⑥ 必须人工点击“确认分镜”才算 PASS</div>
          </div>
        </div>
        <div className="rounded-2xl border border-[#27272A] bg-[#111114] p-5 opacity-80">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500">NEXT · LOCKED</div>
          <div className="mt-2 text-base font-black text-white">Step 3｜逐镜关键帧准备与确认</div>
          <p className="mt-2 text-xs leading-5 text-slate-500">只有 Step 2.1 人工确认后才进入。当前不会自动生成图片、视频或创建生产 Episode。</p>
        </div>
      </section>
    </div>
  );
};
