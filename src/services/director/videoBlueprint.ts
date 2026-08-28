import type { KeyframeBlueprintDraft, StoryboardForBlueprint } from './keyframeBlueprint';
import type { KeyframeAssetManifest } from './keyframeAsset';
import {
  isKeyframeQaApprovalCurrent,
  type KeyframeQaApproval,
  type KeyframeQaManifest,
} from './keyframeQa';
import { PromptCompiler, type MotionIntensity } from '../prompt/PromptCompiler';

export const VIDEO_BLUEPRINT_KEY = 'zaojing_director_v041_video_blueprints';
export const VIDEO_BLUEPRINT_APPROVAL_KEY = 'zaojing_director_v041_video_blueprint_approval';
export const VIDEO_BLUEPRINT_VERSION = 'video-blueprint-v0.4.1' as const;
export const VIDEO_BLUEPRINT_APPROVAL_VERSION = 'video-blueprint-approval-v0.4.1' as const;

export type VeoDurationSeconds = 4 | 6 | 8;
export type VideoCameraPreset =
  | 'locked_camera'
  | 'slow_push'
  | 'slow_pull'
  | 'subtle_pan'
  | 'tracking_shot'
  | 'vertical_boom';

export interface VideoBlueprintItem {
  uid: string;
  shotUid: string;
  shotLabel: string;
  shotTitle: string;
  sourceAssetBlobKey: string;
  sourceCharacterId: string;
  storyboardDurationSeconds: number;
  productionDurationSeconds: VeoDurationSeconds;
  trimHintSeconds: number;
  subjectMotion: string;
  cameraPreset: VideoCameraPreset;
  motionIntensity: MotionIntensity;
  continuity: string;
  providerPromptDraft: string;
  negativeConstraints: string;
  identityDriftRisk: 'low' | 'medium' | 'high';
  riskWarnings: string[];
}

export interface VideoBlueprintDraft {
  version: typeof VIDEO_BLUEPRINT_VERSION;
  seriesTitle: string;
  projectTitle: string;
  sourceKeyframeQaApprovedAt: number;
  sourceKeyframeQaSavedAt: number;
  sourceBlueprintSavedAt: number;
  sourceAssetSignatures: Array<{
    shotUid: string;
    blobKey: string;
    characterId: string;
  }>;
  items: VideoBlueprintItem[];
  createdAt: number;
  savedAt: number;
}

export interface VideoBlueprintApproval {
  version: typeof VIDEO_BLUEPRINT_APPROVAL_VERSION;
  approvedAt: number;
  blueprintSavedAt: number;
  sourceKeyframeQaApprovedAt: number;
  sourceKeyframeQaSavedAt: number;
  itemCount: number;
  sourceAssetSignatures: VideoBlueprintDraft['sourceAssetSignatures'];
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sameSignatures(
  left: VideoBlueprintDraft['sourceAssetSignatures'],
  right: VideoBlueprintDraft['sourceAssetSignatures'],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return Boolean(other) &&
      item.shotUid === other.shotUid &&
      item.blobKey === other.blobKey &&
      item.characterId === other.characterId;
  });
}

export function normalizeVeoDuration(durationSeconds: number): VeoDurationSeconds {
  const duration = Number.isFinite(durationSeconds) ? Math.max(1, durationSeconds) : 4;
  if (duration <= 4) return 4;
  if (duration <= 6) return 6;
  return 8;
}

export function inferCameraPreset(composition: string): VideoCameraPreset {
  const text = clean(composition).toLowerCase();
  if (/跟拍|tracking|follow/.test(text)) return 'tracking_shot';
  if (/拉远|后拉|pull[- ]?back|zoom out|dolly out/.test(text)) return 'slow_pull';
  if (/推进|推近|push[- ]?in|zoom in|dolly in/.test(text)) return 'slow_push';
  if (/横移|摇摄|pan|横摇/.test(text)) return 'subtle_pan';
  if (/升降|升镜|降镜|boom|pedestal/.test(text)) return 'vertical_boom';
  return 'locked_camera';
}

