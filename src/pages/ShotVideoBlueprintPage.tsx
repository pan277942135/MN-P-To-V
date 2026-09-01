import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Film, LockKeyhole, RefreshCw, Save } from 'lucide-react';
import { useProjectSession } from '../context/ProjectSessionContext';
import { assetPreviewContentUrl } from '../services/assetRegistry/assetRegistryClient';
import {
  analyzeVideoBlueprintRisk,
  buildProviderPromptDraft,
  cameraPresetLabel,
  type VeoDurationSeconds,
  type VideoCameraPreset,
} from '../services/director/videoBlueprint';
import {
  persistShotVideoBlueprints,
  syncLocalShotPipeline,
  type ShotVideoBlueprintItem,
  type ShotVideoBlueprintManifest,
} from '../services/director/shotProductionWorkflow';

const cameraOptions: Array<{ value: VideoCameraPreset; label: string }> = [
  { value: 'locked_camera', label: '固定机位' },
  { value: 'slow_push', label: '缓慢推进' },
  { value: 'slow_pull', label: '缓慢拉远' },
  { value: 'subtle_pan', label: '轻微横移 / 摇摄' },
  { value: 'tracking_shot', label: '平稳跟拍' },
  { value: 'vertical_boom', label: '平稳升降' },
];

function refreshItem(item: ShotVideoBlueprintItem): ShotVideoBlueprintItem {
  const risk = analyzeVideoBlueprintRisk({
    subjectMotion: item.subjectMotion,
    durationSeconds: item.productionDurationSeconds,
    motionIntensity: item.motionIntensity,
  });
  return {
    ...item,
    trimHintSeconds: Math.max(0, item.productionDurationSeconds - item.storyboardDurationSeconds),
    providerPromptDraft: buildProviderPromptDraft({
      subjectMotion: item.subjectMotion,
      durationSeconds: item.productionDurationSeconds,
      cameraPreset: item.cameraPreset,
    }),
    ...risk,
    status: 'DRAFT',
    approvedAt: null,
    savedAt: Date.now(),
  };
}

