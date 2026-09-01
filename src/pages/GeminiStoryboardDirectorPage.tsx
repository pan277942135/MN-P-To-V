import React, { useMemo, useState } from 'react';
import { ProjectBindingPanel } from '../components/ProjectBindingPanel';
import { ProjectAssetSummary } from '../components/ProjectAssetSummary';
import { FormatPolicyEditor } from '../components/FormatPolicyEditor';
import { useDirectorCloud } from '../components/DirectorCloudPersistenceProvider';
import { useProjectSession } from '../context/ProjectSessionContext';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Clock3,
  Copy,
  FileInput,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  generateLocalStoryboard,
  type GeneratedStoryboardShot,
} from '../services/director/localStoryboardGenerator';
import { generateGeminiStoryboard } from '../services/director/geminiStoryboardClient';
import {
  CHATGPT_STORYBOARD_OUTPUT_INSTRUCTION,
  parseChatGPTStoryboardImport,
} from '../services/director/chatgptStoryboardImport';
import type { ProjectBindingRestoreResponse } from '../services/director/projectBindingClient';
import {
  DEFAULT_FORMAT_POLICY,
  LEGACY_FORMAT_POLICY,
  hasFormatPolicy,
  normalizeFormatPolicy,
  SUPPORTED_ASPECT_RATIOS,
  type AspectRatio,
  type ProductionFormatPolicy,
} from '../services/formatPolicy/formatPolicy';

const DRAFT_KEY = 'zaojing_director_v01_brief';
const STORYBOARD_KEY = 'zaojing_director_v02_storyboard';
const APPROVAL_KEY = 'zaojing_director_v021_storyboard_approval';

type GenerationEngine = 'vertex-gemini' | 'local-director-v0.1' | 'chatgpt-import' | 'manual';

interface DirectorBriefDraft {
  version: 'director-brief-v0.1';
  title: string;
  sourceType: 'idea' | 'outline' | 'script';
  targetFormat: 'story_short' | 'vlog' | 'cosplay' | 'other';
  targetDurationSeconds: number;
  /** Legacy field retained for existing persistence and consumers. */
  aspectRatio: AspectRatio;
  formatPolicy: ProductionFormatPolicy;
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
  generationEngine?: GenerationEngine;
  generationModel?: string;
}

const EMPTY_DRAFT: DirectorBriefDraft = {
  version: 'director-brief-v0.1',
  title: '',
  sourceType: 'idea',
  targetFormat: 'story_short',
  targetDurationSeconds: 30,
  aspectRatio: '16:9',
  formatPolicy: DEFAULT_FORMAT_POLICY,
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
    const fallback = hasFormatPolicy(parsed.formatPolicy) ? DEFAULT_FORMAT_POLICY : LEGACY_FORMAT_POLICY;
    const formatPolicy = normalizeFormatPolicy(parsed.formatPolicy, fallback);
    return {
      ...EMPTY_DRAFT,
      ...parsed,
      version: 'director-brief-v0.1',
      aspectRatio: formatPolicy.defaultAspectRatio,
      formatPolicy,
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

    const supported: GenerationEngine[] = [
      'vertex-gemini',
      'local-director-v0.1',
      'chatgpt-import',
      'manual',
    ];
    const engine = supported.includes(parsed.generationEngine as GenerationEngine)
      ? parsed.generationEngine as GenerationEngine
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

function hydrateRestoredDraft(value: unknown, inheritedPolicy?: unknown): DirectorBriefDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Partial<DirectorBriefDraft>;
  const policyValue = parsed.formatPolicy || inheritedPolicy;
  const fallback = hasFormatPolicy(policyValue) ? DEFAULT_FORMAT_POLICY : LEGACY_FORMAT_POLICY;
  const formatPolicy = normalizeFormatPolicy(policyValue, fallback);
  return {
    ...EMPTY_DRAFT,
    ...parsed,
    version: 'director-brief-v0.1',
    title: typeof parsed.title === 'string' ? parsed.title : '',
    creativeBrief: typeof parsed.creativeBrief === 'string' ? parsed.creativeBrief : '',
    fullScript: typeof parsed.fullScript === 'string' ? parsed.fullScript : '',
    productionNotes: typeof parsed.productionNotes === 'string' ? parsed.productionNotes : '',
    targetDurationSeconds: Math.max(4, Number(parsed.targetDurationSeconds || 30)),
    aspectRatio: formatPolicy.defaultAspectRatio,
    formatPolicy,
  };
}

function hydrateRestoredStoryboard(value: unknown): StoryboardDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Partial<StoryboardDraft>;
  if (!Array.isArray(parsed.shots)) return null;
  return {
    ...EMPTY_STORYBOARD,
    ...parsed,
    version: 'manual-storyboard-v0.2',
    shots: parsed.shots.map((shot, index) => ({
      ...createManualShot(),
      ...(shot || {}),
      uid: typeof shot?.uid === 'string' && shot.uid ? shot.uid : `restored-${index}-${Date.now()}`,
      title: typeof shot?.title === 'string' ? shot.title : '',
      durationSeconds: Math.max(1, Number(shot?.durationSeconds || 4)),
      scene: typeof shot?.scene === 'string' ? shot.scene : '',
      action: typeof shot?.action === 'string' ? shot.action : '',
      camera: typeof shot?.camera === 'string' ? shot.camera : '',
      dialogue: typeof shot?.dialogue === 'string' ? shot.dialogue : '',
      notes: typeof shot?.notes === 'string' ? shot.notes : '',
    })),
  };
}

