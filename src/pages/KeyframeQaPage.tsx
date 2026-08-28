import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  ThumbsDown,
} from 'lucide-react';
import { characterRepository } from '../repositories/characterRepository';
import type { CharacterProfile } from '../types';
import { getRefImageUrl, refToBlob } from '../utils/imageHelper';
import {
  KEYFRAME_BLUEPRINT_APPROVAL_KEY,
  KEYFRAME_BLUEPRINT_KEY,
  type KeyframeBlueprintApproval,
  type KeyframeBlueprintDraft,
} from '../services/director/keyframeBlueprint';
import {
  KEYFRAME_ASSET_APPROVAL_KEY,
  KEYFRAME_ASSET_KEY,
  approveKeyframeAsset,
  buildKeyframeAssetApproval,
  isKeyframeAssetManifestComplete,
  isKeyframeBlueprintApprovalCurrent,
  manifestMatchesCurrentBlueprint,
  revokeKeyframeAssetPass,
  type KeyframeAssetManifest,
} from '../services/director/keyframeAsset';
import { keyframeAssetStore } from '../services/director/keyframeAssetStore';
import { blobToBase64 } from '../services/director/geminiKeyframeImageClient';
import { runKeyframeQa } from '../services/director/geminiKeyframeQaClient';
import {
  KEYFRAME_QA_APPROVAL_KEY,
  KEYFRAME_QA_KEY,
  approveKeyframeQa,
  attachKeyframeQaReport,
  buildKeyframeQaApproval,
  buildKeyframeQaManifest,
  isKeyframeQaComplete,
  rejectKeyframeQa,
  syncKeyframeQaManifest,
  updateKeyframeQaHumanNote,
  type KeyframeQaManifest,
  type KeyframeQaReport,
} from '../services/director/keyframeQa';

interface PageState {
  ready: boolean;
  reason: string;
  blueprint: KeyframeBlueprintDraft | null;
  assets: KeyframeAssetManifest | null;
  qa: KeyframeQaManifest | null;
  invalidatedCount: number;
}

function safeParse<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function persistAssets(manifest: KeyframeAssetManifest) {
  window.localStorage.setItem(KEYFRAME_ASSET_KEY, JSON.stringify(manifest));
  if (isKeyframeAssetManifestComplete(manifest)) {
    window.localStorage.setItem(KEYFRAME_ASSET_APPROVAL_KEY, JSON.stringify(buildKeyframeAssetApproval(manifest)));
  } else {
    window.localStorage.removeItem(KEYFRAME_ASSET_APPROVAL_KEY);
  }
}

function initializePage(): PageState {
  const blueprint = safeParse<KeyframeBlueprintDraft>(KEYFRAME_BLUEPRINT_KEY);
  const blueprintApproval = safeParse<KeyframeBlueprintApproval>(KEYFRAME_BLUEPRINT_APPROVAL_KEY);
  if (!blueprint || !blueprintApproval || !isKeyframeBlueprintApprovalCurrent(blueprint, blueprintApproval)) {
    return { ready: false, reason: '请先完成 Step 3.1，并确认当前 Keyframe Blueprint PASS。', blueprint: null, assets: null, qa: null, invalidatedCount: 0 };
  }

  let assets = safeParse<KeyframeAssetManifest>(KEYFRAME_ASSET_KEY);
  if (!assets || !manifestMatchesCurrentBlueprint(assets, blueprint, blueprintApproval)) {
    return { ready: false, reason: '请先进入 Step 3.2，为当前 Blueprint 生成或上传关键帧图片。', blueprint, assets: null, qa: null, invalidatedCount: 0 };
  }

  const storedQa = safeParse<KeyframeQaManifest>(KEYFRAME_QA_KEY);
  const synced = storedQa
    ? syncKeyframeQaManifest({ current: storedQa, blueprint, assets })
    : { manifest: buildKeyframeQaManifest({ blueprint, assets }), invalidatedShotUids: [] as string[] };

  if (synced.invalidatedShotUids.length > 0) {
    for (const shotUid of synced.invalidatedShotUids) {
      assets = revokeKeyframeAssetPass(assets, shotUid);
    }
    persistAssets(assets);
    window.localStorage.removeItem(KEYFRAME_QA_APPROVAL_KEY);
  }
  window.localStorage.setItem(KEYFRAME_QA_KEY, JSON.stringify(synced.manifest));

  return {
    ready: true,
    reason: '',
    blueprint,
    assets,
    qa: synced.manifest,
    invalidatedCount: synced.invalidatedShotUids.length,
  };
}

