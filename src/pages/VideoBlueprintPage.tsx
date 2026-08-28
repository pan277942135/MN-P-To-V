import React, { useMemo, useState } from 'react';
import { CheckCircle2, Film, LockKeyhole, RefreshCw, Save, ShieldAlert } from 'lucide-react';
import {
  KEYFRAME_BLUEPRINT_KEY,
  STORYBOARD_KEY,
  type KeyframeBlueprintDraft,
  type StoryboardForBlueprint,
} from '../services/director/keyframeBlueprint';
import { KEYFRAME_ASSET_KEY, type KeyframeAssetManifest } from '../services/director/keyframeAsset';
import {
  KEYFRAME_QA_APPROVAL_KEY,
  KEYFRAME_QA_KEY,
  type KeyframeQaApproval,
  type KeyframeQaManifest,
} from '../services/director/keyframeQa';
import {
  VIDEO_BLUEPRINT_APPROVAL_KEY,
  VIDEO_BLUEPRINT_KEY,
  buildVideoBlueprintApproval,
  buildVideoBlueprintDraft,
  cameraPresetLabel,
  isVideoBlueprintApprovalCurrent,
  normalizeVideoBlueprintDraft,
  refreshVideoBlueprintPrompt,
  videoBlueprintMatchesCurrentInputs,
  type VideoBlueprintApproval,
  type VideoBlueprintDraft,
  type VideoBlueprintItem,
  type VideoCameraPreset,
  type VeoDurationSeconds,
} from '../services/director/videoBlueprint';