export function inferMotionIntensity(subjectMotion: string): MotionIntensity {
  const text = clean(subjectMotion);
  if (/呼吸|眨眼|微笑|轻微|微微|细小|subtle|blink|breathing|micro/i.test(text)) return 'minimal';
  return 'natural';
}

export function cameraPresetLabel(preset: VideoCameraPreset): string {
  switch (preset) {
    case 'slow_push': return '缓慢推进';
    case 'slow_pull': return '缓慢拉远';
    case 'subtle_pan': return '轻微横移 / 摇摄';
    case 'tracking_shot': return '平稳跟拍';
    case 'vertical_boom': return '平稳升降';
    default: return '固定机位';
  }
}

export function buildProviderPromptDraft(input: {
  subjectMotion: string;
  durationSeconds: VeoDurationSeconds;
  cameraPreset: VideoCameraPreset;
}): string {
  return PromptCompiler.compileI2VMotionPrompt({
    userMotionPrompt: input.subjectMotion,
    durationSeconds: input.durationSeconds,
    cameraPreset: input.cameraPreset,
  });
}

export function analyzeVideoBlueprintRisk(input: {
  subjectMotion: string;
  durationSeconds: VeoDurationSeconds;
  motionIntensity: MotionIntensity;
}): { identityDriftRisk: 'low' | 'medium' | 'high'; riskWarnings: string[] } {
  const identityRisk = PromptCompiler.classifyIdentityDriftRisk(input.subjectMotion);
  const motionRisk = PromptCompiler.detectMotionRisks(
    input.subjectMotion,
    input.durationSeconds,
    input.motionIntensity,
  );
  const warnings = [...new Set([
    ...(identityRisk.warning ? [identityRisk.warning] : []),
    ...motionRisk.warnings,
  ])];
  let identityDriftRisk = identityRisk.identityDriftRisk;
  if (motionRisk.hasHighRisk) identityDriftRisk = 'high';
  return { identityDriftRisk, riskWarnings: warnings };
}

export function keyframeQaGateMatchesAssets(input: {
  qa: KeyframeQaManifest;
  approval: KeyframeQaApproval;
  assets: KeyframeAssetManifest;
}): boolean {
  if (!isKeyframeQaApprovalCurrent(input.qa, input.approval)) return false;
  if (input.assets.assets.length !== input.qa.items.length) return false;
  const assetByShot = new Map(input.assets.assets.map((asset) => [asset.shotUid, asset]));
  return input.qa.items.every((item) => {
    const asset = assetByShot.get(item.shotUid);
    return Boolean(asset) &&
      asset?.status === 'PASS' &&
      asset?.blobKey === item.assetBlobKey &&
      asset?.characterId === item.characterId;
  });
}

function currentAssetSignatures(assets: KeyframeAssetManifest): VideoBlueprintDraft['sourceAssetSignatures'] {
  return assets.assets.map((asset) => ({
    shotUid: asset.shotUid,
    blobKey: clean(asset.blobKey),
    characterId: clean(asset.characterId),
  }));
}

