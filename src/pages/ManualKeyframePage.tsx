import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Image as ImageIcon,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Upload,
} from 'lucide-react';
import { characterRepository } from '../repositories/characterRepository';
import type { CharacterProfile } from '../types';
import { getRefImageUrl, refToBlob } from '../utils/imageHelper';
import {
  approveKeyframeAsset,
  attachKeyframeAsset,
  revokeKeyframeAssetPass,
  updateKeyframeAssetQa,
  type KeyframeAssetManifest,
} from '../services/director/keyframeAsset';
import { keyframeAssetStore } from '../services/director/keyframeAssetStore';
import {
  base64ToBlob,
  blobToBase64,
  generateKeyframeImage,
} from '../services/director/geminiKeyframeImageClient';
import {
  persistManualKeyframeAssets,
  syncLocalShotPipeline,
} from '../services/director/shotProductionWorkflow';
import {
  DIRECTOR_DRAFT_KEY,
  STORYBOARD_KEY,
} from '../services/director/keyframeBlueprint';
import {
  DEFAULT_FORMAT_POLICY,
  LEGACY_FORMAT_POLICY,
  hasFormatPolicy,
  resolveFormatPolicy,
  validateAssetMetadata,
  type AssetValidation,
  type ProductionFormatPolicy,
} from '../services/formatPolicy/formatPolicy';

async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取图片尺寸。'));
    };
    image.src = url;
  });
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function readProjectFormatPolicy(): ProductionFormatPolicy {
  const project = readJson<{ formatPolicy?: ProductionFormatPolicy; aspectRatio?: '16:9' | '9:16' | '1:1' }>(DIRECTOR_DRAFT_KEY);
  if (hasFormatPolicy(project?.formatPolicy)) return project.formatPolicy as ProductionFormatPolicy;
  if (project?.aspectRatio) {
    return {
      ...LEGACY_FORMAT_POLICY,
      defaultAspectRatio: project.aspectRatio,
      allowedAspectRatios: [project.aspectRatio],
    };
  }
  return DEFAULT_FORMAT_POLICY;
}

function policyForShot(shotUid: string) {
  const storyboard = readJson<{ shots?: Array<{ uid?: string; formatPolicy?: unknown }> }>(STORYBOARD_KEY);
  const shot = storyboard?.shots?.find((item) => item.uid === shotUid);
  return resolveFormatPolicy({
    projectPolicy: readProjectFormatPolicy(),
    shotOverride: shot?.formatPolicy,
  });
}

