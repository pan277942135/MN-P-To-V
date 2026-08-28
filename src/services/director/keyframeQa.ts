import type { KeyframeBlueprintDraft } from './keyframeBlueprint';
import type { KeyframeAssetManifest } from './keyframeAsset';

export const KEYFRAME_QA_KEY = 'zaojing_director_v033_keyframe_qa';
export const KEYFRAME_QA_APPROVAL_KEY = 'zaojing_director_v033_keyframe_qa_approval';
export const KEYFRAME_QA_VERSION = 'keyframe-qa-v0.3.3' as const;
export const KEYFRAME_QA_APPROVAL_VERSION = 'keyframe-qa-approval-v0.3.3' as const;

export type KeyframeQaAutoStatus = 'NOT_RUN' | 'PASS' | 'FAIL';
export type KeyframeQaHumanDecision = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface KeyframeQaIssue {
  code: string;
  severity: 'warning' | 'major' | 'critical';
  description: string;
  repairInstruction: string;
}

export interface KeyframeQaScores {
  identityScore: number | null;
  promptComplianceScore: number;
  anatomyScore: number;
  visualQualityScore: number;
  compositionScore: number;
  continuityScore: number | null;
}

export interface KeyframeQaReport {
  provider: string;
  model: string;
  analyzedAt: number;
  pass: boolean;
  identityAssessed: boolean;
  continuityAssessed: boolean;
  scores: KeyframeQaScores;
  issues: KeyframeQaIssue[];
  warnings: string[];
  summary: string;
  repairInstruction: string;
}

export interface KeyframeQaItem {
  uid: string;
  shotUid: string;
  shotLabel: string;
  blueprintUid: string;
  assetBlobKey: string;
  previousAssetBlobKey: string;
  characterId: string;
  autoStatus: KeyframeQaAutoStatus;
  report: KeyframeQaReport | null;
  humanDecision: KeyframeQaHumanDecision;
  humanReviewedAt: number | null;
  humanNote: string;
}

export interface KeyframeQaManifest {
  version: typeof KEYFRAME_QA_VERSION;
  sourceBlueprintSavedAt: number;
  items: KeyframeQaItem[];
  createdAt: number;
  savedAt: number;
}