interface InitialState {
  ready: boolean;
  reason: string;
  draft: VideoBlueprintDraft | null;
  approval: VideoBlueprintApproval | null;
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

function initializePage(): InitialState {
  const storyboard = safeParse<StoryboardForBlueprint>(STORYBOARD_KEY);
  const keyframeBlueprint = safeParse<KeyframeBlueprintDraft>(KEYFRAME_BLUEPRINT_KEY);
  const assets = safeParse<KeyframeAssetManifest>(KEYFRAME_ASSET_KEY);
  const qa = safeParse<KeyframeQaManifest>(KEYFRAME_QA_KEY);
  const qaApproval = safeParse<KeyframeQaApproval>(KEYFRAME_QA_APPROVAL_KEY);

  if (!storyboard || !keyframeBlueprint || !assets || !qa || !qaApproval) {
    return {
      ready: false,
      reason: '请先完成 Step 3.3：所有关键帧必须 AUTO QA PASS + 人工确认 PASS。',
      draft: null,
      approval: null,
      autoCreated: false,
    };
  }

  const stored = safeParse<VideoBlueprintDraft>(VIDEO_BLUEPRINT_KEY);
  if (videoBlueprintMatchesCurrentInputs({ draft: stored, keyframeBlueprint, assets, qa, qaApproval })) {
    const approval = safeParse<VideoBlueprintApproval>(VIDEO_BLUEPRINT_APPROVAL_KEY);
    return {
      ready: true,
      reason: '',
      draft: stored,
      approval: isVideoBlueprintApprovalCurrent(stored, approval) ? approval : null,
      autoCreated: false,
    };
  }

  try {
    const draft = buildVideoBlueprintDraft({ storyboard, keyframeBlueprint, assets, qa, qaApproval });
    window.localStorage.setItem(VIDEO_BLUEPRINT_KEY, JSON.stringify(draft));
    window.localStorage.removeItem(VIDEO_BLUEPRINT_APPROVAL_KEY);
    return { ready: true, reason: '', draft, approval: null, autoCreated: true };
  } catch (error: any) {
    return {
      ready: false,
      reason: error?.message || String(error),
      draft: null,
      approval: null,
      autoCreated: false,
    };
  }
}

const cameraOptions: Array<{ value: VideoCameraPreset; label: string }> = [
  { value: 'locked_camera', label: '固定机位' },
  { value: 'slow_push', label: '缓慢推进' },
  { value: 'slow_pull', label: '缓慢拉远' },
  { value: 'subtle_pan', label: '轻微横移 / 摇摄' },
  { value: 'tracking_shot', label: '平稳跟拍' },
  { value: 'vertical_boom', label: '平稳升降' },
];

export const VideoBlueprintPage: React.FC = () => {
  const initial = useMemo(() => initializePage(), []);
  const [draft, setDraft] = useState<VideoBlueprintDraft | null>(initial.draft);
  const [approval, setApproval] = useState<VideoBlueprintApproval | null>(initial.approval);
  const [message, setMessage] = useState(initial.autoCreated && initial.draft
    ? `Step 3.3 PASS 已读取，自动创建 ${initial.draft.items.length} 个 Video Blueprint。`
    : '');
  const [error, setError] = useState('');

  const invalidateApproval = () => {
    window.localStorage.removeItem(VIDEO_BLUEPRINT_APPROVAL_KEY);
    setApproval(null);
  };

  const updateItem = (shotUid: string, patch: Partial<VideoBlueprintItem>) => {
    if (!draft) return;
    setDraft({
      ...draft,
      items: draft.items.map((item) => item.shotUid === shotUid ? { ...item, ...patch } : item),
    });
    invalidateApproval();
    setMessage('');
    setError('');
  };

  const handleRefreshPrompt = (shotUid: string) => {
    if (!draft) return;
    const next = refreshVideoBlueprintPrompt(draft, shotUid, Date.now());
    setDraft(next);
    invalidateApproval();
    setMessage(`${next.items.find((item) => item.shotUid === shotUid)?.shotLabel || ''} 已根据当前动作 / 时长 / 机位重建 Prompt 草稿。`);
  };

  const handleSave = () => {
    if (!draft) return;
    try {
      const next = normalizeVideoBlueprintDraft(draft, Date.now());
      window.localStorage.setItem(VIDEO_BLUEPRINT_KEY, JSON.stringify(next));
      window.localStorage.removeItem(VIDEO_BLUEPRINT_APPROVAL_KEY);
      setDraft(next);
      setApproval(null);
      setError('');
      setMessage(`Step 4.1 已保存：${next.items.length} 个 Video Blueprint。`);
    } catch (cause: any) {
      setMessage('');
      setError(cause?.message || String(cause));
    }
  };

  const handleApprove = () => {
    if (!draft) return;
    try {
      const saved = normalizeVideoBlueprintDraft(draft, Date.now());
      const nextApproval = buildVideoBlueprintApproval(saved, Date.now());
      window.localStorage.setItem(VIDEO_BLUEPRINT_KEY, JSON.stringify(saved));
      window.localStorage.setItem(VIDEO_BLUEPRINT_APPROVAL_KEY, JSON.stringify(nextApproval));
      setDraft(saved);
      setApproval(nextApproval);
      setError('');
      setMessage('Step 4.1 Video Blueprint 已人工确认 PASS；Step 4.2 才允许进入 Veo 视频生成。');
    } catch (cause: any) {
      setMessage('');
      setError(cause?.message || String(cause));
    }
  };

  if (!initial.ready || !draft) {
    return (
      <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-amber-400"><Film className="h-4 w-4" /> Director Console · Step 4.1</div>
          <h1 className="text-2xl font-black text-white sm:text-3xl">视频蓝图｜Keyframe PASS → Video Blueprint</h1>
        </header>
        <section className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-6">
          <div className="flex items-start gap-3"><LockKeyhole className="mt-0.5 h-5 w-5 text-amber-300" /><div><div className="font-black text-amber-100">Step 4.1 尚未解锁</div><p className="mt-2 text-sm text-amber-100/70">{initial.reason}</p></div></div>
        </section>
      </div>
    );
  }

  const isPass = isVideoBlueprintApprovalCurrent(draft, approval);
  const riskCount = draft.items.filter((item) => item.identityDriftRisk === 'high').length;
  const storyboardTotal = draft.items.reduce((sum, item) => sum + item.storyboardDurationSeconds, 0);
  const productionTotal = draft.items.reduce((sum, item) => sum + item.productionDurationSeconds, 0);

  return (
    <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-sky-400"><Film className="h-4 w-4" /> Director Console · Step 4.1</div>
          <h1 className="text-2xl font-black text-white sm:text-3xl">视频蓝图｜Keyframe PASS → Video Blueprint</h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">把 Step 3.3 已通过的关键帧转换成逐镜视频生产任务。这里仅准备动作、机位、Veo 生产时长和 Motion Prompt，不调用 Veo。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300">STEP 3.3 · PASS</span>
          <span data-testid="video-blueprint-approval-status" className={`rounded-full border px-3 py-1.5 text-xs font-bold ${isPass ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-sky-500/30 bg-sky-500/10 text-sky-300'}`}>STEP 4.1 · {isPass ? 'PASS' : '待确认'}</span>
        </div>
      </header>

      <section className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4 sm:p-5">
        <div className="flex items-start gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" /><div><div className="text-sm font-black text-sky-100">NO VEO CALL</div><p className="mt-1 text-xs leading-5 text-sky-100/70">Step 4.1 不发起视频 Provider 请求。Veo 3.1 生产时长限定 4 / 6 / 8 秒；原 Storyboard 时长保留，超出的生成时长在后续剪辑阶段裁掉。</p></div></div>
      </section>

      <section className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">镜头数</div><div data-testid="video-blueprint-count" className="mt-1 text-2xl font-black text-white">{draft.items.length}</div></div>
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Storyboard</div><div className="mt-1 text-2xl font-black text-white">{storyboardTotal}s</div></div>
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Veo 原始素材</div><div className="mt-1 text-2xl font-black text-sky-300">{productionTotal}s</div></div>
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">高漂移风险</div><div className={`mt-1 text-2xl font-black ${riskCount ? 'text-red-300' : 'text-emerald-300'}`}>{riskCount}</div></div>
      </section>

      {message && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}
      {error && <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      <section className="space-y-5">
        {draft.items.map((item) => (
          <article key={item.uid} className="rounded-2xl border border-[#2D2D33] bg-[#111114] p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div><div className="flex items-center gap-2"><span className="font-mono text-sm font-black text-sky-300">{item.shotLabel}</span><span className="font-black text-white">{item.shotTitle}</span></div><div className="mt-1 text-[10px] font-mono text-slate-600">shot.uid: {item.shotUid}</div></div>
              <div className="flex flex-wrap gap-2"><span className="rounded-full border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400">Storyboard {item.storyboardDurationSeconds}s</span><span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-300">Veo {item.productionDurationSeconds}s</span><span className={`rounded-full border px-2.5 py-1 text-[11px] ${item.identityDriftRisk === 'high' ? 'border-red-500/30 bg-red-500/10 text-red-300' : item.identityDriftRisk === 'medium' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'}`}>身份漂移 {item.identityDriftRisk}</span></div>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2"><label className="mb-1.5 block text-xs font-bold text-slate-400" htmlFor={`${item.shotUid}-motion`}>{item.shotLabel} 主体动作</label><textarea id={`${item.shotUid}-motion`} aria-label={`${item.shotLabel} 主体动作`} rows={3} value={item.subjectMotion} onChange={(event) => updateItem(item.shotUid, { subjectMotion: event.target.value })} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" /></div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                <div><label className="mb-1.5 block text-xs font-bold text-slate-400">Veo 生产时长</label><select aria-label={`${item.shotLabel} Veo 生产时长`} value={item.productionDurationSeconds} onChange={(event) => updateItem(item.shotUid, { productionDurationSeconds: Number(event.target.value) as VeoDurationSeconds })} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white"><option value={4}>4 秒</option><option value={6}>6 秒</option><option value={8}>8 秒</option></select></div>
                <div><label className="mb-1.5 block text-xs font-bold text-slate-400">动作强度</label><select aria-label={`${item.shotLabel} 动作强度`} value={item.motionIntensity} onChange={(event) => updateItem(item.shotUid, { motionIntensity: event.target.value as VideoBlueprintItem['motionIntensity'] })} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white"><option value="minimal">minimal</option><option value="natural">natural</option><option value="expressive">expressive</option></select></div>
              </div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div><label className="mb-1.5 block text-xs font-bold text-slate-400">镜头运动</label><select aria-label={`${item.shotLabel} 镜头运动`} value={item.cameraPreset} onChange={(event) => updateItem(item.shotUid, { cameraPreset: event.target.value as VideoCameraPreset })} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white">{cameraOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><div className="mt-1 text-[10px] text-slate-600">当前：{cameraPresetLabel(item.cameraPreset)}</div></div>
              <div className="lg:col-span-2"><label className="mb-1.5 block text-xs font-bold text-slate-400">连续性约束</label><textarea aria-label={`${item.shotLabel} 连续性约束`} rows={2} value={item.continuity} onChange={(event) => updateItem(item.shotUid, { continuity: event.target.value })} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" /></div>
            </div>

            <div className="mt-4"><div className="mb-1.5 flex flex-wrap items-center justify-between gap-2"><label className="text-xs font-bold text-slate-400">Veo Motion Prompt 草稿</label><button type="button" onClick={() => handleRefreshPrompt(item.shotUid)} className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 text-xs font-bold text-sky-200"><RefreshCw className="h-3.5 w-3.5" /> 根据当前字段重建</button></div><textarea aria-label={`${item.shotLabel} Veo Motion Prompt 草稿`} rows={8} value={item.providerPromptDraft} onChange={(event) => updateItem(item.shotUid, { providerPromptDraft: event.target.value })} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 font-mono text-xs leading-5 text-slate-200" /></div>

            <div className="mt-4"><label className="mb-1.5 block text-xs font-bold text-slate-400">负面约束</label><textarea aria-label={`${item.shotLabel} 负面约束`} rows={2} value={item.negativeConstraints} onChange={(event) => updateItem(item.shotUid, { negativeConstraints: event.target.value })} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-xs text-slate-300" /></div>

            {item.trimHintSeconds > 0 && <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">后续剪辑提示：该镜计划 {item.storyboardDurationSeconds}s，Veo 生成 {item.productionDurationSeconds}s，预计裁掉约 {item.trimHintSeconds}s。</div>}
            {item.riskWarnings.length > 0 && <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs leading-5 text-red-200">{item.riskWarnings.map((warning) => <div key={warning}>• {warning}</div>)}</div>}
          </article>
        ))}
      </section>

      <div className="sticky bottom-3 z-10 flex flex-wrap justify-end gap-3 rounded-2xl border border-[#2D2D33] bg-[#111114]/95 p-3 backdrop-blur">
        <button onClick={handleSave} className="inline-flex items-center gap-2 rounded-xl border border-slate-600/40 bg-slate-800/50 px-4 py-2.5 text-sm font-black text-slate-200"><Save className="h-4 w-4" /> 保存 Video Blueprint</button>
        <button onClick={handleApprove} className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-2.5 text-sm font-black text-emerald-200"><CheckCircle2 className="h-4 w-4" /> 确认 Video Blueprint</button>
      </div>

      <footer className="rounded-2xl border border-[#2D2D33] bg-[#111114] p-4 text-xs leading-5 text-slate-500">Step 4.1 PASS 只代表逐镜视频生产参数已确认；不会创建 Veo 任务。Step 4.2 必须读取当前 Video Blueprint PASS 才允许发起真实视频生成。</footer>
    </div>
  );
};
