import type { GeneratedStoryboardShot } from './localStoryboardGenerator';
import {
  LEGACY_FORMAT_POLICY,
  normalizeFormatPolicy,
  resolveFormatPolicy,
  type AspectRatio,
  type ProductionFormatPolicy,
} from '../formatPolicy/formatPolicy';
import {
  CURRENT_SERIES_TITLE,
  DIRECTOR_DRAFT_KEY,
  KEYFRAME_BLUEPRINT_APPROVAL_KEY,
  KEYFRAME_BLUEPRINT_KEY,
  KEYFRAME_BLUEPRINT_VERSION,
  STORYBOARD_APPROVAL_KEY,
  STORYBOARD_KEY,
  type KeyframeBlueprint,
  type KeyframeBlueprintDraft,
} from './keyframeBlueprint';
import {
  KEYFRAME_ASSET_APPROVAL_KEY,
  KEYFRAME_ASSET_KEY,
  KEYFRAME_ASSET_VERSION,
  type KeyframeAssetItem,
  type KeyframeAssetManifest,
} from './keyframeAsset';
import { KEYFRAME_QA_APPROVAL_KEY, KEYFRAME_QA_KEY } from './keyframeQa';
import {
  VIDEO_BLUEPRINT_APPROVAL_KEY,
  VIDEO_BLUEPRINT_KEY,
  analyzeVideoBlueprintRisk,
  buildProviderPromptDraft,
  inferCameraPreset,
  inferMotionIntensity,
  normalizeVeoDuration,
  type VeoDurationSeconds,
  type VideoCameraPreset,
} from './videoBlueprint';
import type { MotionIntensity } from '../prompt/PromptCompiler';

export const SHOT_VIDEO_BLUEPRINT_VERSION = 'shot-video-blueprint-v0.4.2' as const;

export interface StoryboardDraftForWorkflow {
  version: 'manual-storyboard-v0.2';
  shots: GeneratedStoryboardShot[];
  savedAt?: number;
  generatedAt?: number;
  generationEngine?: string;
  generationModel?: string;
}

export interface ShotAwareBlueprint extends KeyframeBlueprint {
  sourceVisualSignature?: string;
  sourceTimingSignature?: string;
  sourcePreviousShotUid?: string;
}

export interface ShotVideoBlueprintItem {
  uid: string;
  shotUid: string;
  shotLabel: string;
  shotTitle: string;
  sourceAssetBlobKey: string;
  sourceAssetApprovedAt: number;
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
  status: 'DRAFT' | 'PASS';
  approvedAt: number | null;
  savedAt: number;
}

export interface ShotVideoBlueprintManifest {
  version: typeof SHOT_VIDEO_BLUEPRINT_VERSION;
  items: ShotVideoBlueprintItem[];
  createdAt: number;
  savedAt: number;
}