export const ShotVideoBlueprintPage: React.FC = () => {
  const {
    projectId: sessionProjectId,
    episodeId: sessionEpisodeId,
    assets: registryAssets,
  } = useProjectSession();
  const [initial, setInitial] = useState(() => syncLocalShotPipeline());
  const [manifest, setManifest] = useState<ShotVideoBlueprintManifest | null>(initial?.videos || null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const assetByShot = useMemo(
    () => new Map((initial?.assets.assets || []).map((asset) => [asset.shotUid, asset])),
    [initial?.assets],
  );
  const itemByShot = useMemo(
    () => new Map((manifest?.items || []).map((item) => [item.shotUid, item])),
    [manifest],
  );
  const generatedVideoAssets = useMemo(
    () => registryAssets.filter((asset) => (
      asset.assetType === 'VIDEO'
      && asset.mediaType === 'GENERATED_VIDEO'
      && asset.status !== 'DELETED'
      && (!sessionEpisodeId || asset.episodeId === sessionEpisodeId)
    )),
    [registryAssets, sessionEpisodeId],
  );

  useEffect(() => {
    if (!sessionProjectId) return;
    const next = syncLocalShotPipeline();
    setInitial(next);
    setManifest(next?.videos || null);
  }, [sessionEpisodeId, sessionProjectId]);

  const persist = (next: ShotVideoBlueprintManifest) => {
    const saved = persistShotVideoBlueprints(next);
    setManifest(saved);
  };

  const updateItem = (shotUid: string, patch: Partial<ShotVideoBlueprintItem>) => {
    if (!manifest) return;
    const next: ShotVideoBlueprintManifest = {
      ...manifest,
      items: manifest.items.map((item) => item.shotUid === shotUid
        ? { ...item, ...patch, status: 'DRAFT', approvedAt: null, savedAt: Date.now() }
        : item),
      savedAt: Date.now(),
    };
    persist(next);
    setMessage('');
    setError('');
  };

  const rebuildPrompt = (shotUid: string) => {
    if (!manifest) return;
    const next = {
      ...manifest,
      items: manifest.items.map((item) => item.shotUid === shotUid ? refreshItem(item) : item),
      savedAt: Date.now(),
    };
    persist(next);
    setMessage(`${next.items.find((item) => item.shotUid === shotUid)?.shotLabel || ''} Motion Prompt 已按当前参数重建。`);
  };

  const approveItem = (shotUid: string) => {
    if (!manifest) return;
    const target = manifest.items.find((item) => item.shotUid === shotUid);
    if (!target) return;
    if (!target.subjectMotion.trim() || !target.providerPromptDraft.trim()) {
      setError(`${target.shotLabel} 主体动作或 Motion Prompt 为空。`);
      return;
    }
    const next: ShotVideoBlueprintManifest = {
      ...manifest,
      items: manifest.items.map((item) => item.shotUid === shotUid
        ? { ...item, status: 'PASS', approvedAt: Date.now(), savedAt: Date.now() }
        : item),
      savedAt: Date.now(),
    };
    persist(next);
    setError('');
    setMessage(`${target.shotLabel} 视频蓝图已人工 PASS；该 Shot 已具备进入 Step 4.2 视频生成的条件，不等待其他镜头。`);
  };

  if (!initial || !manifest) {
    return (
      <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header><div className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-amber-400">Shot Production</div><h1 className="text-2xl font-black text-white">视频蓝图｜逐 Shot 并行准备</h1></header>
        <section className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-6 text-sm text-amber-100/80">请先准备至少一个 Storyboard Shot。关键帧不需要全部完成。</section>
      </div>
    );
  }

  const eligibleCount = initial.assets.assets.filter((asset) => asset.status === 'PASS').length;
  const blueprintPassCount = manifest.items.filter((item) => item.status === 'PASS').length;

  return (
    <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-sky-400"><Film className="h-4 w-4" /> Shot Production · Video Blueprint</div>
          <h1 className="text-2xl font-black text-white sm:text-3xl">视频蓝图｜逐 Shot 并行准备</h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">不再等待“全量关键帧 PASS”。任一 Shot 的关键帧人工 PASS 后，该镜立即解锁视频蓝图；其他 Shot 可以同时继续出图、调整剧情或人工验帧。</p>
        </div>
        <div className="flex flex-wrap gap-2"><span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300">Keyframe PASS {eligibleCount}</span><span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-300">Video Blueprint PASS {blueprintPassCount}</span><span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-xs font-bold text-violet-300">Registry Video {generatedVideoAssets.length}</span></div>
      </header>

      <section className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4 text-xs leading-5 text-sky-100/75">本页仍然 <span className="font-black">NO VEO CALL</span>。只是逐镜准备动作、机位、4/6/8 秒生产时长和 Motion Prompt。Step 4.2 将直接消费每个 <span className="font-mono">status=PASS</span> 的 Shot。</section>

      {message && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}
      {error && <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      {generatedVideoAssets.length > 0 && (
        <section className="space-y-3 rounded-2xl border border-violet-500/20 bg-violet-500/[0.035] p-4 sm:p-5" data-testid="generated-video-assets">
          <div className="flex items-center justify-between gap-3">
            <div><div className="text-[11px] font-bold uppercase tracking-[0.18em] text-violet-300">Asset Registry · GENERATED_VIDEO</div><h2 className="mt-1 text-lg font-black text-white">已生成视频资产</h2></div>
            <div className="text-xs text-slate-500">统一读取 Project Session</div>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {generatedVideoAssets.map((asset) => (
              <article key={asset.assetId} className="overflow-hidden rounded-xl border border-[#303036] bg-[#09090B]">
                <video src={assetPreviewContentUrl(asset.assetId, 'video-preview')} poster={asset.preview?.framePaths?.length ? assetPreviewContentUrl(asset.assetId, 'frame', 1) : undefined} controls preload="metadata" className="aspect-video w-full object-contain" aria-label={asset.relations.description || asset.assetId} />
                <div className="p-3"><div className="font-mono text-xs font-black text-violet-300">{asset.shotUid}</div><div className="mt-1 truncate text-sm font-bold text-white">{asset.relations.description || asset.relations.shotPurpose || asset.assetId}</div><div className="mt-1 text-[10px] text-slate-500">{asset.metadata.durationSeconds ? asset.metadata.durationSeconds + 's' : '视频资产'} · {asset.review.status}</div></div>
                {(asset.preview?.framePaths?.length || 0) > 0 && <div className="grid grid-cols-5 gap-1 border-t border-[#303036] p-2">{asset.preview?.framePaths.slice(0, 5).map((_, index) => <img key={index} src={assetPreviewContentUrl(asset.assetId, 'frame', index + 1)} alt={asset.shotUid + ' frame ' + (index + 1)} className="aspect-video w-full rounded object-cover" loading="lazy" />)}</div>}
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-5">
        {initial.storyboard.shots.map((shot, index) => {
          const shotLabel = `S${String(index + 1).padStart(2, '0')}`;
          const asset = assetByShot.get(shot.uid);
          const item = itemByShot.get(shot.uid);
          if (!asset || asset.status !== 'PASS' || !item) {
            return (
              <article key={shot.uid} className="rounded-2xl border border-[#2D2D33] bg-[#111114] p-5 opacity-75">
                <div className="flex items-start gap-3"><LockKeyhole className="mt-0.5 h-5 w-5 text-slate-500" /><div><div className="font-mono text-sm font-black text-slate-400">{shotLabel} · {shot.title || '未命名镜头'}</div><p className="mt-1 text-xs text-slate-500">该镜关键帧尚未人工 PASS；不会影响其他已 PASS Shot 继续制作视频。</p></div></div>
              </article>
            );
          }

          return (
            <article key={item.uid} className="space-y-4 rounded-2xl border border-[#2D2D33] bg-[#111114] p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><div className="flex items-center gap-2"><span className="font-mono text-sm font-black text-sky-300">{item.shotLabel}</span><span className="font-black text-white">{item.shotTitle}</span></div><div className="mt-1 text-[10px] font-mono text-slate-600">shot.uid: {item.shotUid}</div></div>
                <div className="flex gap-2"><span className="rounded-full border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400">Storyboard {item.storyboardDurationSeconds}s</span><span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-300">Veo {item.productionDurationSeconds}s</span><span className={`rounded-full border px-2.5 py-1 text-[11px] ${item.status === 'PASS' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>{item.status}</span></div>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <div className="lg:col-span-2"><label className="mb-1.5 block text-xs font-bold text-slate-400">主体动作</label><textarea rows={3} value={item.subjectMotion} onChange={(event) => updateItem(item.shotUid, { subjectMotion: event.target.value })} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" /></div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                  <div><label className="mb-1.5 block text-xs font-bold text-slate-400">Veo 生产时长</label><select value={item.productionDurationSeconds} onChange={(event) => updateItem(item.shotUid, { productionDurationSeconds: Number(event.target.value) as VeoDurationSeconds })} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white"><option value={4}>4 秒</option><option value={6}>6 秒</option><option value={8}>8 秒</option></select></div>
                  <div><label className="mb-1.5 block text-xs font-bold text-slate-400">动作强度</label><select value={item.motionIntensity} onChange={(event) => updateItem(item.shotUid, { motionIntensity: event.target.value as ShotVideoBlueprintItem['motionIntensity'] })} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white"><option value="minimal">minimal</option><option value="natural">natural</option><option value="expressive">expressive</option></select></div>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div><label className="mb-1.5 block text-xs font-bold text-slate-400">镜头运动</label><select value={item.cameraPreset} onChange={(event) => updateItem(item.shotUid, { cameraPreset: event.target.value as VideoCameraPreset })} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white">{cameraOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><div className="mt-1 text-[10px] text-slate-600">当前：{cameraPresetLabel(item.cameraPreset)}</div></div>
                <div><label className="mb-1.5 block text-xs font-bold text-slate-400">连续性约束</label><textarea rows={3} value={item.continuity} onChange={(event) => updateItem(item.shotUid, { continuity: event.target.value })} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" /></div>
              </div>

              <div><label className="mb-1.5 block text-xs font-bold text-slate-400">Veo Motion Prompt</label><textarea rows={5} value={item.providerPromptDraft} onChange={(event) => updateItem(item.shotUid, { providerPromptDraft: event.target.value })} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 font-mono text-xs leading-5 text-slate-200" /></div>
              <div><label className="mb-1.5 block text-xs font-bold text-slate-400">负面约束</label><textarea rows={2} value={item.negativeConstraints} onChange={(event) => updateItem(item.shotUid, { negativeConstraints: event.target.value })} className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-xs text-slate-300" /></div>

              {item.riskWarnings.length > 0 && <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-amber-100/80">身份漂移风险：{item.identityDriftRisk}。{item.riskWarnings.join('；')}</div>}
              {item.trimHintSeconds > 0 && <div className="text-xs text-slate-500">原分镜 {item.storyboardDurationSeconds}s，Veo 生产 {item.productionDurationSeconds}s；后续剪辑建议裁约 {item.trimHintSeconds}s。</div>}

              <div className="flex flex-wrap gap-2 border-t border-[#2D2D33] pt-4">
                <button onClick={() => rebuildPrompt(item.shotUid)} className="inline-flex items-center gap-2 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-sm font-bold text-sky-200"><RefreshCw className="h-4 w-4" /> 根据当前字段重建</button>
                <button onClick={() => persist(manifest)} className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200"><Save className="h-4 w-4" /> 保存</button>
                <button disabled={item.status === 'PASS'} onClick={() => approveItem(item.shotUid)} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-black text-white disabled:opacity-35"><CheckCircle2 className="h-4 w-4" /> 确认本镜 Video Blueprint</button>
                {item.status === 'PASS' && <span className="inline-flex items-center rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-300">本镜可进入 Step 4.2</span>}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
};
