import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clapperboard,
  Image as ImageIcon,
  LockKeyhole,
  Save,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  CURRENT_SERIES_TITLE,
  DIRECTOR_DRAFT_KEY,
  KEYFRAME_BLUEPRINT_APPROVAL_KEY,
  KEYFRAME_BLUEPRINT_APPROVAL_VERSION,
  KEYFRAME_BLUEPRINT_KEY,
  KEYFRAME_BLUEPRINT_VERSION,
  STORYBOARD_APPROVAL_KEY,
  STORYBOARD_KEY,
  buildKeyframeBlueprintDraft,
  findIncompleteBlueprintIndex,
  isStoryboardApprovalCurrent,
  normalizeKeyframeBlueprintDraft,
  type KeyframeBlueprint,
  type KeyframeBlueprintApproval,
  type KeyframeBlueprintDraft,
  type StoryboardApprovalForBlueprint,
  type StoryboardForBlueprint,
} from '../services/director/keyframeBlueprint';

interface DirectorProjectDraft {
  title?: string;
  productionNotes?: string;
}

interface InitialPageState {
  sourceReady: boolean;
  sourceReason: string;
  draft: KeyframeBlueprintDraft | null;
  approval: KeyframeBlueprintApproval | null;
  autoCreated: boolean;
}

function safeParse<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function readProject(): DirectorProjectDraft {
  return safeParse<DirectorProjectDraft>(DIRECTOR_DRAFT_KEY) || {};
}

function readStoryboard(): StoryboardForBlueprint | null {
  return safeParse<StoryboardForBlueprint>(STORYBOARD_KEY);
}

function readStoryboardApproval(): StoryboardApprovalForBlueprint | null {
  return safeParse<StoryboardApprovalForBlueprint>(STORYBOARD_APPROVAL_KEY);
}

function storedDraftMatchesSource(
  draft: KeyframeBlueprintDraft | null,
  storyboard: StoryboardForBlueprint,
  approval: StoryboardApprovalForBlueprint,
): draft is KeyframeBlueprintDraft {
  if (!draft || draft.version !== KEYFRAME_BLUEPRINT_VERSION) return false;
  if (draft.sourceStoryboardSavedAt !== approval.storyboardSavedAt) return false;
  if (draft.sourceStoryboardApprovedAt !== approval.approvedAt) return false;
  if (draft.blueprints.length !== storyboard.shots.length) return false;
  return draft.blueprints.every((item, index) => item.shotUid === storyboard.shots[index]?.uid);
}

function readCurrentApproval(draft: KeyframeBlueprintDraft): KeyframeBlueprintApproval | null {
  const approval = safeParse<KeyframeBlueprintApproval>(KEYFRAME_BLUEPRINT_APPROVAL_KEY);
  if (!approval || approval.version !== KEYFRAME_BLUEPRINT_APPROVAL_VERSION) return null;
  if (approval.blueprintSavedAt !== draft.savedAt) return null;
  if (approval.sourceStoryboardSavedAt !== draft.sourceStoryboardSavedAt) return null;
  if (approval.blueprintCount !== draft.blueprints.length) return null;
  return approval;
}

function initializePage(): InitialPageState {
  const project = readProject();
  const storyboard = readStoryboard();
  const storyboardApproval = readStoryboardApproval();

  if (!storyboard || !storyboardApproval) {
    return {
      sourceReady: false,
      sourceReason: '请先回到“导演台”完成 Storyboard，并点击“确认分镜”形成 PASS。',
      draft: null,
      approval: null,
      autoCreated: false,
    };
  }

  if (!isStoryboardApprovalCurrent(storyboard, storyboardApproval)) {
    return {
      sourceReady: false,
      sourceReason: '当前 Storyboard 已发生变化，原 PASS 已失效。请重新确认最新分镜后再进入 Step 3.1。',
      draft: null,
      approval: null,
      autoCreated: false,
    };
  }

  const stored = safeParse<KeyframeBlueprintDraft>(KEYFRAME_BLUEPRINT_KEY);
  if (storedDraftMatchesSource(stored, storyboard, storyboardApproval)) {
    return {
      sourceReady: true,
      sourceReason: '',
      draft: stored,
      approval: readCurrentApproval(stored),
      autoCreated: false,
    };
  }

  const created = buildKeyframeBlueprintDraft({
    projectTitle: project.title || '',
    productionNotes: project.productionNotes || '',
    storyboard,
    approval: storyboardApproval,
  });
  window.localStorage.setItem(KEYFRAME_BLUEPRINT_KEY, JSON.stringify(created));
  window.localStorage.removeItem(KEYFRAME_BLUEPRINT_APPROVAL_KEY);

  return {
    sourceReady: true,
    sourceReason: '',
    draft: created,
    approval: null,
    autoCreated: true,
  };
}