export const GeminiStoryboardDirectorPage: React.FC = () => {
  const { record } = useDirectorCloud();
  const { projectId: sessionProjectId } = useProjectSession();
  const [draft, setDraft] = useState<DirectorBriefDraft>(() => readSavedDraft());
  const [storyboard, setStoryboard] = useState<StoryboardDraft>(() => readSavedStoryboard());
  const [approvedAt, setApprovedAt] = useState<number | undefined>(() => readApproval());
  const [isGenerating, setIsGenerating] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [formatCopied, setFormatCopied] = useState(false);

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

  const updateFormatPolicy = (formatPolicy: ProductionFormatPolicy) => {
    setDraft((current) => ({
      ...current,
      formatPolicy,
      // Keep the legacy field synchronized for existing consumers.
      aspectRatio: formatPolicy.defaultAspectRatio,
    }));
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
    formatPolicy: normalizeFormatPolicy(draft.formatPolicy, DEFAULT_FORMAT_POLICY),
    aspectRatio: normalizeFormatPolicy(draft.formatPolicy, DEFAULT_FORMAT_POLICY).defaultAspectRatio,
    savedAt: Date.now(),
  });

  const saveDraft = () => {
    if (!validateStep1()) return;
    const next = buildSavedDraft();
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    setDraft(next);
    setError('');
    setMessage('Step 1 草稿已保存；可调用 Gemini 生成分镜，或手动录入 ChatGPT 已完成分镜。');
  };

  const confirmOverwrite = (messageText = '重新生成会覆盖当前 Shot List，包括已经完成的人工修改。确认继续吗？') => {
    if (storyboard.shots.length === 0) return true;
    return window.confirm(messageText);
  };

  const persistGeneratedStoryboard = (
    shots: GeneratedStoryboardShot[],
    engine: GenerationEngine,
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
        aspectRatio: savedDraft.formatPolicy.defaultAspectRatio,
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
        aspectRatio: savedDraft.formatPolicy.defaultAspectRatio,
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

  const openManualImport = () => {
    setImportOpen(true);
    setImportError('');
    setFormatCopied(false);
  };

  const closeManualImport = () => {
    setImportOpen(false);
    setImportError('');
    setFormatCopied(false);
  };

  const copyFormatRequirement = async () => {
    try {
      await navigator.clipboard.writeText(CHATGPT_STORYBOARD_OUTPUT_INSTRUCTION);
      setFormatCopied(true);
      setImportError('');
    } catch {
      setFormatCopied(false);
      setImportError('当前浏览器未允许复制格式要求；可直接长按右侧文本复制。');
    }
  };

  const importManualStoryboard = () => {
    setImportError('');
    try {
      const result = parseChatGPTStoryboardImport(importText);
      if (!confirmOverwrite('导入会覆盖当前 Shot List，包括已经完成的人工修改。确认继续吗？')) return;

      const now = Date.now();
      const importedDraft: DirectorBriefDraft = {
        version: 'director-brief-v0.1',
        title: result.project.title,
        sourceType: result.project.sourceType,
        targetFormat: result.project.targetFormat,
        targetDurationSeconds: result.project.targetDurationSeconds,
        aspectRatio: draft.formatPolicy.defaultAspectRatio,
        formatPolicy: draft.formatPolicy,
        creativeBrief: result.project.creativeBrief,
        fullScript: result.project.fullScript,
        productionNotes: result.project.productionNotes,
        savedAt: now,
      };
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(importedDraft));
      setDraft(importedDraft);
      persistGeneratedStoryboard(result.shots, 'chatgpt-import', 'zaojing.storyboard.v1', now);
      setImportOpen(false);
      setImportText('');
      setError('');
      setMessage(`已从 ChatGPT 手动导入并拆分 ${result.shots.length} 个 Shot。请继续人工审核后确认分镜。`);
    } catch (importFailure) {
      setImportError(
        importFailure instanceof Error
          ? importFailure.message
          : '手动分镜导入失败。',
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
      setError('请先生成、导入分镜，或至少手工新增一个镜头。');
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
      version: 'storyboard-approval-v0.2.3',
      approvedAt: now,
      shotCount: next.shots.length,
      storyboardSavedAt: next.savedAt,
      generationEngine: next.generationEngine,
      generationModel: next.generationModel,
    }));
    setApprovedAt(now);
    setError('');
    setMessage('Step 2.3 分镜已人工确认。Step 3 尚未开放。');
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
      : storyboard.generationEngine === 'chatgpt-import'
        ? 'ChatGPT 手动导入 · zaojing.storyboard.v1'
        : '手工';

  const handleProjectRestored = (payload: ProjectBindingRestoreResponse) => {
    const restoredDraft = hydrateRestoredDraft(payload.stages.brief, payload.project.formatPolicy || payload.episode.formatPolicy);
    const restoredStoryboard = hydrateRestoredStoryboard(payload.stages.storyboard);
    const approval = payload.stages.storyboardApproval as { approvedAt?: unknown } | undefined;
    if (restoredDraft) setDraft(restoredDraft);
    if (restoredStoryboard) setStoryboard(restoredStoryboard);
    setApprovedAt(typeof approval?.approvedAt === 'number' ? approval.approvedAt : undefined);
    setError('');
    setMessage(`Director Cloud 已恢复：${payload.project.projectTitle} · ${payload.episode.episodeId}。`);
  };

  return (
    <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-purple-400">
            <Clapperboard className="h-4 w-4" /> Director Console · Step 2.3
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">
            导演台｜Script / ChatGPT → Storyboard
          </h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">
            支持两种主入口：脚本调用 Vertex AI Gemini 自动拆镜；或把 ChatGPT 中已经讨论完成的标准分镜包手动粘贴导入，自动拆成多个 Shot。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300">STEP 1 · 已验收</span>
          <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs font-bold text-purple-300">STEP 2.3 · TWO INPUTS</span>
          <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-300">GEMINI + CHATGPT IMPORT</span>
        </div>
      </header>

      <ProjectBindingPanel onRestored={handleProjectRestored} />

      <ProjectAssetSummary projectId={sessionProjectId || record?.snapshot.projectId} />

      <section className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4 sm:p-5">
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" />
          <div>
            <div className="text-sm font-bold text-sky-100">两种分镜入口</div>
            <p className="mt-1 text-xs leading-5 text-sky-100/70">
              A｜“Gemini 生成分镜”会真实调用 Vertex AI Gemini 并产生推理费用。B｜“手动录入分镜”只在浏览器本地解析你粘贴的 ChatGPT JSON，不产生模型费用。两种入口最后都进入同一 Shot List 人工审核与 PASS 流程。
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
            <label htmlFor="gemini-director-title" className="mb-2 block text-xs font-bold text-slate-300">项目标题 *</label>
            <input id="gemini-director-title" value={draft.title} onChange={(event) => updateDraft('title', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70" />
          </div>
          <div>
            <label htmlFor="gemini-director-source" className="mb-2 block text-xs font-bold text-slate-300">当前输入成熟度</label>
            <select id="gemini-director-source" value={draft.sourceType} onChange={(event) => updateDraft('sourceType', event.target.value as DirectorBriefDraft['sourceType'])} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70">
              <option value="idea">一句创意 / 核心想法</option>
              <option value="outline">故事梗概 / 大纲</option>
              <option value="script">已有完整脚本</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label htmlFor="gemini-director-format" className="mb-2 block text-xs font-bold text-slate-300">目标内容形式</label>
            <select id="gemini-director-format" value={draft.targetFormat} onChange={(event) => updateDraft('targetFormat', event.target.value as DirectorBriefDraft['targetFormat'])} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70">
              <option value="story_short">剧情短视频</option>
              <option value="vlog">Vlog</option>
              <option value="cosplay">AI Cosplay</option>
              <option value="other">其他</option>
            </select>
          </div>
          <div>
            <label htmlFor="gemini-director-duration" className="mb-2 block text-xs font-bold text-slate-300">目标总时长（秒）</label>
            <input id="gemini-director-duration" type="number" min={4} max={600} value={draft.targetDurationSeconds} onChange={(event) => updateDraft('targetDurationSeconds', Math.max(4, Number(event.target.value || 4)))} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70" />
          </div>
          <div>
            <label className="mb-2 block text-xs font-bold text-slate-300">默认画幅</label>
            <div className="flex h-[46px] items-center rounded-xl border border-[#303036] bg-[#09090B] px-4 text-sm font-black text-white"><span>{draft.formatPolicy.defaultAspectRatio}</span><span className="ml-auto text-[11px] font-normal text-slate-500">Production Policy</span></div>
          </div>
        </div>

        <FormatPolicyEditor
          value={draft.formatPolicy}
          onChange={updateFormatPolicy}
          idPrefix="gemini-director"
          compact
        />

        <div>
          <label htmlFor="gemini-director-brief" className="mb-2 block text-xs font-bold text-slate-300">创意 / 故事梗概 *</label>
          <textarea id="gemini-director-brief" value={draft.creativeBrief} onChange={(event) => updateDraft('creativeBrief', event.target.value)} rows={5} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none focus:border-purple-500/70" />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="gemini-director-script" className="mb-2 block text-xs font-bold text-slate-300">完整脚本（可选）</label>
            <textarea id="gemini-director-script" value={draft.fullScript} onChange={(event) => updateDraft('fullScript', event.target.value)} rows={6} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none focus:border-purple-500/70" />
          </div>
          <div>
            <label htmlFor="gemini-director-notes" className="mb-2 block text-xs font-bold text-slate-300">生产备注（可选）</label>
            <textarea id="gemini-director-notes" value={draft.productionNotes} onChange={(event) => updateDraft('productionNotes', event.target.value)} rows={6} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none focus:border-purple-500/70" />
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[#27272A] pt-5">
          <button type="button" onClick={saveDraft} className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200 hover:bg-[#232329]"><Save className="h-4 w-4" /> 保存 Step 1 修改</button>
          <button type="button" onClick={openManualImport} className="inline-flex items-center gap-2 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-sm font-black text-sky-200"><FileInput className="h-4 w-4" /> 手动录入分镜</button>
          <button type="button" onClick={generateWithLocalFallback} disabled={isGenerating} className="inline-flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-bold text-amber-200 disabled:opacity-40"><WandSparkles className="h-4 w-4" /> 使用本地备用拆镜</button>
          <button type="button" onClick={generateWithGemini} disabled={isGenerating} className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-black text-white shadow-[0_0_20px_rgba(124,58,237,0.25)] hover:bg-purple-500 disabled:cursor-wait disabled:opacity-60">
            <Sparkles className="h-4 w-4" />
            {isGenerating ? 'Gemini 正在拆镜…' : storyboard.shots.length > 0 ? 'Gemini 重新生成分镜' : 'Gemini 生成分镜'}
          </button>
        </div>
      </section>

      <section className="space-y-5 rounded-2xl border border-[#27272A] bg-[#111114] p-5 sm:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-purple-400">STEP 2.3 · DRAFT → HUMAN REVIEW</div>
            <h2 className="mt-1 text-lg font-black text-white">Storyboard / Shot List</h2>
            <p className="mt-1 text-xs text-slate-500">当前来源：<span data-testid="generation-engine">{engineLabel}</span></p>
          </div>
          <button type="button" onClick={addShot} className="inline-flex items-center gap-2 rounded-xl border border-purple-500/30 bg-purple-500/10 px-4 py-2.5 text-sm font-bold text-purple-200"><Plus className="h-4 w-4" /> 新增镜头</button>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">镜头数</div><div data-testid="gemini-shot-count" className="mt-1 text-2xl font-black text-white">{storyboard.shots.length}</div></div>
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">分镜总时长</div><div className="mt-1 flex items-center gap-2 text-2xl font-black text-white"><Clock3 className="h-5 w-5 text-purple-400" />{totalShotDuration}s</div></div>
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">对目标时长</div><div className={`mt-1 text-sm font-black ${durationDelta === 0 ? 'text-emerald-300' : 'text-amber-300'}`}>{durationDelta === 0 ? '完全一致' : durationDelta > 0 ? `超出 ${durationDelta}s` : `还差 ${Math.abs(durationDelta)}s`}</div></div>
          <div className="rounded-xl border border-[#2D2D33] bg-[#0B0B0E] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">人工验收</div><div data-testid="storyboard-approval-status" className={`mt-1 text-sm font-black ${approvedAt ? 'text-emerald-300' : 'text-amber-300'}`}>{approvedAt ? 'PASS' : '待确认'}</div></div>
        </div>

        {storyboard.shots.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#34343A] bg-[#0B0B0E] px-6 py-12 text-center">
            <div className="text-base font-black text-slate-300">还没有分镜</div>
            <p className="mt-2 text-xs leading-5 text-slate-500">可点击“Gemini 生成分镜”，或“手动录入分镜”粘贴 ChatGPT 已完成的标准分镜包。</p>
          </div>
        ) : (
          <div className="space-y-4">
            {storyboard.shots.map((shot, index) => {
              const label = shotLabel(index);
              return (
                <article key={shot.uid} className="space-y-4 rounded-2xl border border-[#2D2D33] bg-[#0B0B0E] p-4 sm:p-5">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center">
                    <span className="inline-flex h-9 min-w-14 items-center justify-center rounded-lg border border-purple-500/30 bg-purple-500/10 px-2 font-mono text-sm font-black text-purple-300">{label}</span>
                    <div className="min-w-0 flex-1">
                      <label htmlFor={`${shot.uid}-title`} className="sr-only">{label} 标题</label>
                      <input id={`${shot.uid}-title`} value={shot.title} onChange={(event) => updateShot(shot.uid, 'title', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-4 py-2.5 text-sm font-bold text-white outline-none focus:border-purple-500/70" />
                    </div>
                    <div className="flex items-center gap-1">
                      <button type="button" aria-label={`${label} 上移`} disabled={index === 0} onClick={() => moveShot(index, -1)} className="rounded-lg border border-[#34343A] p-2 text-slate-400 disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
                      <button type="button" aria-label={`${label} 下移`} disabled={index === storyboard.shots.length - 1} onClick={() => moveShot(index, 1)} className="rounded-lg border border-[#34343A] p-2 text-slate-400 disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
                      <button type="button" aria-label={`${label} 删除`} onClick={() => deleteShot(shot.uid)} className="rounded-lg border border-rose-500/20 p-2 text-rose-400"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-[150px_1fr_1fr_170px]">
                    <div><label htmlFor={`${shot.uid}-duration`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 时长（秒）</label><input id={`${shot.uid}-duration`} type="number" min={1} max={60} value={shot.durationSeconds} onChange={(event) => updateShot(shot.uid, 'durationSeconds', Math.max(1, Number(event.target.value || 1)))} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white" /></div>
                    <div><label htmlFor={`${shot.uid}-scene`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 场景</label><input id={`${shot.uid}-scene`} value={shot.scene} onChange={(event) => updateShot(shot.uid, 'scene', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white" /></div>
                    <div><label htmlFor={`${shot.uid}-camera`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 镜头语言</label><input id={`${shot.uid}-camera`} value={shot.camera} onChange={(event) => updateShot(shot.uid, 'camera', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white" /></div>
                    <div>
                      <label htmlFor={`${shot.uid}-aspect-ratio`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 画幅覆盖</label>
                      <select
                        id={`${shot.uid}-aspect-ratio`}
                        aria-label={`${label} 画幅覆盖`}
                        value={shot.formatPolicy?.aspectRatio || ''}
                        disabled={!draft.formatPolicy.allowShotOverride}
                        onChange={(event) => updateShot(
                          shot.uid,
                          'formatPolicy',
                          event.target.value
                            ? { aspectRatio: event.target.value as AspectRatio }
                            : undefined,
                        )}
                        className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <option value="">继承项目策略</option>
                        {SUPPORTED_ASPECT_RATIOS
                          .filter((aspectRatio) => draft.formatPolicy.allowedAspectRatios.includes(aspectRatio))
                          .map((aspectRatio) => <option key={aspectRatio} value={aspectRatio}>{aspectRatio}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div><label htmlFor={`${shot.uid}-action`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 画面 / 动作</label><textarea id={`${shot.uid}-action`} value={shot.action} onChange={(event) => updateShot(shot.uid, 'action', event.target.value)} rows={3} className="w-full resize-y rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm leading-5 text-white" /></div>
                    <div><label htmlFor={`${shot.uid}-dialogue`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 对白 / 旁白（可选）</label><textarea id={`${shot.uid}-dialogue`} value={shot.dialogue} onChange={(event) => updateShot(shot.uid, 'dialogue', event.target.value)} rows={3} className="w-full resize-y rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm leading-5 text-white" /></div>
                  </div>

                  <div><label htmlFor={`${shot.uid}-notes`} className="mb-1.5 block text-[11px] font-bold text-slate-500">{label} 分镜备注</label><input id={`${shot.uid}-notes`} value={shot.notes} onChange={(event) => updateShot(shot.uid, 'notes', event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#111114] px-3 py-2.5 text-sm text-white" /></div>
                </article>
              );
            })}
          </div>
        )}

        {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}
        {message && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}

        <div className="flex flex-col gap-3 border-t border-[#27272A] pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-slate-500">分镜最后保存：<span className="font-mono text-slate-300">{formatSavedAt(storyboard.savedAt)}</span></div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={resetProject} className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200"><RotateCcw className="h-4 w-4" /> 新建空白项目</button>
            <button type="button" onClick={saveStoryboard} className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200"><Save className="h-4 w-4" /> 保存分镜修改</button>
            <button type="button" onClick={confirmStoryboard} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-black text-white"><CheckCircle2 className="h-4 w-4" /> 确认分镜</button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
          <div className="flex items-center gap-2 text-sm font-black text-emerald-200"><CheckCircle2 className="h-5 w-5" /> Step 2.3 验收标准</div>
          <div className="mt-4 grid gap-2 text-xs leading-5 text-emerald-100/75 sm:grid-cols-2">
            <div>① Gemini 可根据脚本动态生成 Shot List</div>
            <div>② “手动录入分镜”弹窗可粘贴 ChatGPT 标准 JSON</div>
            <div>③ 弹窗同时展示固定输出格式要求</div>
            <div>④ 导入后自动生成 S01～Sn，不固定镜头数</div>
            <div>⑤ 两种来源都可继续人工增删、排序和改写</div>
            <div>⑥ 只有人工“确认分镜”后才 PASS</div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#27272A] bg-[#111114] p-5 opacity-80">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500">NEXT · NOT IN THIS STAGE</div>
          <div className="mt-2 text-base font-black text-white">Step 3｜逐镜关键帧准备与确认</div>
          <p className="mt-2 text-xs leading-5 text-slate-500">分镜验收通过后再进入关键帧。本阶段不生成图片、不调用 Veo。</p>
        </div>
      </section>

      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="manual-storyboard-import-title">
          <div className="max-h-[94vh] w-full max-w-6xl overflow-y-auto rounded-t-2xl border border-[#34343A] bg-[#111114] shadow-2xl sm:rounded-2xl">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[#2A2A30] bg-[#111114]/95 px-4 py-4 backdrop-blur sm:px-6">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-widest text-sky-400">入口 B · MANUAL IMPORT</div>
                <h2 id="manual-storyboard-import-title" className="mt-1 text-lg font-black text-white">手动录入 ChatGPT 分镜</h2>
                <p className="mt-1 text-xs leading-5 text-slate-400">把 ChatGPT 已讨论完成的分镜 JSON 粘贴到左侧，点击一次即可自动拆成多个 Shot。</p>
              </div>
              <button type="button" aria-label="关闭手动录入分镜" onClick={closeManualImport} className="rounded-lg border border-[#34343A] p-2 text-slate-400"><X className="h-4 w-4" /></button>
            </div>

            <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[1.05fr_0.95fr]">
              <div className="space-y-3">
                <div>
                  <label htmlFor="manual-storyboard-import-text" className="block text-sm font-black text-white">粘贴分镜内容</label>
                  <p className="mt-1 text-xs text-slate-500">支持纯 JSON，也兼容 ChatGPT 外层 ```json 代码块。</p>
                </div>
                <textarea
                  id="manual-storyboard-import-text"
                  data-testid="manual-storyboard-import-text"
                  value={importText}
                  onChange={(event) => {
                    setImportText(event.target.value);
                    setImportError('');
                  }}
                  rows={22}
                  autoFocus
                  placeholder={'在这里粘贴 ChatGPT 输出的 zaojing.storyboard.v1 JSON…'}
                  className="min-h-[360px] w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 font-mono text-xs leading-5 text-slate-200 outline-none focus:border-sky-500/70"
                />
                {importError && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{importError}</div>}
              </div>

              <aside className="space-y-3 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-black text-sky-100">要求 ChatGPT 输出的格式</div>
                    <p className="mt-1 text-xs leading-5 text-sky-100/65">在 ChatGPT 讨论完成后，把下面整段要求发给它，再复制它返回的 JSON。</p>
                  </div>
                  <button type="button" onClick={copyFormatRequirement} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs font-bold text-sky-200"><Copy className="h-3.5 w-3.5" /> {formatCopied ? '已复制' : '复制要求'}</button>
                </div>
                <pre data-testid="chatgpt-storyboard-format" className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[#303036] bg-[#09090B] p-4 font-mono text-[11px] leading-5 text-slate-300">{CHATGPT_STORYBOARD_OUTPUT_INSTRUCTION}</pre>
              </aside>
            </div>

            <div className="sticky bottom-0 flex flex-col-reverse gap-2 border-t border-[#2A2A30] bg-[#111114]/95 px-4 py-4 backdrop-blur sm:flex-row sm:justify-end sm:px-6">
              <button type="button" onClick={closeManualImport} className="rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200">取消</button>
              <button type="button" onClick={importManualStoryboard} className="inline-flex items-center justify-center gap-2 rounded-xl bg-sky-600 px-5 py-2.5 text-sm font-black text-white hover:bg-sky-500"><FileInput className="h-4 w-4" /> 导入并拆分 Shot</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
