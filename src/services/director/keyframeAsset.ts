import type {
  KeyframeBlueprintApproval,
  KeyframeBlueprintDraft,
} from './keyframeBlueprint';

export const KEYFRAME_ASSET_KEY = 'zaojing_director_v032_keyframe_assets';
export const KEYFRAME_ASSET_APPROVAL_KEY = 'zaojing_director_v032_keyframe_asset_approval';
export const KEYFRAME_ASSET_VERSION = 'keyframe-asset-v0.3.2' as const;
export const KEYFRAME_ASSET_APPROVAL_VERSION = 'keyframe-asset-approval-v0.3.2' as const;

export type KeyframeAssetSource = 'upload' | 'gemini';
export type KeyframeAssetStatus = 'EMPTY' | 'READY' | 'PASS';

export interface KeyframeAssetItem {
  uid: string;
  shotUid: string;
  shotLabel: string;
  blueprintUid: string;
  blueprintPrompt: string;
  status: KeyframeAssetStatus;
  source: KeyframeAssetSource | null;
  blobKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  characterId: string;
  provider: string;
  model: string;
  createdAt: number | null;
  approvedAt: number | null;
  qaNote: string;
}

export interface KeyframeAssetManifest {
  version: typeof KEYFRAME_ASSET_VERSION;
  sourceBlueprintSavedAt: number;
  sourceBlueprintApprovedAt: number;
  sourceStoryboardSavedAt: number;
  assets: KeyframeAssetItem[];
  createdAt: number;
  savedAt: number;
}

export interface KeyframeAssetApproval {
  version: typeof KEYFRAME_ASSET_APPROVAL_VERSION;
  approvedAt: number;
  manifestSavedAt: number;
  sourceBlueprintSavedAt: number;
  sourceStoryboardSavedAt: number;
  assetCount: number;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isKeyframeBlueprintApprovalCurrent(
  draft: KeyframeBlueprintDraft | null | undefined,
  approval: KeyframeBlueprintApproval | null | undefined,
): boolean {
  if (!draft || !approval || !Array.isArray(draft.blueprints) || draft.blueprints.length === 0) {
    return false;
  }
  if (!draft.savedAt || draft.savedAt !== approval.blueprintSavedAt) return false;
  if (draft.sourceStoryboardSavedAt !== approval.sourceStoryboardSavedAt) return false;
  return draft.blueprints.length === approval.blueprintCount;
}

export function buildKeyframeAssetManifest(input: {
  draft: KeyframeBlueprintDraft;
  approval: KeyframeBlueprintApproval;
  now?: number;
}): KeyframeAssetManifest {
  if (!isKeyframeBlueprintApprovalCurrent(input.draft, input.approval)) {
    throw new Error('Step 3.1 Keyframe Blueprint 尚未形成与当前版本一致的 PASS。');
  }

  const now = input.now ?? Date.now();
  return {
    version: KEYFRAME_ASSET_VERSION,
    sourceBlueprintSavedAt: input.approval.blueprintSavedAt,
    sourceBlueprintApprovedAt: input.approval.approvedAt,
    sourceStoryboardSavedAt: input.approval.sourceStoryboardSavedAt,
    assets: input.draft.blueprints.map((blueprint) => ({
      uid: `asset-${blueprint.shotUid}`,
      shotUid: blueprint.shotUid,
      shotLabel: blueprint.shotLabel,
      blueprintUid: blueprint.uid,
      blueprintPrompt: clean(blueprint.imagePrompt),
      status: 'EMPTY',
      source: null,
      blobKey: '',
      fileName: '',
      mimeType: '',
      sizeBytes: 0,
      characterId: '',
      provider: '',
      model: '',
      createdAt: null,
      approvedAt: null,
      qaNote: '',
    })),
    createdAt: now,
    savedAt: now,
  };
}

export function manifestMatchesCurrentBlueprint(
  manifest: KeyframeAssetManifest | null | undefined,
  draft: KeyframeBlueprintDraft,
  approval: KeyframeBlueprintApproval,
): manifest is KeyframeAssetManifest {
  if (!manifest || manifest.version !== KEYFRAME_ASSET_VERSION) return false;
  if (!isKeyframeBlueprintApprovalCurrent(draft, approval)) return false;
  if (manifest.sourceBlueprintSavedAt !== approval.blueprintSavedAt) return false;
  if (manifest.sourceBlueprintApprovedAt !== approval.approvedAt) return false;
  if (manifest.assets.length !== draft.blueprints.length) return false;
  return manifest.assets.every((asset, index) => (
    asset.shotUid === draft.blueprints[index]?.shotUid &&
    asset.blueprintUid === draft.blueprints[index]?.uid
  ));
}

export function attachKeyframeAsset(
  manifest: KeyframeAssetManifest,
  shotUid: string,
  input: {
    source: KeyframeAssetSource;
    blobKey: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    characterId?: string;
    provider?: string;
    model?: string;
    now?: number;
  },
): KeyframeAssetManifest {
  const now = input.now ?? Date.now();
  return {
    ...manifest,
    assets: manifest.assets.map((asset) => asset.shotUid === shotUid ? {
      ...asset,
      status: 'READY',
      source: input.source,
      blobKey: clean(input.blobKey),
      fileName: clean(input.fileName),
      mimeType: clean(input.mimeType),
      sizeBytes: Math.max(0, Number(input.sizeBytes || 0)),
      characterId: clean(input.characterId),
      provider: clean(input.provider),
      model: clean(input.model),
      createdAt: now,
      approvedAt: null,
      qaNote: '',
    } : asset),
    savedAt: now,
  };
}

export function updateKeyframeAssetQa(
  manifest: KeyframeAssetManifest,
  shotUid: string,
  qaNote: string,
  now = Date.now(),
): KeyframeAssetManifest {
  return {
    ...manifest,
    assets: manifest.assets.map((asset) => asset.shotUid === shotUid ? {
      ...asset,
      qaNote,
      ...(asset.status === 'PASS' ? { status: 'READY' as const, approvedAt: null } : {}),
    } : asset),
    savedAt: now,
  };
}

export function approveKeyframeAsset(
  manifest: KeyframeAssetManifest,
  shotUid: string,
  now = Date.now(),
): KeyframeAssetManifest {
  const target = manifest.assets.find((asset) => asset.shotUid === shotUid);
  if (!target?.blobKey || target.status === 'EMPTY') {
    throw new Error(`${target?.shotLabel || shotUid} 尚无关键帧图片，不能确认 PASS。`);
  }
  return {
    ...manifest,
    assets: manifest.assets.map((asset) => asset.shotUid === shotUid ? {
      ...asset,
      status: 'PASS',
      approvedAt: now,
    } : asset),
    savedAt: now,
  };
}

export function isKeyframeAssetManifestComplete(manifest: KeyframeAssetManifest): boolean {
  return manifest.assets.length > 0 && manifest.assets.every((asset) => (
    asset.status === 'PASS' && Boolean(clean(asset.blobKey))
  ));
}

export function buildKeyframeAssetApproval(
  manifest: KeyframeAssetManifest,
  now = Date.now(),
): KeyframeAssetApproval {
  if (!isKeyframeAssetManifestComplete(manifest)) {
    throw new Error('仍有关键帧图片未人工确认 PASS。');
  }
  return {
    version: KEYFRAME_ASSET_APPROVAL_VERSION,
    approvedAt: now,
    manifestSavedAt: manifest.savedAt,
    sourceBlueprintSavedAt: manifest.sourceBlueprintSavedAt,
    sourceStoryboardSavedAt: manifest.sourceStoryboardSavedAt,
    assetCount: manifest.assets.length,
  };
}