function formatSavedAt(value?: number) {
  if (!value) return '尚未保存';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export const KeyframeBlueprintPage: React.FC = () => {
  const initial = useMemo(() => initializePage(), []);
  const [draft, setDraft] = useState<KeyframeBlueprintDraft | null>(initial.draft);
  const [approval, setApproval] = useState<KeyframeBlueprintApproval | null>(initial.approval);
  const [message, setMessage] = useState(
    initial.autoCreated && initial.draft
      ? `Storyboard PASS 已读取，系统自动创建 ${initial.draft.blueprints.length} 个 Keyframe Blueprint。`
      : '',
  );
  const [error, setError] = useState('');

  const invalidateApproval = () => {
    window.localStorage.removeItem(KEYFRAME_BLUEPRINT_APPROVAL_KEY);
    setApproval(null);
  };

  const updateBlueprint = <K extends keyof KeyframeBlueprint>(
    uid: string,
    key: K,
    value: KeyframeBlueprint[K],
  ) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        blueprints: current.blueprints.map((item) => (
          item.uid === uid ? { ...item, [key]: value } : item
        )),
      };
    });
    invalidateApproval();
    setMessage('');
    setError('');
  };

  const saveDraft = () => {
    if (!draft) return;
    const next = normalizeKeyframeBlueprintDraft(draft);
    window.localStorage.setItem(KEYFRAME_BLUEPRINT_KEY, JSON.stringify(next));
    setDraft(next);
    setError('');
    setMessage(`Step 3.1 已保存：${next.blueprints.length} 个 Keyframe Blueprint。`);
  };

  const confirmDraft = () => {
    if (!draft) return;
    const normalized = normalizeKeyframeBlueprintDraft(draft);
    const incompleteIndex = findIncompleteBlueprintIndex(normalized);
    if (incompleteIndex >= 0) {
      setMessage('');
      setError(`${normalized.blueprints[incompleteIndex].shotLabel} 的 Blueprint 仍有必填项为空，请补齐后再确认。`);
      return;
    }

    window.localStorage.setItem(KEYFRAME_BLUEPRINT_KEY, JSON.stringify(normalized));
    const nextApproval: KeyframeBlueprintApproval = {
      version: KEYFRAME_BLUEPRINT_APPROVAL_VERSION,
      approvedAt: Date.now(),
      blueprintSavedAt: normalized.savedAt,
      sourceStoryboardSavedAt: normalized.sourceStoryboardSavedAt,
      blueprintCount: normalized.blueprints.length,
    };
    window.localStorage.setItem(KEYFRAME_BLUEPRINT_APPROVAL_KEY, JSON.stringify(nextApproval));
    setDraft(normalized);
    setApproval(nextApproval);
    setError('');
    setMessage('Step 3.1 Keyframe Blueprint 已人工确认 PASS。图片生成仍未开放。');
  };

  if (!initial.sourceReady || !draft) {
    return (
      <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-amber-400">
            <Clapperboard className="h-4 w-4" /> Director Console · Step 3.1
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">关键帧蓝图｜Storyboard → Keyframe Blueprint</h1>
          <p className="mt-2 text-sm text-slate-400">{CURRENT_SERIES_TITLE}</p>
        </header>

        <section className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-6">
          <div className="flex items-start gap-3">
            <LockKeyhole className="mt-0.5 h-5 w-5 text-amber-300" />
            <div>
              <div className="text-base font-black text-amber-100">Step 3.1 尚未解锁</div>
              <p className="mt-2 text-sm leading-6 text-amber-100/70">{initial.sourceReason}</p>
              <p className="mt-3 text-xs text-slate-500">本页不会绕过 Storyboard 人工门禁，也不会调用图片模型或 Veo。</p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-cyan-400">
            <ImageIcon className="h-4 w-4" /> Director Console · Step 3.1
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">关键帧蓝图｜Storyboard → Keyframe Blueprint</h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">
            Storyboard PASS 后自动创建逐镜关键帧生产蓝图。这里把动态分镜转换成适合后续图生视频首帧的静态瞬间，但本阶段不生成任何图片。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300">STORYBOARD · PASS</span>
          <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-bold text-cyan-300">STEP 3.1 · {approval ? 'PASS' : '待确认'}</span>
          <span className="rounded-full border border-slate-500/30 bg-slate-500/10 px-3 py-1.5 text-xs font-bold text-slate-300">NO IMAGE / NO VEO</span>
        </div>
      </header>

      <section className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" />
          <div className="min-w-0">
            <div className="text-sm font-black text-cyan-100">{draft.seriesTitle}</div>
            <div className="mt-1 text-xs leading-5 text-cyan-100/70">项目：{draft.projectTitle} · 来源 Storyboard：{draft.blueprints.length} 镜 · Blueprint 与稳定 shot.uid 一一绑定。</div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Blueprint 数</div><div data-testid="keyframe-blueprint-count" className="mt-1 text-2xl font-black text-white">{draft.blueprints.length}</div></div>
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Storyboard 源版本</div><div className="mt-2 font-mono text-xs text-slate-300">{formatSavedAt(draft.sourceStoryboardSavedAt)}</div></div>
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">最后保存</div><div className="mt-2 font-mono text-xs text-slate-300">{formatSavedAt(draft.savedAt)}</div></div>
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">人工验收</div><div data-testid="keyframe-blueprint-approval-status" className={`mt-2 text-sm font-black ${approval ? 'text-emerald-300' : 'text-amber-300'}`}>{approval ? 'PASS' : '待确认'}</div></div>
      </section>

      <section className="space-y-4">
        {draft.blueprints.map((blueprint) => (
          <article key={blueprint.uid} className="space-y-5 rounded-2xl border border-[#2D2D33] bg-[#111114] p-4 sm:p-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <span className="inline-flex h-9 min-w-14 items-center justify-center rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 font-mono text-sm font-black text-cyan-300">{blueprint.shotLabel}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-black text-white">{blueprint.shotTitle}</div>
                <div className="mt-1 truncate font-mono text-[10px] text-slate-600">shot.uid: {blueprint.shotUid}</div>
              </div>
            </div>

            <div>
              <label htmlFor={`${blueprint.uid}-visual`} className="mb-1.5 block text-xs font-bold text-slate-300">{blueprint.shotLabel} 关键帧画面描述 *</label>
              <textarea id={`${blueprint.uid}-visual`} aria-label={`${blueprint.shotLabel} 关键帧画面描述`} value={blueprint.visualDescription} onChange={(event) => updateBlueprint(blueprint.uid, 'visualDescription', event.target.value)} rows={3} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm leading-5 text-white outline-none focus:border-cyan-500/70" />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div><label htmlFor={`${blueprint.uid}-character-reference`} className="mb-1.5 block text-xs font-bold text-slate-400">角色母板 / 身份 *</label><textarea id={`${blueprint.uid}-character-reference`} value={blueprint.characterReference} onChange={(event) => updateBlueprint(blueprint.uid, 'characterReference', event.target.value)} rows={2} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm leading-5 text-white" /></div>
              <div><label htmlFor={`${blueprint.uid}-character-state`} className="mb-1.5 block text-xs font-bold text-slate-400">人物状态 *</label><textarea id={`${blueprint.uid}-character-state`} value={blueprint.characterState} onChange={(event) => updateBlueprint(blueprint.uid, 'characterState', event.target.value)} rows={2} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm leading-5 text-white" /></div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <div><label htmlFor={`${blueprint.uid}-scene`} className="mb-1.5 block text-xs font-bold text-slate-400">场景 *</label><textarea id={`${blueprint.uid}-scene`} value={blueprint.scene} onChange={(event) => updateBlueprint(blueprint.uid, 'scene', event.target.value)} rows={2} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm leading-5 text-white" /></div>
              <div><label htmlFor={`${blueprint.uid}-composition`} className="mb-1.5 block text-xs font-bold text-slate-400">构图 / 景别 / 机位 *</label><textarea id={`${blueprint.uid}-composition`} value={blueprint.composition} onChange={(event) => updateBlueprint(blueprint.uid, 'composition', event.target.value)} rows={2} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm leading-5 text-white" /></div>
              <div><label htmlFor={`${blueprint.uid}-moment`} className="mb-1.5 block text-xs font-bold text-slate-400">关键动作瞬间 *</label><textarea id={`${blueprint.uid}-moment`} value={blueprint.keyMoment} onChange={(event) => updateBlueprint(blueprint.uid, 'keyMoment', event.target.value)} rows={2} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm leading-5 text-white" /></div>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <div><label htmlFor={`${blueprint.uid}-props`} className="mb-1.5 block text-xs font-bold text-slate-400">道具 *</label><textarea id={`${blueprint.uid}-props`} value={blueprint.props} onChange={(event) => updateBlueprint(blueprint.uid, 'props', event.target.value)} rows={3} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm leading-5 text-white" /></div>
              <div><label htmlFor={`${blueprint.uid}-lighting`} className="mb-1.5 block text-xs font-bold text-slate-400">光线 / 时间 *</label><textarea id={`${blueprint.uid}-lighting`} value={blueprint.lighting} onChange={(event) => updateBlueprint(blueprint.uid, 'lighting', event.target.value)} rows={3} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm leading-5 text-white" /></div>
              <div><label htmlFor={`${blueprint.uid}-continuity`} className="mb-1.5 block text-xs font-bold text-slate-400">连续性约束 *</label><textarea id={`${blueprint.uid}-continuity`} value={blueprint.continuity} onChange={(event) => updateBlueprint(blueprint.uid, 'continuity', event.target.value)} rows={3} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm leading-5 text-white" /></div>
            </div>

            <div>
              <label htmlFor={`${blueprint.uid}-prompt`} className="mb-1.5 block text-xs font-bold text-cyan-300">图片生成 Prompt *</label>
              <textarea id={`${blueprint.uid}-prompt`} aria-label={`${blueprint.shotLabel} 图片生成 Prompt`} value={blueprint.imagePrompt} onChange={(event) => updateBlueprint(blueprint.uid, 'imagePrompt', event.target.value)} rows={5} className="w-full resize-y rounded-xl border border-cyan-500/25 bg-cyan-500/5 px-3 py-2.5 text-sm leading-6 text-cyan-50 outline-none focus:border-cyan-400/70" />
            </div>

            <div>
              <label htmlFor={`${blueprint.uid}-negative`} className="mb-1.5 block text-xs font-bold text-rose-300">负面约束 *</label>
              <textarea id={`${blueprint.uid}-negative`} value={blueprint.negativePrompt} onChange={(event) => updateBlueprint(blueprint.uid, 'negativePrompt', event.target.value)} rows={3} className="w-full resize-y rounded-xl border border-rose-500/20 bg-rose-500/5 px-3 py-2.5 text-sm leading-5 text-rose-50" />
            </div>
          </article>
        ))}
      </section>

      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}
      {message && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}

      <section className="flex flex-col gap-3 rounded-2xl border border-[#2D2D33] bg-[#111114] p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-black text-white">Step 3.1 门禁</div>
          <p className="mt-1 text-xs leading-5 text-slate-500">保存用于刷新恢复；只有人工“确认 Keyframe Blueprint”后才 PASS。任何字段修改都会自动取消 PASS。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={saveDraft} className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200"><Save className="h-4 w-4" /> 保存 Blueprint 修改</button>
          <button type="button" onClick={confirmDraft} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-black text-white"><CheckCircle2 className="h-4 w-4" /> 确认 Keyframe Blueprint</button>
        </div>
      </section>

      <section className="rounded-2xl border border-[#27272A] bg-[#111114] p-5 opacity-80">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-slate-500"><Sparkles className="h-4 w-4" /> NEXT · NOT IN THIS STAGE</div>
        <div className="mt-2 text-base font-black text-white">Step 3.2｜关键帧图片生成 / 上传</div>
        <p className="mt-2 text-xs leading-5 text-slate-500">Step 3.1 PASS 后再接图片模型或 ChatGPT 图片上传。本阶段零图片 Provider 调用、零 Veo 调用。</p>
      </section>
    </div>
  );
};