async function loadReferenceBlob(character: CharacterProfile | undefined): Promise<Blob | null> {
  const ref = character?.referenceImages?.[0];
  if (!ref) return null;
  const local = await refToBlob(ref);
  if (local) return local;
  const url = getRefImageUrl(ref);
  if (!url || !/^https?:\/\//.test(url)) return null;
  try {
    const response = await fetch(url);
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

function newBlobKey(shotUid: string) {
  return `keyframe-${shotUid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const ManualKeyframePage: React.FC = () => {
  const initial = useMemo(() => syncLocalShotPipeline(), []);
  const [manifest, setManifest] = useState<KeyframeAssetManifest | null>(initial?.assets || null);
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [busyShot, setBusyShot] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [capabilities, setCapabilities] = useState({ keyframeImageEnabled: false, keyframeImageModel: '' });

  const blueprintByShot = useMemo(
    () => new Map((initial?.blueprint.blueprints || []).map((item) => [item.shotUid, item])),
    [initial?.blueprint],
  );

  useEffect(() => {
    characterRepository.getAll().then(setCharacters).catch(() => setCharacters([]));
    fetch('/api/director/capabilities')
      .then((response) => response.json())
      .then((payload) => setCapabilities({
        keyframeImageEnabled: payload?.keyframeImageEnabled === true,
        keyframeImageModel: String(payload?.keyframeImageModel || ''),
      }))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    async function restore() {
      if (!manifest) return;
      const next: Record<string, string> = {};
      for (const asset of manifest.assets) {
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
  }, [manifest?.savedAt]);

  const persist = (next: KeyframeAssetManifest) => {
    const synced = persistManualKeyframeAssets(next);
    setManifest(synced?.assets || next);
  };

  const replaceBlob = async (
    shotUid: string,
    blob: Blob,
    meta: {
      source: 'upload' | 'gemini';
      fileName: string;
      characterId?: string;
      provider?: string;
      model?: string;
      createdAt?: number;
    },
  ) => {
    if (!manifest) return null;
    const resolvedPolicy = policyForShot(shotUid);
    let dimensions = { width: 0, height: 0 };
    try {
      dimensions = await imageDimensions(blob);
    } catch {
      // Let the shared validator produce the INVALID reason used by the API.
    }
    const validation: AssetValidation = validateAssetMetadata({
      width: dimensions.width,
      height: dimensions.height,
      mimeType: blob.type,
      assetType: 'IMAGE',
      projectPolicy: resolvedPolicy.project,
      episodePolicy: resolvedPolicy.episode,
      shotOverride: resolvedPolicy.shotOverride,
    });
    if (validation.status === 'INVALID') {
      throw new Error(`${validation.reason || '媒体文件无效'}；${validation.suggestion || '请重新选择文件。'}`);
    }
    const current = manifest.assets.find((item) => item.shotUid === shotUid);
    const blobKey = newBlobKey(shotUid);
    await keyframeAssetStore.put(blobKey, shotUid, blob);
    if (current?.blobKey && current.blobKey !== blobKey) {
      await keyframeAssetStore.remove(current.blobKey).catch(() => undefined);
    }
    const oldUrl = previews[shotUid];
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    setPreviews((value) => ({ ...value, [shotUid]: URL.createObjectURL(blob) }));
    persist(attachKeyframeAsset(manifest, shotUid, {
      source: meta.source,
      blobKey,
      fileName: meta.fileName,
      mimeType: blob.type || 'image/png',
      sizeBytes: blob.size,
      width: dimensions.width,
      height: dimensions.height,
      validation,
      characterId: meta.characterId,
      provider: meta.provider,
      model: meta.model,
      now: meta.createdAt,
    }));
    return validation;
  };

  const handleUpload = async (shotUid: string, file: File | null) => {
    if (!file || !manifest) return;
    setBusyShot(shotUid);
    setError('');
    try {
      if (!file.type.startsWith('image/')) throw new Error('请选择图片文件。');
      if (file.size > 20 * 1024 * 1024) throw new Error('单张图片不能超过 20MB。');
      const validation = await replaceBlob(shotUid, file, { source: 'upload', fileName: file.name });
      setMessage(validation?.status === 'WARNING'
        ? `关键帧已上传，但画幅为 ${validation.actualAspectRatio}，项目期望 ${validation.expectedAspectRatio}。可裁切或改用其他画幅。`
        : '关键帧已上传。请直接人工检查并决定 PASS / 重做。');
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setBusyShot('');
    }
  };

  const handleGenerate = async (shotUid: string) => {
    if (!manifest || !capabilities.keyframeImageEnabled) return;
    const asset = manifest.assets.find((item) => item.shotUid === shotUid);
    const blueprint = blueprintByShot.get(shotUid);
    if (!asset || !blueprint) return;
    setBusyShot(shotUid);
    setError('');
    try {
      const character = characters.find((item) => item.id === asset.characterId);
      const refBlob = await loadReferenceBlob(character);
      const result = await generateKeyframeImage({
        prompt: blueprint.imagePrompt,
        negativePrompt: blueprint.negativePrompt,
        characterHint: character
          ? [character.name, character.description, JSON.stringify(character.identitySpec || {})].filter(Boolean).join('；')
          : blueprint.characterReference,
        referenceImageBase64: refBlob ? await blobToBase64(refBlob) : undefined,
        referenceMimeType: refBlob?.type || undefined,
        aspectRatio: policyForShot(shotUid).expectedAspectRatio,
      });
      if (!result.imageBase64) throw new Error('Gemini 未返回图片数据。');
      const blob = base64ToBlob(result.imageBase64, result.mimeType);
      const validation = await replaceBlob(shotUid, blob, {
        source: 'gemini',
        fileName: `${asset.shotLabel}-${result.model}.png`,
        characterId: asset.characterId,
        provider: result.provider,
        model: result.model,
        createdAt: result.generatedAt,
      });
      setMessage(validation?.status === 'WARNING'
        ? `${asset.shotLabel} 已生成，但实际画幅 ${validation.actualAspectRatio} 与期望 ${validation.expectedAspectRatio} 不同。`
        : `${asset.shotLabel} 已生成关键帧。系统不会自动 QA，请你人工检查。`);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setBusyShot('');
    }
  };

  const handleCharacterChange = (shotUid: string, characterId: string) => {
    if (!manifest) return;
    const next: KeyframeAssetManifest = {
      ...manifest,
      assets: manifest.assets.map((asset) => asset.shotUid === shotUid
        ? {
            ...asset,
            characterId,
            status: asset.blobKey ? 'READY' : 'EMPTY',
            approvedAt: null,
          }
        : asset),
      savedAt: Date.now(),
    };
    persist(next);
    setMessage('角色参考已修改；该镜旧人工 PASS 已撤销。');
  };

  const handleNote = (shotUid: string, note: string) => {
    if (!manifest) return;
    persist(updateKeyframeAssetQa(manifest, shotUid, note));
  };

  const handleApprove = (shotUid: string) => {
    if (!manifest) return;
    try {
      const next = approveKeyframeAsset(manifest, shotUid);
      const synced = persistManualKeyframeAssets(next);
      setManifest(synced?.assets || next);
      const item = next.assets.find((asset) => asset.shotUid === shotUid);
      setError('');
      setMessage(`${item?.shotLabel || ''} 已人工 PASS；该 Shot 已立即进入视频蓝图可编辑状态，不等待其他关键帧。`);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    }
  };

  const handleRedo = (shotUid: string) => {
    if (!manifest) return;
    const next = revokeKeyframeAssetPass(manifest, shotUid);
    persist(next);
    setMessage(`${next.assets.find((asset) => asset.shotUid === shotUid)?.shotLabel || ''} 已撤销 PASS，可重新上传或生成。`);
  };

  if (!initial || !manifest) {
    return (
      <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header><div className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-amber-400">Shot Production</div><h1 className="text-2xl font-black text-white">关键帧｜生成 / 上传 / 人工确认</h1></header>
        <section className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-6 text-sm text-amber-100/80">请先在导演台生成 Storyboard。当前模式不要求完成整阶段 PASS。</section>
      </div>
    );
  }

  const prepared = manifest.assets.filter((asset) => Boolean(asset.blobKey)).length;
  const passed = manifest.assets.filter((asset) => asset.status === 'PASS').length;

  return (
    <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-violet-400"><ImageIcon className="h-4 w-4" /> Shot Production · Keyframes</div>
          <h1 className="text-2xl font-black text-white sm:text-3xl">关键帧｜生成 / 上传 / 人工确认</h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">当前不使用系统自动 QA。每个 Shot 独立人工确认；任意一个 Shot PASS 后即可进入该镜视频蓝图，不要求整集关键帧全部完成。</p>
        </div>
        <div className="flex gap-2"><span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-300">已准备 {prepared}/{manifest.assets.length}</span><span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300">人工 PASS {passed}/{manifest.assets.length}</span></div>
      </header>

      <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-xs leading-5 text-emerald-100/75">QA 模式：<span className="font-black">人工</span>。系统不会调用 Gemini QA；只有你明确点击“Gemini 生成关键帧”时才会产生图片 Provider 调用。</section>

      {message && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}
      {error && <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      <section className="space-y-5">
        {manifest.assets.map((asset) => {
          const blueprint = blueprintByShot.get(asset.shotUid);
          const busy = busyShot === asset.shotUid;
          const resolvedPolicy = policyForShot(asset.shotUid);
          return (
            <article key={asset.uid} className="grid gap-5 rounded-2xl border border-[#2D2D33] bg-[#111114] p-4 sm:p-5 xl:grid-cols-[260px_1fr]">
              <div className="space-y-3">
                <div className="overflow-hidden rounded-xl border border-[#303036] bg-[#09090B]" style={{ aspectRatio: resolvedPolicy.expectedAspectRatio.replace(':', '/') }}>{previews[asset.shotUid] ? <img src={previews[asset.shotUid]} alt={`${asset.shotLabel} keyframe`} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs text-slate-600">尚无图片</div>}</div>
                <div className="flex items-center justify-between"><span className="font-mono text-sm font-black text-violet-300">{asset.shotLabel}</span><span className={`text-xs font-black ${asset.status === 'PASS' ? 'text-emerald-300' : asset.blobKey ? 'text-amber-300' : 'text-slate-500'}`}>{asset.status === 'PASS' ? 'HUMAN PASS' : asset.blobKey ? '待人工确认' : '待图片'}</span></div>
              </div>

              <div className="space-y-4">
                <div><div className="text-base font-black text-white">{blueprint?.shotTitle || asset.shotLabel}</div><p className="mt-1 text-xs leading-5 text-slate-500">{blueprint?.imagePrompt || asset.blueprintPrompt}</p></div>
                {asset.validation && <div className={`rounded-xl border px-3 py-2 text-xs ${asset.validation.status === 'VALID' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200' : 'border-amber-500/25 bg-amber-500/10 text-amber-200'}`}>画幅校验：<span className="font-black">{asset.validation.status}</span> · 实际 {asset.validation.actualAspectRatio || '未知'} / 期望 {asset.validation.expectedAspectRatio}</div>}
                <div><label className="mb-1.5 block text-xs font-bold text-slate-400">角色母板（可选）</label><select value={asset.characterId} onChange={(event) => handleCharacterChange(asset.shotUid, event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white"><option value="">未指定角色</option>{characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}</select></div>
                <div className="flex flex-wrap gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-sm font-bold text-sky-200"><Upload className="h-4 w-4" /> 上传 {resolvedPolicy.expectedAspectRatio}<input type="file" accept="image/*" className="hidden" disabled={busy} onChange={(event) => handleUpload(asset.shotUid, event.target.files?.[0] || null)} /></label>
                  <button disabled={busy || !capabilities.keyframeImageEnabled} onClick={() => handleGenerate(asset.shotUid)} className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">{busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Gemini 生成关键帧</button>
                </div>
                <textarea rows={2} value={asset.qaNote} onChange={(event) => handleNote(asset.shotUid, event.target.value)} placeholder="人工检查备注：人物、手指、服装、道具、构图、连续性……" className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" />
                <div className="flex flex-wrap gap-2 border-t border-[#2D2D33] pt-4">
                  <button disabled={!asset.blobKey || asset.status === 'PASS'} onClick={() => handleApprove(asset.shotUid)} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-black text-white disabled:opacity-35"><CheckCircle2 className="h-4 w-4" /> 人工确认 PASS</button>
                  <button disabled={!asset.blobKey} onClick={() => handleRedo(asset.shotUid)} className="inline-flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-bold text-amber-200 disabled:opacity-35"><RotateCcw className="h-4 w-4" /> 重做 / 撤销 PASS</button>
                  {asset.status === 'PASS' && <span className="inline-flex items-center rounded-xl border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-xs font-bold text-sky-200">该镜已可进入视频蓝图</span>}
                </div>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
};