export interface KeyframeQaApproval {
  version: typeof KEYFRAME_QA_APPROVAL_VERSION;
  approvedAt: number;
  sourceBlueprintSavedAt: number;
  itemCount: number;
  assetSignatures: Array<{
    shotUid: string;
    assetBlobKey: string;
    characterId: string;
  }>;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function emptyItem(input: {
  shotUid: string;
  shotLabel: string;
  blueprintUid: string;
  assetBlobKey: string;
  previousAssetBlobKey: string;
  characterId: string;
}): KeyframeQaItem {
  return {
    uid: `qa-${input.shotUid}`,
    ...input,
    autoStatus: 'NOT_RUN',
    report: null,
    humanDecision: 'PENDING',
    humanReviewedAt: null,
    humanNote: '',
  };
}

export function buildKeyframeQaManifest(input: {
  blueprint: KeyframeBlueprintDraft;
  assets: KeyframeAssetManifest;
  now?: number;
}): KeyframeQaManifest {
  const now = input.now ?? Date.now();
  const assetByShot = new Map(input.assets.assets.map((asset) => [asset.shotUid, asset]));
  const items = input.blueprint.blueprints.map((blueprint, index) => {
    const asset = assetByShot.get(blueprint.shotUid);
    const previousBlueprint = input.blueprint.blueprints[index - 1];
    const previousAsset = previousBlueprint ? assetByShot.get(previousBlueprint.shotUid) : undefined;
    return emptyItem({
      shotUid: blueprint.shotUid,
      shotLabel: blueprint.shotLabel,
      blueprintUid: blueprint.uid,
      assetBlobKey: clean(asset?.blobKey),
      previousAssetBlobKey: clean(previousAsset?.blobKey),
      characterId: clean(asset?.characterId),
    });
  });

  return {
    version: KEYFRAME_QA_VERSION,
    sourceBlueprintSavedAt: input.blueprint.savedAt,
    items,
    createdAt: now,
    savedAt: now,
  };
}

export function syncKeyframeQaManifest(input: {
  current: KeyframeQaManifest | null | undefined;
  blueprint: KeyframeBlueprintDraft;
  assets: KeyframeAssetManifest;
  now?: number;
}): { manifest: KeyframeQaManifest; invalidatedShotUids: string[] } {
  const now = input.now ?? Date.now();
  const fresh = buildKeyframeQaManifest({ blueprint: input.blueprint, assets: input.assets, now });
  if (!input.current || input.current.version !== KEYFRAME_QA_VERSION || input.current.sourceBlueprintSavedAt !== input.blueprint.savedAt) {
    return { manifest: fresh, invalidatedShotUids: [] };
  }

  const oldByShot = new Map(input.current.items.map((item) => [item.shotUid, item]));
  const invalidatedShotUids: string[] = [];
  const items = fresh.items.map((next) => {
    const old = oldByShot.get(next.shotUid);
    if (!old) return next;
    const sameInputs =
      old.blueprintUid === next.blueprintUid &&
      old.assetBlobKey === next.assetBlobKey &&
      old.previousAssetBlobKey === next.previousAssetBlobKey &&
      old.characterId === next.characterId;
    if (sameInputs) return old;
    if (old.autoStatus !== 'NOT_RUN' || old.humanDecision !== 'PENDING') {
      invalidatedShotUids.push(next.shotUid);
    }
    return next;
  });

  return {
    manifest: {
      ...fresh,
      createdAt: input.current.createdAt || now,
      items,
      savedAt: invalidatedShotUids.length > 0 ? now : input.current.savedAt,
    },
    invalidatedShotUids,
  };
}

export function attachKeyframeQaReport(
  manifest: KeyframeQaManifest,
  shotUid: string,
  report: KeyframeQaReport,
  now = Date.now(),
): KeyframeQaManifest {
  return {
    ...manifest,
    items: manifest.items.map((item) => item.shotUid === shotUid ? {
      ...item,
      autoStatus: report.pass ? 'PASS' : 'FAIL',
      report,
      humanDecision: 'PENDING',
      humanReviewedAt: null,
    } : item),
    savedAt: now,
  };
}

export function updateKeyframeQaHumanNote(
  manifest: KeyframeQaManifest,
  shotUid: string,
  humanNote: string,
  now = Date.now(),
): KeyframeQaManifest {
  return {
    ...manifest,
    items: manifest.items.map((item) => item.shotUid === shotUid
      ? { ...item, humanNote, ...(item.humanDecision === 'APPROVED' ? { humanDecision: 'PENDING' as const, humanReviewedAt: null } : {}) }
      : item),
    savedAt: now,
  };
}

export function approveKeyframeQa(
  manifest: KeyframeQaManifest,
  shotUid: string,
  now = Date.now(),
): KeyframeQaManifest {
  const target = manifest.items.find((item) => item.shotUid === shotUid);
  if (!target?.report || target.autoStatus !== 'PASS') {
    throw new Error(`${target?.shotLabel || shotUid} 自动 QA 尚未 PASS，不能人工确认。`);
  }
  return {
    ...manifest,
    items: manifest.items.map((item) => item.shotUid === shotUid ? {
      ...item,
      humanDecision: 'APPROVED',
      humanReviewedAt: now,
    } : item),
    savedAt: now,
  };
}

export function rejectKeyframeQa(
  manifest: KeyframeQaManifest,
  shotUid: string,
  now = Date.now(),
): KeyframeQaManifest {
  return {
    ...manifest,
    items: manifest.items.map((item) => item.shotUid === shotUid ? {
      ...item,
      humanDecision: 'REJECTED',
      humanReviewedAt: now,
    } : item),
    savedAt: now,
  };
}

export function isKeyframeQaComplete(manifest: KeyframeQaManifest): boolean {
  return manifest.items.length > 0 && manifest.items.every((item) => (
    Boolean(item.assetBlobKey) &&
    item.autoStatus === 'PASS' &&
    item.report?.pass === true &&
    item.humanDecision === 'APPROVED'
  ));
}

export function buildKeyframeQaApproval(
  manifest: KeyframeQaManifest,
  now = Date.now(),
): KeyframeQaApproval {
  if (!isKeyframeQaComplete(manifest)) {
    throw new Error('仍有关键帧未完成自动 QA + 人工确认。');
  }
  return {
    version: KEYFRAME_QA_APPROVAL_VERSION,
    approvedAt: now,
    sourceBlueprintSavedAt: manifest.sourceBlueprintSavedAt,
    itemCount: manifest.items.length,
    assetSignatures: manifest.items.map((item) => ({
      shotUid: item.shotUid,
      assetBlobKey: item.assetBlobKey,
      characterId: item.characterId,
    })),
  };
}

export function isKeyframeQaApprovalCurrent(
  manifest: KeyframeQaManifest | null | undefined,
  approval: KeyframeQaApproval | null | undefined,
): boolean {
  if (!manifest || !approval || !isKeyframeQaComplete(manifest)) return false;
  if (approval.version !== KEYFRAME_QA_APPROVAL_VERSION) return false;
  if (approval.sourceBlueprintSavedAt !== manifest.sourceBlueprintSavedAt) return false;
  if (approval.itemCount !== manifest.items.length) return false;
  return approval.assetSignatures.every((signature, index) => {
    const item = manifest.items[index];
    return Boolean(item) &&
      item.shotUid === signature.shotUid &&
      item.assetBlobKey === signature.assetBlobKey &&
      item.characterId === signature.characterId;
  });
}
