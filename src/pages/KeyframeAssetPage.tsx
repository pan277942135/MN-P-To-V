import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Image as ImageIcon,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
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
  KEYFRAME_ASSET_VERSION,
  attachKeyframeAsset,
  buildKeyframeAssetManifest,
  isKeyframeBlueprintApprovalCurrent,
  manifestMatchesCurrentBlueprint,
  updateKeyframeAssetQa,
  type KeyframeAssetManifest,
} from '../services/director/keyframeAsset';
import { keyframeAssetStore } from '../services/director/keyframeAssetStore';
import {
  base64ToBlob,
  blobToBase64,
  generateKeyframeImage,
} from '../services/director/geminiKeyframeImageClient';

interface InitialState {
  ready: boolean;
  reason: string;
  blueprint: KeyframeBlueprintDraft | null;
  manifest: KeyframeAssetManifest | null;
  autoCreated: boolean;
  migratedPassCount: number;
}

function safeParse<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function removeLegacyAssetPass(manifest: KeyframeAssetManifest): { manifest: KeyframeAssetManifest; migratedPassCount: number } {
  const migratedPassCount = manifest.assets.filter((asset) => asset.status === 'PASS').length;
  if (migratedPassCount === 0) return { manifest, migratedPassCount: 0 };
  const now = Date.now();
  return {
    migratedPassCount,
    manifest: {
      ...manifest,
      assets: manifest.assets.map((asset) => asset.status === 'PASS'
        ? { ...asset, status: asset.blobKey ? 'READY' as const : 'EMPTY' as const, approvedAt: null }
        : asset),
      savedAt: now,
    },
  };
}

function initializePage(): InitialState {
  const blueprint = safeParse<KeyframeBlueprintDraft>(KEYFRAME_BLUEPRINT_KEY);
  const approval = safeParse<KeyframeBlueprintApproval>(KEYFRAME_BLUEPRINT_APPROVAL_KEY);
  if (!blueprint || !approval || !isKeyframeBlueprintApprovalCurrent(blueprint, approval)) {
    return {
      ready: false,
      reason: '请先完成 Step 3.1，并对当前版本 Keyframe Blueprint 执行人工确认 PASS。',
      blueprint: null,
      manifest: null,
      autoCreated: false,
      migratedPassCount: 0,
    };
  }

  const stored = safeParse<KeyframeAssetManifest>(KEYFRAME_ASSET_KEY);
  if (manifestMatchesCurrentBlueprint(stored, blueprint, approval)) {
    const migrated = removeLegacyAssetPass(stored);
    if (migrated.migratedPassCount > 0) {
      window.localStorage.setItem(KEYFRAME_ASSET_KEY, JSON.stringify(migrated.manifest));
    }
    window.localStorage.removeItem(KEYFRAME_ASSET_APPROVAL_KEY);
    return {
      ready: true,
      reason: '',
      blueprint,
      manifest: migrated.manifest,
      autoCreated: false,
      migratedPassCount: migrated.migratedPassCount,
    };
  }

  const manifest = buildKeyframeAssetManifest({ draft: blueprint, approval });
  window.localStorage.setItem(KEYFRAME_ASSET_KEY, JSON.stringify(manifest));
  window.localStorage.removeItem(KEYFRAME_ASSET_APPROVAL_KEY);
  return { ready: true, reason: '', blueprint, manifest, autoCreated: true, migratedPassCount: 0 };
}

async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const result = { width: image.naturalWidth, height: image.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(result);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取图片尺寸。'));
    };
    image.src = url;
  });
}

