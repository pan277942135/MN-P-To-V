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
  WandSparkles,
} from 'lucide-react';
import {
  generateLocalStoryboard,
  type GeneratedStoryboardShot,
} from '../services/director/localStoryboardGenerator';
import { generateGeminiStoryboard } from '../services/director/geminiStoryboardClient';

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
  generationEngine?: 'vertex-gemini' | 'local-director-v0.1' | 'manual';
  generationModel?: string;
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
          uid: typeof shot?.uid === 'string' && shot.uid
            ? shot.uid
            : `restored-${index}-${Date.now()}`,
          durationSeconds: Math.max(1, Number(shot?.durationSeconds || 4)),
        }))
      : [];

    const engine = parsed.generationEngine === 'vertex-gemini'
      ? 'vertex-gemini'
      : parsed.generationEngine === 'local-director-v0.1'
        ? 'local-director-v0.1'
        : 'manual';

    return {
      version: 'manual-storyboard-v0.2',
      shots,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : undefined,
      generatedAt: typeof parsed.generatedAt === 'number' ? parsed.generatedAt : undefined,
      generationEngine: engine,
      generationModel: typeof parsed.generationModel === 'string' ? parsed.generationModel : undefined,
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

export const GeminiStoryboardDirectorPage: React.FC = () => {
  const [draft, setDraft] = useState<DirectorBriefDraft>(() => readSavedDraft());
  const [storyboard, setStoryboard] = useState<StoryboardDraft>(() => readSavedStoryboard());
  const [approvedAt, setApprovedAt] = useState<number | undefined>(() => readApproval());
  const [isGenerating, setIsGenerating] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const hasContent = useMemo(
    () => Boolean(draft.creativeBrief.trim() || draft.fullScript.trim()),
    [draft.creativeBrief, draft.fullScript],
  );

  const totalShotDuration = useMemo(
    () => storyboard.shots.reduce(
      (sum, shot) => sum + Math.max(1, Number(shot.durationSeconds || 1)),
      0,
    ),
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

  const updateDraft = <K extends keyof DirectorBriefDraft>(
    key: K,
    value: DirectorBriefDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    invalidateApproval();
    clearFeedback();
  };

  const updateShot = <K extends keyof GeneratedStoryboardShot>(
    uid: string,
    key: K,
    value: GeneratedStoryboardShot[K],
  ) => {
    setStoryboard((current) => ({
      ...current,
      shots: current.shots.map((shot) => (
        shot.uid === uid ? { ...shot, [key]: value } : shot
      )),
    }));
    invalidateApproval();
    clearFeedback();
  };

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

  const buildSavedDraft = (): DirectorBriefDraft => ({
    ...draft,
    title: draft.title.trim(),
    creativeBrief: draft.creativeBrief.trim(),
    fullScript: draft.fullScript.trim(),
    productionNotes: draft.productionNotes.trim(),
    savedAt: Date.now(),
  });

  const saveDraft = () => {
    if (!validateStep1()) return;
    const next = buildSavedDraft();
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    setDraft(next);
    setError('');
    setMessage('Step 1 草稿已保存；可调用 Gemini 生成分镜。');
  };

  const confirmOverwrite = () => {
    if (storyboard.shots.length === 0) return true;
    return window.confirm(
      '重新生成会覆盖当前 Shot List，包括已经完成的人工修改。确认继续吗？',
    );
  };

  const persistGeneratedStoryboard = (
    shots: GeneratedStoryboardShot[],
    engine: StoryboardDraft['generationEngine'],
    model?: string,
    generatedAt = Date.now(),
  ) => {
    const next: StoryboardDraft = {
      version: 'manual-storyboard-v0.2',
      shots,
      generatedAt,
      savedAt: generatedAt,
      generationEngine: engine,
      generationModel: model,
    };
    window.localStorage.setItem(STORYBOARD_KEY, JSON.stringify(next));
    window.localStorage.removeItem(APPROVAL_KEY);
    setStoryboard(next);
    setApprovedAt(undefined);
    return next;
  };

  const generateWithGemini = async () => {
    if (!validateStep1() || !confirmOverwrite()) return;

    const savedDraft = buildSavedDraft();
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(savedDraft));
    setDraft(savedDraft);
    setIsGenerating(true);
    setError('');
    setMessage('正在调用 Vertex AI Gemini 进行导演拆镜…');

    try {
      const result = await generateGeminiStoryboard({
        title: savedDraft.title,
        creativeBrief: savedDraft.creativeBrief,
        fullScript: savedDraft.fullScript,
        productionNotes: savedDraft.productionNotes,
        targetDurationSeconds: savedDraft.targetDurationSeconds,
        targetFormat: savedDraft.targetFormat,
      });

      persistGeneratedStoryboard(
        result.shots,
        'vertex-gemini',
        result.model,
        result.generatedAt,
      );
      setError('');
      setMessage(
        `Gemini 已生成 ${result.shots.length} 个 Shot（${result.model}）。请人工审核后再点击“确认分镜”。`,
      );
    } catch (generationError) {
      setMessage('');
      setError(
        generationError instanceof Error
          ? `${generationError.message} 系统未自动切换本地结果；如需继续，可明确点击“使用本地备用拆镜”。`
          : 'Gemini 分镜生成失败。系统未自动切换本地结果。',
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const generateWithLocalFallback = () => {
    if (!validateStep1() || !confirmOverwrite()) return;

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
      persistGeneratedStoryboard(shots, 'local-director-v0.1');
      setError('');
      setMessage(
        `已使用 Local Director fallback 生成 ${shots.length} 个 Shot；这不是 Gemini 结果。`,
      );
    } catch (generationError) {
      setMessage('');
      setError(
        generationError instanceof Error
          ? generationError.message
          : '本地备用拆镜失败。',
      );
    }
  };

  const addShot = () => {
    setStoryboard((current) => ({
      ...current,
      shots: [...current.shots, createManualShot()],
    }));
    invalidateApproval();
    clearFeedback();
  };

  const deleteShot = (uid: string) => {
    setStoryboard((current) => ({
      ...current,
      shots: current.shots.filter((shot) => shot.uid !== uid),
    }));
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
    setMessage(
      `分镜修改已保存：${next.shots.length} 个镜头，共 ${next.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)} 秒。`,
    );
  };

  const confirmStoryboard = () => {
    if (storyboard.shots.length === 0) {
      setError('当前没有可确认的分镜。');
      return;
    }
    const incompleteIndex = storyboard.shots.findIndex(
      (shot) => !shot.title.trim() ||
        !shot.scene.trim() ||
        !shot.action.trim() ||
        !shot.camera.trim(),
    );
    if (incompleteIndex >= 0) {
      setError(
        `${shotLabel(incompleteIndex)} 仍缺少标题、场景、画面/动作或镜头语言，请补齐后再确认。`,
      );
      return;
    }

    const next = persistStoryboard();
    if (!next) return;
    const now = Date.now();
    window.localStorage.setItem(APPROVAL_KEY, JSON.stringify({
      version: 'storyboard-approval-v0.2.2',
      approvedAt: now,
      shotCount: next.shots.length,
      storyboardSavedAt: next.savedAt,
      generationEngine: next.generationEngine,
      generationModel: next.generationModel,
    }));
    setApprovedAt(now);
    setError('');
    setMessage('Step 2.2 分镜已人工确认。Step 3 尚未开放。');
  };

  const resetProject = () => {
    if (
      (draft.title || hasContent || storyboard.shots.length > 0) &&
      !window.confirm('确认新建空白项目？当前浏览器中的脚本与分镜都会被清空。')
    ) return;

    window.localStorage.removeItem(DRAFT_KEY);
    window.localStorage.removeItem(STORYBOARD_KEY);
    window.localStorage.removeItem(APPROVAL_KEY);
    setDraft(EMPTY_DRAFT);
    setStoryboard(EMPTY_STORYBOARD);
    setApprovedAt(undefined);
    setMessage('已新建空白项目。');
    setError('');
  };

  const engineLabel = storyboard.generationEngine === 'vertex-gemini'
    ? `Vertex Gemini${storyboard.generationModel ? ` · ${storyboard.generationModel}` : ''}`
    : storyboard.generationEngine === 'local-director-v0.1'
      ? 'Local Director fallback'
      : '手工';

  return (
    <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-purple-400">
            <Clapperboard className="h-4 w-4" /> Director Console · Step 2.2
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">
            导演台｜Gemini Script → Storyboard
          </h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">
            Step 1 的创意 / 脚本通过服务端调用 Vertex AI Gemini 生成动态 Shot List；
            生成结果仍必须由你人工修改与确认后才能 PASS。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300">
            STEP 1 · 已验收
          </span>
          <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs font-bold text-purple-300">
            STEP 2.2 · GEMINI
          </span>
          <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-300">
            GEMINI DIRECTOR
          </span>
        </div>
      </header>

      <section className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4 sm:p-5">
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" />
          <div>
            <div className="text-sm font-bold text-sky-100">本阶段调用边界</div>
            <p className="mt-1 text-xs leading-5 text-sky-100/70">
              “Gemini 生成分镜”会真实调用 Vertex AI Gemini，因此会产生 Gemini 推理费用。
              本阶段仍不调用图片模型、不调用 Veo、不创建 Episode、不执行视频生产。
              Gemini 失败时不会静默伪装成本地结果；Local Director 只能由你主动点击作为备用。
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-5 rounded-2xl border border-[#27272A] bg-[#111114] p-5 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-emerald-400">
              STEP 1 · ACCEPTED
            </div>
            <h2 className="mt-1 text-lg font-black text-white">创意 / 脚本输入</h2>
          </div>
          <div className="text-xs text-slate-500">
            最后保存：<span className="font-mono text-slate-300">{formatSavedAt(draft.savedAt)}</span>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="gemini-director-title" className="mb-2 block text-xs font-bold text-slate-300">
              项目标题 *
            </label>
            <input
              id="gemini-director-title"
              value={draft.title}
              onChange={(event) => updateDraft('title', event.target.value)}
              className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70"
            />
          </div>
          <div>
            <label htmlFor="gemini-director-source" className="mb-2 block text-xs font-bold text-slate-300">
              当前输入成熟度
            </label>
            <select
              id="gemini-director-source"
              value={draft.sourceType}
              onChange={(event) => updateDraft('sourceType', event.target.value as DirectorBriefDraft['sourceType'])}
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
            <label htmlFor="gemini-director-format" className="mb-2 block text-xs font-bold text-slate-300">
              目标内容形式
            </label>
            <select
              id="gemini-director-format"
              value={draft.targetFormat}
              onChange={(event) => updateDraft('targetFormat', event.target.value as DirectorBriefDraft['targetFormat'])}
              className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70"
            >
              <option value="story_short">剧情短视频</option>
              <option value="vlog">Vlog</option>
              <option value="cosplay">AI Cosplay</option>
              <option value="other">其他</option>
            </select>
          </div>
          <div>
            <label htmlFor="gemini-director-duration" className="mb-2 block text-xs font-bold text-slate-300">
              目标总时长（秒）
            </label>
            <input
              id="gemini-director-duration"
              type="number"
              min={4}
              max={600}
              value={draft.targetDurationSeconds}
              onChange={(event) => updateDraft('targetDurationSeconds', Math.max(4, Number(event.target.value || 4)))}
              className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70"
            />
          </div>
          <div>
            <label className="mb-2 block text-xs font-bold text-slate-300">画幅</label>
            <div className="flex h-[46px] items-center justify-between rounded-xl border border-[#303036] bg-[#09090B] px-4 text-sm text-white">
              <span>9:16 竖屏</span><LockKeyhole className="h-4 w-4 text-slate-500" />
            </div>
          </div>
        </div>

        <div>
          <label htmlFor="gemini-director-brief" className="mb-2 block text-xs font-bold text-slate-300">
            创意 / 故事梗概 *
          </label>
          <textarea
            id="gemini-director-brief"
            value={draft.creativeBrief}
            onChange={(event) => updateDraft('creativeBrief', event.target.value)}
            rows={5}
            className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none focus:border-purple-500/70"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="gemini-director-script" className="mb-2 block text-xs font-bold text-slate-300">
              完整脚本（可选）
            </label>
            <textarea
              id="gemini-director-script"
              value={draft.fullScript}
              onChange={(event) => updateDraft('fullScript', event.target.value)}
              rows={6}
              className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none focus:border-purple-500/70"
            />
          </div>
          <div>
            <label htmlFor="gemini-director-notes" className="mb-2 block text-xs font-bold text-slate-300">
              生产备注（可选）
            </label>
            <textarea
              id="gemini-director-notes"
              value={draft.productionNotes}
              onChange={(event) => updateDraft('productionNotes', event.target.value)}
              rows={6}
              className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none focus:border-purple-500/70"
            />
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[#27272A] pt-5">
          <button
            type="button"
            onClick={saveDraft}
            className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200 hover:bg-[#232329]"
          >
            <Save className="h-4 w-4" /> 保存 Step 1 修改
          </button>
          <button
            type="button"
            onClick={generateWithLocalFallback}
            disabled={isGenerating}
            className="inline-flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-bold text-amber-200 disabled:opacity-40"
          >
            <WandSparkles className="h-4 w-4" /> 使用本地备用拆镜
          </button>
          <button
            type="button"
            onClick={generateWithGemini}
            disabled={isGenerating}
            className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-black text-white shadow-[0_0_20px_rgba(124,58,237,0.25)] hover:bg-purple-500 disabled:cursor-wait disabled:opacity-60"
          >
            <Sparkles className="h-4 w-4" />
            {isGenerating
              ? 'Gemini 正在拆镜…'
              : storyboard.shots.length > 0
                ? 'Gemini 重新生成分镜'
                : 'Gemini 生成分镜'}
          </button>
        </div>
      </section>

      <section className="space-y-5 rounded-2xl border border-[#27272A] bg-[#111114] p-5 sm:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-purple-400">
              STEP 2.2 · GEMINI DRAFT → HUMAN REVIEW
            </div>
            <h2 className="mt-1 text-lg font-black text-white">Storyboard / Shot List</h2>
            <p className="mt-1 text-xs text-slate-500">
              当前来源：<span data-testid="generation-engine">{engineLabel}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={addShot}
            className="inline-flex items-center gap-2 rounded-xl border border-purple-500/30 bg-purple-500/10 px-4 py-2.5 text-sm font-bold text-purple-200"
          >
            <Plus className="h-4 w-4" /> 新增镜头
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">镜头数</div>
            <div data-testid="gemini-shot-count" className="mt-1 text-2xl font-black text-white">
              {storyboard.shots.length}
            </div>
          </div>
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">分镜总时长</div>
            <div className="mt-1 flex items-center gap-2 text-2xl font-black text-white">
              <Clock3 className="h-5 w-5 text-purple-400" />{totalShotDuration}s
            </div>
          </div>
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">对目标时长</div>
            <div className={`mt-1 text-sm font-black ${durationDelta === 0 ? 'text-emerald-300' : 'text-amber-300'}`}>
              {durationDelta === 0
                ? '完全一致'
                : durationDelta > 0
                  ? `超出 ${durationDelta}s`
                  : `还差 ${Math.abs(durationDelta)}s`}
            </div>
          </div>
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">人工验收</div>
            <div
              data-testid="storyboard-approval-status"
              className={`mt-1 text-sm font-black ${approvedAt ? 'text-emerald-300' : 'text-amber-300'}`}
            >
              {approvedAt ? 'PASS' : '待确认'}
            </div>
          </div>
        </div>

        {storyboard.shots.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#34343A] bg-[#0B0B0E] px-6 py-12 text-center">
            <div className="text-base font-black text-slate-300">还没有分镜</div>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              点击“Gemini 生成分镜”，由模型根据脚本内容动态决定 Shot 数量。
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {storyboard.shots.map((shot, index) => {
              const label = shotLabel(index);
              return (
                <article
                  key={shot.uid}
                  className="space-y-4 rounded-2xl border border-[#2D2D33] bg-[#0B0B0E] p-4 sm:p-5"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-center">
                    <span className="inline-flex h-9 min-w-14 items-center justify-center rounded-lg border border-purple-500/30 bg-purple-500/10 px-2 font-mono text-sm font-black text-purple-300">
                      {label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <label htmlFor={`${shot.uid}-title`} className="sr-only">{label} 标题</label>
                      <input
                        id={`${shot.uid}-title`}
                        value={shot.title}
                        onChange={(event) => updateShot(shot.uid, 'title', event.target.value)}
                        className="w-full rounded-xl border border-[#303036] bg-[#111114] px-4 py-2.5 text-sm font-bold text-white outline-none focus:border-purple-500/70"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <button type="button" aria-label={`${label} 上移`} disabled={index === 0} onClick={() => moveShot(index, -1)} className="rounded-lg border border-[#34343A] p-2 text-slate-400 disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
                      <button type="button" aria-label={`${label} 下移`} disabled={index === storyboard.shots.length - 1} onClick={() => moveShot(index, 1)} className="rounded-lg border border-[#34343A] p-2 text-slate-400 disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
                      <button type="button" aria-label={`${label} 删除`} onClick={() => deleteShot(shot.uid)} className="rounded-lg border border-rose-500/20 p-2 text-rose-400"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-[150px_1fr_1fr]">
                    <div>
                      <label htmlFor={`${shot.uid}-duration`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 时长（秒）</label>
                      <input id={`${shot.uid}-duration`} type="number" min={1} max={60} value={shot.durationSeconds} onChange={(event) => updateShot(shot.uid, 'durationSeconds', Math.max(1, Number(event.target.value || 1)))} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white" />
                    </div>
                    <div>
                      <label htmlFor={`${shot.uid}-scene`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 场景</label>
                      <input id={`${shot.uid}-scene`} value={shot.scene} onChange={(event) => updateShot(shot.uid, 'scene', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white" />
                    </div>
                    <div>
                      <label htmlFor={`${shot.uid}-camera`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 镜头语言</label>
                      <input id={`${shot.uid}-camera`} value={shot.camera} onChange={(event) => updateShot(shot.uid, 'camera', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white" />
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div>
                      <label htmlFor={`${shot.uid}-action`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 画面 / 动作</label>
                      <textarea id={`${shot.uid}-action`} value={shot.action} onChange={(event) => updateShot(shot.uid, 'action', event.target.value)} rows={3} className="w-full resize-y rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm leading-5 text-white" />
                    </div>
                    <div>
                      <label htmlFor={`${shot.uid}-dialogue`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 对白 / 旁白（可选）</label>
                      <textarea id={`${shot.uid}-dialogue`} value={shot.dialogue} onChange={(event) => updateShot(shot.uid, 'dialogue', event.target.value)} rows={3} className="w-full resize-y rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm leading-5 text-white" />
                    </div>
                  </div>

                  <div>
                    <label htmlFor={`${shot.uid}-notes`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 分镜备注</label>
                    <input id={`${shot.uid}-notes`} value={shot.notes} onChange={(event) => updateShot(shot.uid, 'notes', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white" />
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}
        {message && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            {message}
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-[#27272A] pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-slate-500">
            分镜最后保存：<span className="font-mono text-slate-300">{formatSavedAt(storyboard.savedAt)}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={resetProject} className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200">
              <RotateCcw className="h-4 w-4" /> 新建空白项目
            </button>
            <button type="button" onClick={saveStoryboard} className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200">
              <Save className="h-4 w-4" /> 保存分镜修改
            </button>
            <button type="button" onClick={confirmStoryboard} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-black text-white">
              <CheckCircle2 className="h-4 w-4" /> 确认分镜
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
          <div className="flex items-center gap-2 text-sm font-black text-emerald-200">
            <CheckCircle2 className="h-5 w-5" /> Step 2.2 验收标准
          </div>
          <div className="mt-4 grid gap-2 text-xs leading-5 text-emerald-100/75 sm:grid-cols-2">
            <div>① Gemini 根据脚本动态生成 Shot List</div>
            <div>② Shot 核心字段由 Gemini 一次性填充</div>
            <div>③ Gemini 失败时不静默伪装成本地结果</div>
            <div>④ 仍可人工增删、排序和改写</div>
            <div>⑤ 保存刷新后完整恢复并记录生成引擎</div>
            <div>⑥ 只有人工“确认分镜”后才 PASS</div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#27272A] bg-[#111114] p-5 opacity-80">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
            NEXT · NOT IN THIS STAGE
          </div>
          <div className="mt-2 text-base font-black text-white">
            Step 3｜逐镜关键帧准备与确认
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            Gemini 分镜验收通过后再进入关键帧。本阶段不生成图片、不调用 Veo。
          </p>
        </div>
      </section>
    </div>
  );
};