export function buildVideoBlueprintDraft(input: {
  storyboard: StoryboardForBlueprint;
  keyframeBlueprint: KeyframeBlueprintDraft;
  assets: KeyframeAssetManifest;
  qa: KeyframeQaManifest;
  qaApproval: KeyframeQaApproval;
  now?: number;
}): VideoBlueprintDraft {
  if (!keyframeQaGateMatchesAssets({ qa: input.qa, approval: input.qaApproval, assets: input.assets })) {
    throw new Error('Step 3.3 Keyframe QA 尚未形成与当前关键帧资产一致的 PASS。');
  }
  if (!Array.isArray(input.storyboard.shots) || input.storyboard.shots.length !== input.keyframeBlueprint.blueprints.length) {
    throw new Error('Storyboard 与 Keyframe Blueprint 镜头数量不一致，不能创建 Video Blueprint。');
  }

  const now = input.now ?? Date.now();
  const shotByUid = new Map(input.storyboard.shots.map((shot) => [shot.uid, shot]));
  const assetByShot = new Map(input.assets.assets.map((asset) => [asset.shotUid, asset]));

  const items = input.keyframeBlueprint.blueprints.map((blueprint): VideoBlueprintItem => {
    const shot = shotByUid.get(blueprint.shotUid);
    const asset = assetByShot.get(blueprint.shotUid);
    if (!shot || !asset) throw new Error(`${blueprint.shotLabel} 缺少 Storyboard 或关键帧资产。`);
    const storyboardDurationSeconds = Math.max(1, Number(shot.durationSeconds || 4));
    const productionDurationSeconds = normalizeVeoDuration(storyboardDurationSeconds);
    const subjectMotion = clean(blueprint.keyMoment) || clean(shot.action) || '自然、克制的微动作。';
    const cameraPreset = inferCameraPreset(blueprint.composition || shot.camera);
    const motionIntensity = inferMotionIntensity(subjectMotion);
    const risk = analyzeVideoBlueprintRisk({ subjectMotion, durationSeconds: productionDurationSeconds, motionIntensity });

    return {
      uid: `video-${blueprint.shotUid}`,
      shotUid: blueprint.shotUid,
      shotLabel: blueprint.shotLabel,
      shotTitle: blueprint.shotTitle,
      sourceAssetBlobKey: asset.blobKey,
      sourceCharacterId: asset.characterId,
      storyboardDurationSeconds,
      productionDurationSeconds,
      trimHintSeconds: Math.max(0, productionDurationSeconds - storyboardDurationSeconds),
      subjectMotion,
      cameraPreset,
      motionIntensity,
      continuity: clean(blueprint.continuity) || '保持与关键帧一致的人物、服装、场景、道具和空间方向。',
      providerPromptDraft: buildProviderPromptDraft({ subjectMotion, durationSeconds: productionDurationSeconds, cameraPreset }),
      negativeConstraints: 'Avoid identity drift, face changes, flicker, limb morphing, extra fingers, sudden wardrobe or scene changes, unstable eye gaze, unrequested characters, text, watermark, and abrupt camera shake.',
      ...risk,
    };
  });

  return {
    version: VIDEO_BLUEPRINT_VERSION,
    seriesTitle: input.keyframeBlueprint.seriesTitle,
    projectTitle: input.keyframeBlueprint.projectTitle,
    sourceKeyframeQaApprovedAt: input.qaApproval.approvedAt,
    sourceKeyframeQaSavedAt: input.qa.savedAt,
    sourceBlueprintSavedAt: input.keyframeBlueprint.savedAt,
    sourceAssetSignatures: currentAssetSignatures(input.assets),
    items,
    createdAt: now,
    savedAt: now,
  };
}

export function videoBlueprintMatchesCurrentInputs(input: {
  draft: VideoBlueprintDraft | null | undefined;
  keyframeBlueprint: KeyframeBlueprintDraft;
  assets: KeyframeAssetManifest;
  qa: KeyframeQaManifest;
  qaApproval: KeyframeQaApproval;
}): input is { draft: VideoBlueprintDraft; keyframeBlueprint: KeyframeBlueprintDraft; assets: KeyframeAssetManifest; qa: KeyframeQaManifest; qaApproval: KeyframeQaApproval } {
  const { draft } = input;
  if (!draft || draft.version !== VIDEO_BLUEPRINT_VERSION) return false;
  if (!keyframeQaGateMatchesAssets({ qa: input.qa, approval: input.qaApproval, assets: input.assets })) return false;
  if (draft.sourceKeyframeQaApprovedAt !== input.qaApproval.approvedAt) return false;
  if (draft.sourceKeyframeQaSavedAt !== input.qa.savedAt) return false;
  if (draft.sourceBlueprintSavedAt !== input.keyframeBlueprint.savedAt) return false;
  if (!sameSignatures(draft.sourceAssetSignatures, currentAssetSignatures(input.assets))) return false;
  return draft.items.length === input.keyframeBlueprint.blueprints.length && draft.items.every((item, index) => (
    item.shotUid === input.keyframeBlueprint.blueprints[index]?.shotUid
  ));
}