async function assertNineSixteen(blob: Blob) {
  const { width, height } = await imageDimensions(blob);
  if (!width || !height) throw new Error('图片尺寸无效。');
  const ratio = width / height;
  const target = 9 / 16;
  if (Math.abs(ratio - target) > 0.04) {
    throw new Error(`关键帧必须接近 9:16；当前图片为 ${width}×${height}。请先裁剪后再上传。`);
  }
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
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

function newBlobKey(shotUid: string) {
  return `keyframe-${shotUid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const KeyframeAssetPage: React.FC = () => {
  const initial = useMemo(() => initializePage(), []);
  const [manifest, setManifest] = useState<KeyframeAssetManifest | null>(initial.manifest);
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [busyShot, setBusyShot] = useState('');
  const [message, setMessage] = useState(
    initial.migratedPassCount > 0
      ? `已迁移旧版 Step 3.2：${initial.migratedPassCount} 个旧人工 PASS 已撤销，最终 PASS 统一移至 Step 3.3 自动 QA + 人工复核。`
      : initial.autoCreated && initial.manifest
        ? `Step 3.1 PASS 已读取，自动创建 ${initial.manifest.assets.length} 个关键帧图片槽位。`
        : '',
  );
  const [error, setError] = useState('');
  const [capabilities, setCapabilities] = useState({
    keyframeImageEnabled: false,
    keyframeImageModel: '',
  });

  const blueprintByShot = useMemo(() => new Map(
    (initial.blueprint?.blueprints || []).map((item) => [item.shotUid, item]),
  ), [initial.blueprint]);

  const persistManifest = (next: KeyframeAssetManifest) => {
    const migrated = removeLegacyAssetPass(next).manifest;
    window.localStorage.setItem(KEYFRAME_ASSET_KEY, JSON.stringify(migrated));
    // Step 3.2 only prepares assets. Final keyframe approval is owned by Step 3.3.
    window.localStorage.removeItem(KEYFRAME_ASSET_APPROVAL_KEY);
    setManifest(migrated);
  };

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
  }, [manifest?.sourceBlueprintSavedAt]);

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
    if (!manifest) return;
    await assertNineSixteen(blob);
    const current = manifest.assets.find((item) => item.shotUid === shotUid);
    const blobKey = newBlobKey(shotUid);
    await keyframeAssetStore.put(blobKey, shotUid, blob);
    if (current?.blobKey && current.blobKey !== blobKey) {
      await keyframeAssetStore.remove(current.blobKey).catch(() => undefined);
    }
    const oldUrl = previews[shotUid];
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    setPreviews((value) => ({ ...value, [shotUid]: URL.createObjectURL(blob) }));
    const next = attachKeyframeAsset(manifest, shotUid, {
      source: meta.source,
      blobKey,
      fileName: meta.fileName,
      mimeType: blob.type || 'image/png',
      sizeBytes: blob.size,
      characterId: meta.characterId,
      provider: meta.provider,
      model: meta.model,
      now: meta.createdAt,
    });
    persistManifest(next);
  };

  const handleUpload = async (shotUid: string, file: File | null) => {
    if (!file || !manifest) return;
    setBusyShot(shotUid);
    setError('');
    setMessage('');
    try {
      if (!file.type.startsWith('image/')) throw new Error('请选择图片文件。');
      if (file.size > 20 * 1024 * 1024) throw new Error('单张关键帧图片不能超过 20MB。');
      await replaceBlob(shotUid, file, { source: 'upload', fileName: file.name });
      setMessage(`${manifest.assets.find((item) => item.shotUid === shotUid)?.shotLabel || ''} 已上传；请进入 Step 3.3 自动 QA。`);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setBusyShot('');
    }
  };

  const handleGenerate = async (shotUid: string) => {
    if (!manifest) return;
    const asset = manifest.assets.find((item) => item.shotUid === shotUid);
    const blueprint = blueprintByShot.get(shotUid);
    if (!asset || !blueprint) return;
    if (!capabilities.keyframeImageEnabled) {
      setError('当前环境未启用关键帧图片 Provider；仍可直接上传图片。');
      return;
    }

    setBusyShot(shotUid);
    setError('');
    setMessage('');
    try {
      const character = characters.find((item) => item.id === asset.characterId);
      const refBlob = await loadReferenceBlob(character);
      const referenceImageBase64 = refBlob ? await blobToBase64(refBlob) : undefined;
      const characterHint = character
        ? [character.name, character.description, JSON.stringify(character.identitySpec || {})].filter(Boolean).join('；')
        : blueprint.characterReference;
      const result = await generateKeyframeImage({
        prompt: blueprint.imagePrompt,
        negativePrompt: blueprint.negativePrompt,
        characterHint,
        referenceImageBase64,
        referenceMimeType: refBlob?.type || undefined,
      });
      if (!result.imageBase64) throw new Error('Gemini 未返回图片数据。');
      const blob = base64ToBlob(result.imageBase64, result.mimeType);
      await replaceBlob(shotUid, blob, {
        source: 'gemini',
        fileName: `${asset.shotLabel}-${result.model}.png`,
        characterId: asset.characterId,
        provider: result.provider,
        model: result.model,
        createdAt: result.generatedAt,
      });
      setMessage(`${asset.shotLabel} 已生成关键帧；请进入 Step 3.3 自动 QA。`);
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
        ? { ...asset, characterId, status: asset.blobKey ? 'READY' as const : 'EMPTY' as const, approvedAt: null }
        : asset),
      savedAt: Date.now(),
    };
    persistManifest(next);
    setMessage(`${next.assets.find((asset) => asset.shotUid === shotUid)?.shotLabel || ''} 角色参考已更新；旧 QA（如有）将在 Step 3.3 自动失效。`);
  };

  const handleQaChange = (shotUid: string, qaNote: string) => {
    if (!manifest) return;
    persistManifest(updateKeyframeAssetQa(manifest, shotUid, qaNote));
  };

  if (!initial.ready || !manifest || !initial.blueprint) {
    return (
      <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-amber-400"><ImageIcon className="h-4 w-4" /> Director Console · Step 3.2</div>
          <h1 className="text-2xl font-black text-white sm:text-3xl">关键帧图片｜生成 / 上传</h1>
        </header>
        <section className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-6">
          <div className="flex items-start gap-3"><LockKeyhole className="mt-0.5 h-5 w-5 text-amber-300" /><div><div className="font-black text-amber-100">Step 3.2 尚未解锁</div><p className="mt-2 text-sm text-amber-100/70">{initial.reason}</p></div></div>
        </section>
      </div>
    );
  }

  const preparedCount = manifest.assets.filter((asset) => Boolean(asset.blobKey)).length;
  const missingCount = manifest.assets.length - preparedCount;

  return (
    <div className="mx-auto max-w-[1380px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-violet-400"><ImageIcon className="h-4 w-4" /> Director Console · Step 3.2</div>
          <h1 className="text-2xl font-black text-white sm:text-3xl">关键帧图片｜生成 / 上传</h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">Step 3.2 只负责准备逐镜图片资产与角色参考。图片准备完成后进入 Step 3.3 自动 QA；这里不再直接授予关键帧 PASS。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300">STEP 3.1 · PASS</span>
          <span className={`rounded-full border px-3 py-1.5 text-xs font-bold ${missingCount === 0 ? 'border-violet-500/30 bg-violet-500/10 text-violet-200' : 'border-amber-500/30 bg-amber-500/10 text-amber-200'}`}>STEP 3.2 · {missingCount === 0 ? 'ASSETS READY' : `${preparedCount}/${manifest.assets.length}`}</span>
        </div>
      </header>

      <section className="rounded-2xl border border-violet-500/20 bg-violet-500/5 p-4 sm:p-5">
        <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-violet-300" /><div><div className="text-sm font-black text-violet-100">Provider：{capabilities.keyframeImageEnabled ? `Vertex AI Gemini / ${capabilities.keyframeImageModel}` : '未启用'}</div><p className="mt-1 text-xs leading-5 text-violet-100/70">点击“生成关键帧”才会发起单镜付费 Provider 请求；部署、刷新和进入页面都不会自动生成。上传路径完全不调用 Provider。</p></div></div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">总镜数</div><div data-testid="keyframe-asset-count" className="mt-1 text-2xl font-black text-white">{manifest.assets.length}</div></div>
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">已准备</div><div data-testid="keyframe-asset-ready-count" className="mt-1 text-2xl font-black text-violet-300">{preparedCount}</div></div>
        <div className="rounded-xl border border-[#2D2D33] bg-[#111114] p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">缺失图片</div><div className="mt-1 text-2xl font-black text-amber-300">{missingCount}</div></div>
      </section>

      {message && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}
      {error && <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      <section className="space-y-5">
        {manifest.assets.map((asset) => {
          const blueprint = blueprintByShot.get(asset.shotUid);
          const busy = busyShot === asset.shotUid;
          return (
            <article key={asset.uid} className="grid gap-5 rounded-2xl border border-[#2D2D33] bg-[#111114] p-4 sm:p-5 xl:grid-cols-[310px_1fr]">
              <div className="space-y-3">
                <div className="aspect-[9/16] overflow-hidden rounded-xl border border-[#303036] bg-[#09090B]">
                  {previews[asset.shotUid]
                    ? <img src={previews[asset.shotUid]} alt={`${asset.shotLabel} keyframe`} className="h-full w-full object-cover" />
                    : <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-600"><ImageIcon className="h-8 w-8" /><span className="text-xs">尚无关键帧图片</span></div>}
                </div>
                <div className="flex items-center justify-between"><span className="font-mono text-sm font-black text-violet-300">{asset.shotLabel}</span><span className={`text-xs font-black ${asset.blobKey ? 'text-violet-300' : 'text-slate-500'}`}>{asset.blobKey ? 'ASSET READY' : 'EMPTY'}</span></div>
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-600/40 bg-slate-800/40 px-3 py-2.5 text-sm font-bold text-slate-200 hover:bg-slate-800/70">
                  <Upload className="h-4 w-4" /> 上传 9:16 图片
                  <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={(event) => handleUpload(asset.shotUid, event.target.files?.[0] || null)} />
                </label>
              </div>

              <div className="space-y-4">
                <div><div className="text-sm font-black text-white">{blueprint?.shotTitle || asset.shotLabel}</div><div className="mt-1 font-mono text-[10px] text-slate-600">shot.uid: {asset.shotUid}</div></div>
                <div className="rounded-xl border border-[#2D2D33] bg-[#09090B] p-3"><div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">Blueprint Prompt</div><p className="text-xs leading-5 text-slate-300">{blueprint?.imagePrompt || asset.blueprintPrompt}</p></div>

                <div>
                  <label className="mb-1.5 block text-xs font-bold text-slate-400">角色母板（生成 + Step 3.3 身份 QA）</label>
                  <select value={asset.characterId} onChange={(event) => handleCharacterChange(asset.shotUid, event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white">
                    <option value="">不附加角色母板（Step 3.3 不评估身份分）</option>
                    {characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
                  </select>
                </div>

                <button disabled={busy || !capabilities.keyframeImageEnabled} onClick={() => handleGenerate(asset.shotUid)} className="inline-flex items-center gap-2 rounded-xl border border-violet-500/35 bg-violet-500/10 px-4 py-2.5 text-sm font-black text-violet-200 disabled:cursor-not-allowed disabled:opacity-40">
                  {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {asset.source === 'gemini' ? '重新生成关键帧' : '生成关键帧'}
                </button>

                <div>
                  <label className="mb-1.5 block text-xs font-bold text-slate-400">资产准备备注（可选）</label>
                  <textarea value={asset.qaNote} onChange={(event) => handleQaChange(asset.shotUid, event.target.value)} rows={2} placeholder="记录该镜生成/上传时需要保留的信息；正式 QA 在 Step 3.3。" className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white" />
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <span className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-black ${asset.blobKey ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200' : 'border-slate-700 bg-slate-900 text-slate-500'}`}><ArrowRight className="h-4 w-4" /> {asset.blobKey ? '下一步：Step 3.3 自动 QA' : '先准备图片资产'}</span>
                  {asset.source && <span className="text-xs text-slate-500">来源：{asset.source === 'upload' ? '上传' : `${asset.provider} / ${asset.model}`}</span>}
                </div>
              </div>
            </article>
          );
        })}
      </section>

      <footer className="rounded-2xl border border-[#2D2D33] bg-[#111114] p-4 text-xs leading-5 text-slate-500">Step 3.2 只形成“图片资产已准备”状态，不授予 PASS。最终关键帧门禁统一由 Step 3.3：AUTO QA PASS + 人工复核 PASS 产生；视频阶段不得绕过 Step 3.3。</footer>
    </div>
  );
};