async function loadReferenceBlobs(character: CharacterProfile | undefined): Promise<Blob[]> {
  if (!character?.referenceImages?.length) return [];
  const results: Blob[] = [];
  for (const ref of character.referenceImages.slice(0, 4)) {
    const local = await refToBlob(ref);
    if (local) {
      results.push(local);
      continue;
    }
    const url = getRefImageUrl(ref);
    if (!url || !/^https?:\/\//.test(url)) continue;
    try {
      const response = await fetch(url);
      if (response.ok) results.push(await response.blob());
    } catch {
      // keep remaining references available
    }
  }
  return results;
}

function scoreTone(value: number | null, threshold: number) {
  if (value === null) return 'text-slate-500';
  return value >= threshold ? 'text-emerald-300' : 'text-red-300';
}

function ReportScores({ report }: { report: KeyframeQaReport }) {
  const rows = [
    ['身份一致性', report.scores.identityScore, 95, report.identityAssessed],
    ['Prompt 符合', report.scores.promptComplianceScore, 90, true],
    ['肢体解剖', report.scores.anatomyScore, 92, true],
    ['画面质量', report.scores.visualQualityScore, 90, true],
    ['构图稳定', report.scores.compositionScore, 88, true],
    ['相邻镜连续性', report.scores.continuityScore, 90, report.continuityAssessed],
  ] as Array<[string, number | null, number, boolean]>;

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map(([label, value, threshold, assessed]) => (
        <div key={label} className="rounded-lg border border-[#2D2D33] bg-[#09090B] p-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
          <div className={`mt-1 text-lg font-black ${scoreTone(assessed ? value : null, threshold)}`}>
            {assessed && value !== null ? `${value}` : '未评估'}
          </div>
          <div className="text-[10px] text-slate-600">{assessed ? `门槛 ≥ ${threshold}` : '无对应参考输入，不参与 Gate'}</div>
        </div>
      ))}
    </div>
  );
}