export interface ShotPipelineSyncResult {
  storyboard: StoryboardDraftForWorkflow;
  blueprint: KeyframeBlueprintDraft;
  assets: KeyframeAssetManifest;
  videos: ShotVideoBlueprintManifest;
  invalidatedKeyframeShotUids: string[];
  invalidatedVideoShotUids: string[];
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function shotLabel(index: number) {
  return `S${String(index + 1).padStart(2, '0')}`;
}

export function visualSignature(shot: GeneratedStoryboardShot, aspectRatio?: AspectRatio): string {
  return JSON.stringify({
    scene: clean(shot.scene),
    camera: clean(shot.camera),
    action: clean(shot.action),
    dialogue: clean(shot.dialogue),
    notes: clean(shot.notes),
    aspectRatio: aspectRatio || shot.formatPolicy?.aspectRatio || '',
  });
}

export function timingSignature(shot: GeneratedStoryboardShot): string {
  return String(Math.max(1, Number(shot.durationSeconds || 1)));
}

function createBlueprint(
  shot: GeneratedStoryboardShot,
  index: number,
  projectTitle: string,
  productionNotes: string,
  previousShotUid: string,
  aspectRatio: AspectRatio,
): ShotAwareBlueprint {
  const label = shotLabel(index);
  const continuity = [clean(productionNotes), clean(shot.notes)]
    .filter(Boolean)
    .join('；') || '保持人物身份、服装、道具、空间方向与相邻镜头连续。';
  const dialogueHint = clean(shot.dialogue)
    ? `对白/旁白语义仅用于表演情绪参考：${clean(shot.dialogue)}。`
    : '';
  return {
    uid: `keyframe-${shot.uid}`,
    shotUid: shot.uid,
    shotLabel: label,
    shotTitle: clean(shot.title) || label,
    visualDescription: `${clean(shot.action)}；关键帧冻结这一镜最具叙事信息、最适合作为视频首帧的静态瞬间。`,
    characterReference: '使用本项目已确认的角色母板；若该镜头无人物，则改为“无人物”。',
    characterState: clean(shot.notes) || '保持与前后镜头一致的角色身份、发型、服装、表情与身体比例。',
    scene: clean(shot.scene),
    composition: clean(shot.camera),
    keyMoment: clean(shot.action),
    props: clean(shot.notes) ? `按分镜备注保留必要道具：${clean(shot.notes)}` : '按画面动作保留必要道具；无关键道具时填写“无”。',
    lighting: `依据“${clean(shot.scene)}”建立自然、可信且与相邻镜头连续的环境光与时间感。`,
    continuity,
    imagePrompt: [
      `${aspectRatio} 电影感关键帧。`,
      `场景：${clean(shot.scene)}。`,
      `构图与镜头语言：${clean(shot.camera)}。`,
      `冻结瞬间：${clean(shot.action)}。`,
      dialogueHint,
      `连续性：${continuity}。`,
      '画面必须是可作为后续图生视频首帧的单一稳定瞬间，主体清晰，空间关系明确，不表现时间连续动作。',
    ].filter(Boolean).join(' '),
    negativePrompt: '人物身份漂移、换脸、服装变化、场景跳变、左右方向错误、肢体异常、额外手指或手臂、重复人物、文字水印、UI 元素、过度磨皮、塑料皮、失焦主体、构图裁切错误。',
    sourceVisualSignature: visualSignature(shot, aspectRatio),
    sourceTimingSignature: timingSignature(shot),
    sourcePreviousShotUid: previousShotUid,
  };
}

function emptyAsset(blueprint: KeyframeBlueprint): KeyframeAssetItem {
  return {
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
  };
}

function createVideoItem(input: {
  shot: GeneratedStoryboardShot;
  blueprint: KeyframeBlueprint;
  asset: KeyframeAssetItem;
  label: string;
  now: number;
}): ShotVideoBlueprintItem {
  const storyboardDurationSeconds = Math.max(1, Number(input.shot.durationSeconds || 4));
  const productionDurationSeconds = normalizeVeoDuration(storyboardDurationSeconds);
  const subjectMotion = clean(input.blueprint.keyMoment) || clean(input.shot.action) || '自然、克制的微动作。';
  const cameraPreset = inferCameraPreset(input.blueprint.composition || input.shot.camera);
  const motionIntensity = inferMotionIntensity(subjectMotion);
  const risk = analyzeVideoBlueprintRisk({ subjectMotion, durationSeconds: productionDurationSeconds, motionIntensity });
  return {
    uid: `video-${input.shot.uid}`,
    shotUid: input.shot.uid,
    shotLabel: input.label,
    shotTitle: clean(input.blueprint.shotTitle) || clean(input.shot.title) || input.label,
    sourceAssetBlobKey: input.asset.blobKey,
    sourceAssetApprovedAt: Number(input.asset.approvedAt || 0),
    sourceCharacterId: input.asset.characterId,
    storyboardDurationSeconds,
    productionDurationSeconds,
    trimHintSeconds: Math.max(0, productionDurationSeconds - storyboardDurationSeconds),
    subjectMotion,
    cameraPreset,
    motionIntensity,
    continuity: clean(input.blueprint.continuity) || '保持与关键帧一致的人物、服装、场景、道具和空间方向。',
    providerPromptDraft: buildProviderPromptDraft({ subjectMotion, durationSeconds: productionDurationSeconds, cameraPreset }),
    negativeConstraints: 'Avoid identity drift, face changes, flicker, limb morphing, extra fingers, sudden wardrobe or scene changes, unstable eye gaze, unrequested characters, text, watermark, and abrupt camera shake.',
    ...risk,
    status: 'DRAFT',
    approvedAt: null,
    savedAt: input.now,
  };
}

export function syncShotPipeline(input: {
  storyboard: StoryboardDraftForWorkflow;
  existingBlueprint?: KeyframeBlueprintDraft | null;
  existingAssets?: KeyframeAssetManifest | null;
  existingVideos?: ShotVideoBlueprintManifest | null;
  projectTitle?: string;
  productionNotes?: string;
  formatPolicy?: ProductionFormatPolicy;
  now?: number;
}): ShotPipelineSyncResult {
  const now = input.now ?? Date.now();
  const projectFormatPolicy = normalizeFormatPolicy(input.formatPolicy, LEGACY_FORMAT_POLICY);
  const shots = Array.isArray(input.storyboard.shots) ? input.storyboard.shots : [];
  const oldBlueprints = new Map((input.existingBlueprint?.blueprints || []).map((item) => [item.shotUid, item as ShotAwareBlueprint]));
  const invalidatedKeyframeShotUids = new Set<string>();
  const invalidatedVideoShotUids = new Set<string>();

  const blueprints = shots.map((shot, index) => {
    const aspectRatio = resolveFormatPolicy({
      projectPolicy: projectFormatPolicy,
      shotOverride: shot.formatPolicy,
    }).expectedAspectRatio;
    const label = shotLabel(index);
    const previousShotUid = index > 0 ? shots[index - 1].uid : '';
    const old = oldBlueprints.get(shot.uid);
    const nextVisual = visualSignature(shot, aspectRatio);
    const nextTiming = timingSignature(shot);
    if (!old) {
      invalidatedKeyframeShotUids.add(shot.uid);
      invalidatedVideoShotUids.add(shot.uid);
      return createBlueprint(shot, index, clean(input.projectTitle), clean(input.productionNotes), previousShotUid, aspectRatio);
    }

    const hadVisualSignature = typeof old.sourceVisualSignature === 'string';
    const hadTimingSignature = typeof old.sourceTimingSignature === 'string';
    const hadPrevious = typeof old.sourcePreviousShotUid === 'string';
    const visualChanged = hadVisualSignature && old.sourceVisualSignature !== nextVisual;
    const timingChanged = hadTimingSignature && old.sourceTimingSignature !== nextTiming;
    const predecessorChanged = hadPrevious && old.sourcePreviousShotUid !== previousShotUid;

    if (visualChanged) invalidatedKeyframeShotUids.add(shot.uid);
    if (predecessorChanged) invalidatedKeyframeShotUids.add(shot.uid);
    if (visualChanged || predecessorChanged || timingChanged) invalidatedVideoShotUids.add(shot.uid);

    if (visualChanged) {
      return createBlueprint(shot, index, clean(input.projectTitle), clean(input.productionNotes), previousShotUid, aspectRatio);
    }

    return {
      ...old,
      shotLabel: label,
      shotTitle: clean(shot.title) || label,
      sourceVisualSignature: nextVisual,
      sourceTimingSignature: nextTiming,
      sourcePreviousShotUid: previousShotUid,
    };
  });

  const blueprint: KeyframeBlueprintDraft = {
    version: KEYFRAME_BLUEPRINT_VERSION,
    seriesTitle: input.existingBlueprint?.seriesTitle || CURRENT_SERIES_TITLE,
    projectTitle: clean(input.projectTitle) || input.existingBlueprint?.projectTitle || '未命名项目',
    sourceStoryboardSavedAt: Number(input.storyboard.savedAt || now),
    sourceStoryboardApprovedAt: 0,
    blueprints,
    createdAt: input.existingBlueprint?.createdAt || now,
    savedAt: now,
  };

  const oldAssets = new Map((input.existingAssets?.assets || []).map((item) => [item.shotUid, item]));
  const assets: KeyframeAssetItem[] = blueprints.map((item) => {
    const old = oldAssets.get(item.shotUid);
    if (!old) return emptyAsset(item);
    const mustReview = invalidatedKeyframeShotUids.has(item.shotUid);
    return {
      ...old,
      shotLabel: item.shotLabel,
      blueprintUid: item.uid,
      blueprintPrompt: clean(item.imagePrompt),
      ...(mustReview && old.status === 'PASS' ? { status: old.blobKey ? 'READY' as const : 'EMPTY' as const, approvedAt: null } : {}),
    };
  });

  const assetManifest: KeyframeAssetManifest = {
    version: KEYFRAME_ASSET_VERSION,
    sourceBlueprintSavedAt: blueprint.savedAt,
    sourceBlueprintApprovedAt: 0,
    sourceStoryboardSavedAt: Number(input.storyboard.savedAt || now),
    assets,
    createdAt: input.existingAssets?.createdAt || now,
    savedAt: now,
  };

  const oldVideos = input.existingVideos?.version === SHOT_VIDEO_BLUEPRINT_VERSION
    ? new Map(input.existingVideos.items.map((item) => [item.shotUid, item]))
    : new Map<string, ShotVideoBlueprintItem>();
  const blueprintByShot = new Map(blueprints.map((item) => [item.shotUid, item]));
  const assetByShot = new Map(assets.map((item) => [item.shotUid, item]));
  const videoItems: ShotVideoBlueprintItem[] = [];

  shots.forEach((shot, index) => {
    const asset = assetByShot.get(shot.uid);
    const itemBlueprint = blueprintByShot.get(shot.uid);
    if (!asset || !itemBlueprint || asset.status !== 'PASS' || !asset.blobKey || !asset.approvedAt) return;
    const old = oldVideos.get(shot.uid);
    const label = shotLabel(index);
    const sourceChanged = !old ||
      old.sourceAssetBlobKey !== asset.blobKey ||
      old.sourceAssetApprovedAt !== asset.approvedAt ||
      invalidatedVideoShotUids.has(shot.uid);
    if (sourceChanged) {
      videoItems.push(createVideoItem({ shot, blueprint: itemBlueprint, asset, label, now }));
      return;
    }
    videoItems.push({
      ...old,
      shotLabel: label,
      shotTitle: clean(itemBlueprint.shotTitle) || clean(shot.title) || label,
      storyboardDurationSeconds: Math.max(1, Number(shot.durationSeconds || 4)),
      trimHintSeconds: Math.max(0, old.productionDurationSeconds - Math.max(1, Number(shot.durationSeconds || 4))),
    });
  });

  const videos: ShotVideoBlueprintManifest = {
    version: SHOT_VIDEO_BLUEPRINT_VERSION,
    items: videoItems,
    createdAt: input.existingVideos?.version === SHOT_VIDEO_BLUEPRINT_VERSION ? input.existingVideos.createdAt : now,
    savedAt: now,
  };

  return {
    storyboard: input.storyboard,
    blueprint,
    assets: assetManifest,
    videos,
    invalidatedKeyframeShotUids: [...invalidatedKeyframeShotUids],
    invalidatedVideoShotUids: [...invalidatedVideoShotUids],
  };
}

export function readCurrentStoryboard(): StoryboardDraftForWorkflow | null {
  return readJson<StoryboardDraftForWorkflow>(STORYBOARD_KEY);
}

export function syncLocalShotPipeline(now = Date.now()): ShotPipelineSyncResult | null {
  const storyboard = readCurrentStoryboard();
  if (!storyboard?.shots?.length) return null;
  const project = readJson<{ title?: string; productionNotes?: string; formatPolicy?: ProductionFormatPolicy }>(DIRECTOR_DRAFT_KEY) || {};
  const result = syncShotPipeline({
    storyboard,
    existingBlueprint: readJson<KeyframeBlueprintDraft>(KEYFRAME_BLUEPRINT_KEY),
    existingAssets: readJson<KeyframeAssetManifest>(KEYFRAME_ASSET_KEY),
    existingVideos: readJson<ShotVideoBlueprintManifest>(VIDEO_BLUEPRINT_KEY),
    projectTitle: project.title,
    productionNotes: project.productionNotes,
    formatPolicy: project.formatPolicy,
    now,
  });
  window.localStorage.setItem(KEYFRAME_BLUEPRINT_KEY, JSON.stringify(result.blueprint));
  window.localStorage.setItem(KEYFRAME_ASSET_KEY, JSON.stringify(result.assets));
  window.localStorage.setItem(VIDEO_BLUEPRINT_KEY, JSON.stringify(result.videos));
  window.localStorage.removeItem(KEYFRAME_BLUEPRINT_APPROVAL_KEY);
  window.localStorage.removeItem(KEYFRAME_ASSET_APPROVAL_KEY);
  window.localStorage.removeItem(KEYFRAME_QA_KEY);
  window.localStorage.removeItem(KEYFRAME_QA_APPROVAL_KEY);
  window.localStorage.removeItem(VIDEO_BLUEPRINT_APPROVAL_KEY);
  return result;
}

export function saveStoryboardAndSync(
  storyboard: StoryboardDraftForWorkflow,
  now = Date.now(),
): ShotPipelineSyncResult {
  const normalized: StoryboardDraftForWorkflow = {
    ...storyboard,
    version: 'manual-storyboard-v0.2',
    shots: storyboard.shots.map((shot) => ({
      ...shot,
      title: clean(shot.title),
      durationSeconds: Math.max(1, Math.min(60, Number(shot.durationSeconds || 1))),
      scene: clean(shot.scene),
      action: clean(shot.action),
      camera: clean(shot.camera),
      dialogue: clean(shot.dialogue),
      notes: clean(shot.notes),
    })),
    savedAt: now,
  };
  window.localStorage.setItem(STORYBOARD_KEY, JSON.stringify(normalized));
  window.localStorage.removeItem(STORYBOARD_APPROVAL_KEY);
  const project = readJson<{ title?: string; productionNotes?: string; formatPolicy?: ProductionFormatPolicy }>(DIRECTOR_DRAFT_KEY) || {};
  const result = syncShotPipeline({
    storyboard: normalized,
    existingBlueprint: readJson<KeyframeBlueprintDraft>(KEYFRAME_BLUEPRINT_KEY),
    existingAssets: readJson<KeyframeAssetManifest>(KEYFRAME_ASSET_KEY),
    existingVideos: readJson<ShotVideoBlueprintManifest>(VIDEO_BLUEPRINT_KEY),
    projectTitle: project.title,
    productionNotes: project.productionNotes,
    formatPolicy: project.formatPolicy,
    now,
  });
  window.localStorage.setItem(KEYFRAME_BLUEPRINT_KEY, JSON.stringify(result.blueprint));
  window.localStorage.setItem(KEYFRAME_ASSET_KEY, JSON.stringify(result.assets));
  window.localStorage.setItem(VIDEO_BLUEPRINT_KEY, JSON.stringify(result.videos));
  window.localStorage.removeItem(KEYFRAME_BLUEPRINT_APPROVAL_KEY);
  window.localStorage.removeItem(KEYFRAME_ASSET_APPROVAL_KEY);
  window.localStorage.removeItem(KEYFRAME_QA_KEY);
  window.localStorage.removeItem(KEYFRAME_QA_APPROVAL_KEY);
  window.localStorage.removeItem(VIDEO_BLUEPRINT_APPROVAL_KEY);
  return result;
}

export function persistManualKeyframeAssets(manifest: KeyframeAssetManifest, now = Date.now()): ShotPipelineSyncResult | null {
  const next = { ...manifest, savedAt: now };
  window.localStorage.setItem(KEYFRAME_ASSET_KEY, JSON.stringify(next));
  window.localStorage.removeItem(KEYFRAME_ASSET_APPROVAL_KEY);
  window.localStorage.removeItem(KEYFRAME_QA_KEY);
  window.localStorage.removeItem(KEYFRAME_QA_APPROVAL_KEY);
  return syncLocalShotPipeline(now);
}

export function persistShotVideoBlueprints(manifest: ShotVideoBlueprintManifest, now = Date.now()) {
  const next = { ...manifest, version: SHOT_VIDEO_BLUEPRINT_VERSION, savedAt: now };
  window.localStorage.setItem(VIDEO_BLUEPRINT_KEY, JSON.stringify(next));
  window.localStorage.removeItem(VIDEO_BLUEPRINT_APPROVAL_KEY);
  return next;
}