export function normalizeVideoBlueprintDraft(draft: VideoBlueprintDraft, savedAt = Date.now()): VideoBlueprintDraft {
  return {
    ...draft,
    version: VIDEO_BLUEPRINT_VERSION,
    items: draft.items.map((item) => {
      const productionDurationSeconds = normalizeVeoDuration(item.productionDurationSeconds);
      const subjectMotion = clean(item.subjectMotion);
      const motionIntensity: MotionIntensity = ['minimal', 'natural', 'expressive'].includes(item.motionIntensity)
        ? item.motionIntensity
        : 'natural';
      const risk = analyzeVideoBlueprintRisk({ subjectMotion, durationSeconds: productionDurationSeconds, motionIntensity });
      return {
        ...item,
        shotTitle: clean(item.shotTitle),
        storyboardDurationSeconds: Math.max(1, Number(item.storyboardDurationSeconds || 4)),
        productionDurationSeconds,
        trimHintSeconds: Math.max(0, productionDurationSeconds - Math.max(1, Number(item.storyboardDurationSeconds || 4))),
        subjectMotion,
        motionIntensity,
        continuity: clean(item.continuity),
        providerPromptDraft: clean(item.providerPromptDraft),
        negativeConstraints: clean(item.negativeConstraints),
        ...risk,
      };
    }),
    savedAt,
  };
}

export function refreshVideoBlueprintPrompt(
  draft: VideoBlueprintDraft,
  shotUid: string,
  now = Date.now(),
): VideoBlueprintDraft {
  return {
    ...draft,
    items: draft.items.map((item) => {
      if (item.shotUid !== shotUid) return item;
      const risk = analyzeVideoBlueprintRisk({
        subjectMotion: item.subjectMotion,
        durationSeconds: item.productionDurationSeconds,
        motionIntensity: item.motionIntensity,
      });
      return {
        ...item,
        providerPromptDraft: buildProviderPromptDraft({
          subjectMotion: item.subjectMotion,
          durationSeconds: item.productionDurationSeconds,
          cameraPreset: item.cameraPreset,
        }),
        ...risk,
      };
    }),
    savedAt: now,
  };
}

export function buildVideoBlueprintApproval(
  draft: VideoBlueprintDraft,
  now = Date.now(),
): VideoBlueprintApproval {
  if (!draft.items.length) throw new Error('Video Blueprint 为空，不能确认。');
  for (const item of draft.items) {
    if (!clean(item.subjectMotion)) throw new Error(`${item.shotLabel} 缺少主体动作。`);
    if (!clean(item.providerPromptDraft)) throw new Error(`${item.shotLabel} 缺少 Veo Motion Prompt 草稿。`);
    if (![4, 6, 8].includes(item.productionDurationSeconds)) throw new Error(`${item.shotLabel} Veo 生产时长必须为 4/6/8 秒。`);
  }
  return {
    version: VIDEO_BLUEPRINT_APPROVAL_VERSION,
    approvedAt: now,
    blueprintSavedAt: draft.savedAt,
    sourceKeyframeQaApprovedAt: draft.sourceKeyframeQaApprovedAt,
    sourceKeyframeQaSavedAt: draft.sourceKeyframeQaSavedAt,
    itemCount: draft.items.length,
    sourceAssetSignatures: draft.sourceAssetSignatures,
  };
}

export function isVideoBlueprintApprovalCurrent(
  draft: VideoBlueprintDraft | null | undefined,
  approval: VideoBlueprintApproval | null | undefined,
): boolean {
  if (!draft || !approval) return false;
  if (approval.version !== VIDEO_BLUEPRINT_APPROVAL_VERSION) return false;
  if (approval.blueprintSavedAt !== draft.savedAt) return false;
  if (approval.sourceKeyframeQaApprovedAt !== draft.sourceKeyframeQaApprovedAt) return false;
  if (approval.sourceKeyframeQaSavedAt !== draft.sourceKeyframeQaSavedAt) return false;
  if (approval.itemCount !== draft.items.length) return false;
  return sameSignatures(approval.sourceAssetSignatures, draft.sourceAssetSignatures);
}