export const KeyframeQaPage: React.FC = () => {
  const initial = useMemo(() => initializePage(), []);
  const [assets, setAssets] = useState<KeyframeAssetManifest | null>(initial.assets);
  const [qa, setQa] = useState<KeyframeQaManifest | null>(initial.qa);
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [busyShot, setBusyShot] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [message, setMessage] = useState(initial.invalidatedCount > 0 ? `检测到 ${initial.invalidatedCount} 个旧 QA 与当前图片/相邻镜输入不一致，已自动失效。` : '');
  const [error, setError] = useState('');
  const [capabilities, setCapabilities] = useState({ keyframeQaEnabled: false, keyframeQaModel: '' });

  const blueprintByShot = useMemo(() => new Map((initial.blueprint?.blueprints || []).map((item) => [item.shotUid, item])), [initial.blueprint]);

  const saveAssets = (next: KeyframeAssetManifest) => {
    persistAssets(next);
    setAssets(next);
  };
  const saveQa = (next: KeyframeQaManifest) => {
    window.localStorage.setItem(KEYFRAME_QA_KEY, JSON.stringify(next));
    if (isKeyframeQaComplete(next)) {
      window.localStorage.setItem(KEYFRAME_QA_APPROVAL_KEY, JSON.stringify(buildKeyframeQaApproval(next)));
    } else {
      window.localStorage.removeItem(KEYFRAME_QA_APPROVAL_KEY);
    }
    setQa(next);
  };

  useEffect(() => {
    characterRepository.getAll().then(setCharacters).catch(() => setCharacters([]));
    fetch('/api/director/capabilities')
      .then((response) => response.json())
      .then((payload) => setCapabilities({
        keyframeQaEnabled: payload?.keyframeQaEnabled === true,
        keyframeQaModel: String(payload?.keyframeQaModel || ''),
      }))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    async function restore() {
      if (!assets) return;
      const next: Record<string, string> = {};
      for (const asset of assets.assets) {
        if (!asset.blobKey) continue;
        const blob = await keyframeAssetStore.get(asset.blobKey).catch(() => null);
        if (!blob || cancelled) continue;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        next[asset.shotUid] = url;
      }
      if (!cancelled) setPreviews(next);
    }
    restore();
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [assets?.sourceBlueprintSavedAt]);

  const analyzeShot = async (shotUid: string): Promise<KeyframeQaReport> => {
    if (!assets || !qa || !initial.blueprint) throw new Error('Step 3.3 状态未准备。');
    const index = assets.assets.findIndex((asset) => asset.shotUid === shotUid);
    const asset = assets.assets[index];
    const blueprint = blueprintByShot.get(shotUid);
    if (!asset?.blobKey || !blueprint) throw new Error(`${asset?.shotLabel || shotUid} 尚无关键帧图片。`);

    const candidate = await keyframeAssetStore.get(asset.blobKey);
    if (!candidate) throw new Error(`${asset.shotLabel} 图片二进制资产已丢失，请回 Step 3.2 重新上传/生成。`);
    const candidateImageBase64 = await blobToBase64(candidate);

    const character = characters.find((item) => item.id === asset.characterId);
    const referenceBlobs = await loadReferenceBlobs(character);
    const masterReferences = await Promise.all(referenceBlobs.map(async (blob) => ({
      imageBase64: await blobToBase64(blob),
      mimeType: blob.type || 'image/jpeg',
    })));

    const previousAsset = index > 0 ? assets.assets[index - 1] : undefined;
    let previousKeyframe: { imageBase64: string; mimeType: string } | null = null;
    if (index > 0) {
      if (!previousAsset?.blobKey) throw new Error(`${asset.shotLabel} 需要上一镜关键帧才能做连续性 QA。`);
      const previousBlob = await keyframeAssetStore.get(previousAsset.blobKey);
      if (!previousBlob) throw new Error(`${previousAsset.shotLabel} 上一镜图片资产已丢失。`);
      previousKeyframe = {
        imageBase64: await blobToBase64(previousBlob),
        mimeType: previousBlob.type || 'image/png',
      };
    }

    const characterHint = character
      ? [character.name, character.description, JSON.stringify(character.identitySpec || {})].filter(Boolean).join('；')
      : blueprint.characterReference;

    return await runKeyframeQa({
      shotLabel: asset.shotLabel,
      prompt: blueprint.imagePrompt,
      continuity: [blueprint.characterState, blueprint.props, blueprint.continuity].filter(Boolean).join('；'),
      candidateImageBase64,
      candidateMimeType: candidate.type || asset.mimeType || 'image/png',
      characterHint,
      masterReferences,
      previousKeyframe,
    });
  };

  const applyReport = (shotUid: string, report: KeyframeQaReport, currentQa: KeyframeQaManifest, currentAssets: KeyframeAssetManifest) => {
    const nextQa = attachKeyframeQaReport(currentQa, shotUid, report);
    const nextAssets = report.pass ? revokeKeyframeAssetPass(currentAssets, shotUid) : revokeKeyframeAssetPass(currentAssets, shotUid);
    return { nextQa, nextAssets };
  };

  const handleAnalyze = async (shotUid: string) => {
    if (!qa || !assets || !capabilities.keyframeQaEnabled) return;
    setBusyShot(shotUid);
    setError('');
    setMessage('');
    try {
      const report = await analyzeShot(shotUid);
      const { nextQa, nextAssets } = applyReport(shotUid, report, qa, assets);
      saveAssets(nextAssets);
      saveQa(nextQa);
      setMessage(`${nextQa.items.find((item) => item.shotUid === shotUid)?.shotLabel || ''} 自动 QA ${report.pass ? 'PASS，等待人工复核' : '未通过，请按修复指令重做'}。`);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setBusyShot('');
    }
  };

  const handleBatch = async () => {
    if (!qa || !assets || !capabilities.keyframeQaEnabled) return;
    const candidates = qa.items.filter((item) => Boolean(item.assetBlobKey) && item.humanDecision !== 'APPROVED');
    if (!candidates.length) return;
    if (!window.confirm(`将按镜头顺序执行 ${candidates.length} 次 Gemini 自动 QA，每镜一次 Provider 调用。确认继续？`)) return;

    setBatchBusy(true);
    setError('');
    setMessage('');
    let nextQa = qa;
    let nextAssets = assets;
    try {
      for (const item of candidates) {
        setBusyShot(item.shotUid);
        const report = await analyzeShot(item.shotUid);
        const applied = applyReport(item.shotUid, report, nextQa, nextAssets);
        nextQa = applied.nextQa;
        nextAssets = applied.nextAssets;
        window.localStorage.setItem(KEYFRAME_QA_KEY, JSON.stringify(nextQa));
        persistAssets(nextAssets);
      }
      saveAssets(nextAssets);
      saveQa(nextQa);
      setMessage(`批量自动 QA 已完成 ${candidates.length} 镜；请逐镜人工复核 PASS/重做。`);
    } catch (cause: any) {
      saveAssets(nextAssets);
      saveQa(nextQa);
      setError(cause?.message || String(cause));
    } finally {
      setBusyShot('');
      setBatchBusy(false);
    }
  };

  const handleApprove = (shotUid: string) => {
    if (!qa || !assets) return;
    try {
      const nextQa = approveKeyframeQa(qa, shotUid);
      const nextAssets = approveKeyframeAsset(assets, shotUid);
      saveAssets(nextAssets);
      saveQa(nextQa);
      setError('');
      setMessage(isKeyframeQaComplete(nextQa) ? 'Step 3.3 全部关键帧已完成自动 QA + 人工确认 PASS。' : `${nextQa.items.find((item) => item.shotUid === shotUid)?.shotLabel || ''} 已人工确认 PASS。`);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    }
  };

  const handleReject = (shotUid: string) => {
    if (!qa || !assets) return;
    const nextQa = rejectKeyframeQa(qa, shotUid);
    const nextAssets = revokeKeyframeAssetPass(assets, shotUid);
    saveAssets(nextAssets);
    saveQa(nextQa);
    setMessage(`${nextQa.items.find((item) => item.shotUid === shotUid)?.shotLabel || ''} 已标记需重做；请回 Step 3.2 替换或重新生成图片。`);
  };

  const handleNote = (shotUid: string, humanNote: string) => {
    if (!qa || !assets) return;
    const wasApproved = qa.items.find((item) => item.shotUid === shotUid)?.humanDecision === 'APPROVED';
    const nextQa = updateKeyframeQaHumanNote(qa, shotUid, humanNote);
    const nextAssets = wasApproved ? revokeKeyframeAssetPass(assets, shotUid) : assets;
    if (wasApproved) saveAssets(nextAssets);
    saveQa(nextQa);
  };

  if (!initial.ready || !initial.blueprint || !assets || !qa) {
    return (
      <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header><div className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-amber-400">Director Console · Step 3.3</div><h1 className="text-2xl font-black text-white sm:text-3xl">关键帧自动 QA｜身份一致性 / 连续性 / 画面质量</h1></header>
        <section className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-6 text-sm text-amber-100/80">{initial.reason}</section>
      </div>
    );
  }

  const autoPass = qa.items.filter((item) => item.autoStatus === 'PASS').length;
  const humanPass = qa.items.filter((item) => item.humanDecision === 'APPROVED').length;
  const finalPass = isKeyframeQaComplete(qa);

  return (
    <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-cyan-400"><ScanSearch className="h-4 w-4" /> Director Console · Step 3.3</div>
          <h1 className="text-2xl font-black text-white sm:text-3xl">关键帧自动 QA｜身份一致性 / 连续性 / 画面质量</h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">自动 QA 比对当前关键帧、角色母板（若已选择）和上一镜关键帧，并读取 Blueprint 连续性约束。AI PASS 后仍必须人工复核；替换当前图、上一镜图或角色母板会使相关 QA 自动失效。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300">STEP 3.1 · PASS</span>
          <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-xs font-bold text-violet-300">STEP 3.2 · ASSETS</span>
          <span className={`rounded-full border px-3 py-1.5 text-xs font-bold ${finalPass ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'}`}>STEP 3.3 · {finalPass ? 'PASS' : `${humanPass}/${qa.items.length}`}</span>
        </div>
      </header>

      <section className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" /><div><div className="text-sm font-black text-cyan-100">QA Provider：{capabilities.keyframeQaEnabled ? `Vertex AI Gemini / ${capabilities.keyframeQaModel}` : '未启用'}</div><p className="mt-1 text-xs leading-5 text-cyan-100/70">单镜“自动 QA”= 1 次显式 Provider 调用；失败不会自动重试。批量模式会先明确显示调用镜数并要求确认。</p></div></div>
          <button disabled={batchBusy || !capabilities.keyframeQaEnabled} onClick={handleBatch} className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-500/35 bg-cyan-500/10 px-4 py-2.5 text-sm font-black text-cyan-200 disabled:opacity-40">{batchBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />} 批量自动 QA</button>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">总镜数</div><div className="mt-1 text-2xl font-black text-white">{qa.items.length}</div></div>
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">AUTO PASS</div><div className="mt-1 text-2xl font-black text-cyan-300">{autoPass}</div></div>
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">HUMAN PASS</div><div className="mt-1 text-2xl font-black text-emerald-300">{humanPass}</div></div>
      </section>

      {message && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}
      {error && <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      <section className="space-y-5">
        {qa.items.map((item, index) => {
          const asset = assets.assets.find((value) => value.shotUid === item.shotUid);
          const blueprint = blueprintByShot.get(item.shotUid);
          const report = item.report;
          const busy = busyShot === item.shotUid;
          return (
            <article key={item.uid} className="grid gap-5 rounded-2xl border border-[#2D2D33] bg-[#111114] p-4 sm:p-5 xl:grid-cols-[260px_1fr]">
              <div className="space-y-3">
                <div className="aspect-[9/16] overflow-hidden rounded-xl border border-[#303036] bg-[#09090B]">
                  {previews[item.shotUid] ? <img src={previews[item.shotUid]} alt={`${item.shotLabel} QA`} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs text-slate-600">Step 3.2 尚无图片</div>}
                </div>
                <div className="flex items-center justify-between"><span className="font-mono text-sm font-black text-cyan-300">{item.shotLabel}</span><span className={`text-xs font-black ${item.humanDecision === 'APPROVED' ? 'text-emerald-300' : item.autoStatus === 'PASS' ? 'text-cyan-300' : item.autoStatus === 'FAIL' ? 'text-red-300' : 'text-slate-500'}`}>{item.humanDecision === 'APPROVED' ? 'HUMAN PASS' : item.autoStatus}</span></div>
                {index > 0 && <div className="text-[10px] text-slate-600">连续性参考：{qa.items[index - 1]?.shotLabel}</div>}
                <div className="text-[10px] text-slate-600">角色母板：{asset?.characterId ? characters.find((character) => character.id === asset.characterId)?.name || asset.characterId : '未选择（身份不参与自动 Gate）'}</div>
              </div>

              <div className="space-y-4">
                <div><div className="text-sm font-black text-white">{blueprint?.shotTitle || item.shotLabel}</div><p className="mt-1 text-xs leading-5 text-slate-500">{blueprint?.continuity}</p></div>

                {report ? (
                  <>
                    <ReportScores report={report} />
                    <div className={`rounded-xl border p-3 ${report.pass ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-red-500/25 bg-red-500/5'}`}>
                      <div className={`text-sm font-black ${report.pass ? 'text-emerald-200' : 'text-red-200'}`}>{report.pass ? 'AUTO QA PASS' : 'AUTO QA FAIL'} · {report.summary}</div>
                      {report.issues.length > 0 && <div className="mt-3 space-y-2">{report.issues.map((issue, issueIndex) => <div key={`${issue.code}-${issueIndex}`} className="text-xs leading-5 text-slate-300"><span className={`mr-2 font-black ${issue.severity === 'critical' ? 'text-red-300' : issue.severity === 'major' ? 'text-amber-300' : 'text-slate-400'}`}>{issue.severity.toUpperCase()}</span>{issue.description}</div>)}</div>}
                      {report.repairInstruction && <div className="mt-3 rounded-lg bg-black/20 p-3 text-xs leading-5 text-amber-100"><span className="font-black">修复指令：</span>{report.repairInstruction}</div>}
                    </div>
                  </>
                ) : <div className="rounded-xl border border-[#2D2D33] bg-[#09090B] p-4 text-sm text-slate-500">尚未执行自动 QA。</div>}

                <textarea value={item.humanNote} onChange={(event) => handleNote(item.shotUid, event.target.value)} rows={2} placeholder="人工复核备注：身份、道具、连续性、构图等…" className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" />

                <div className="flex flex-wrap gap-3">
                  <button disabled={!item.assetBlobKey || busy || batchBusy || !capabilities.keyframeQaEnabled} onClick={() => handleAnalyze(item.shotUid)} className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/35 bg-cyan-500/10 px-4 py-2.5 text-sm font-black text-cyan-200 disabled:opacity-40">{busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />} {report ? '重新自动 QA' : '自动 QA'}</button>
                  <button disabled={item.autoStatus !== 'PASS' || busy || batchBusy} onClick={() => handleApprove(item.shotUid)} className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-2.5 text-sm font-black text-emerald-200 disabled:opacity-40"><CheckCircle2 className="h-4 w-4" /> 人工确认 PASS</button>
                  <button disabled={!report || busy || batchBusy} onClick={() => handleReject(item.shotUid)} className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-black text-red-200 disabled:opacity-40"><ThumbsDown className="h-4 w-4" /> 需重做</button>
                </div>

                {!asset?.characterId && <div className="flex items-start gap-2 text-xs leading-5 text-amber-200/80"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />该镜未绑定角色库母板，自动 QA 不会给出身份一致性分数；如镜头包含固定角色，请回 Step 3.2 选择角色后再 QA。</div>}
              </div>
            </article>
          );
        })}
      </section>

      <footer className="rounded-2xl border border-[#2D2D33] bg-[#111114] p-4 text-xs leading-5 text-slate-500">Step 3.3 最终门禁 = 每镜 AUTO QA PASS + 人工确认 PASS。只有满足这一条件的关键帧才允许进入下一阶段视频生成；任何当前图、上一镜图或角色母板变化都会撤销对应门禁。</footer>
    </div>
  );
};
