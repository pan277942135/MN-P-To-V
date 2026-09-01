import type { GeneratedStoryboardShot } from './localStoryboardGenerator';
import {
  LEGACY_FORMAT_POLICY,
  normalizeAspectRatio,
  resolveFormatPolicy,
  type AspectRatio,
  type ProductionFormatPolicy,
} from '../formatPolicy/formatPolicy';

export const DIRECTOR_DRAFT_KEY = 'zaojing_director_v01_brief';
export const STORYBOARD_KEY = 'zaojing_director_v02_storyboard';
export const STORYBOARD_APPROVAL_KEY = 'zaojing_director_v021_storyboard_approval';
export const KEYFRAME_BLUEPRINT_KEY = 'zaojing_director_v031_keyframe_blueprints';
export const KEYFRAME_BLUEPRINT_APPROVAL_KEY = 'zaojing_director_v031_keyframe_approval';
export const KEYFRAME_BLUEPRINT_VERSION = 'keyframe-blueprint-v0.3.1' as const;
export const KEYFRAME_BLUEPRINT_APPROVAL_VERSION = 'keyframe-blueprint-approval-v0.3.1' as const;
export const CURRENT_SERIES_TITLE = '《风从那年教室吹过》系列';

export interface StoryboardForBlueprint {
  version?: string;
  shots: GeneratedStoryboardShot[];
  savedAt?: number;
}

export interface StoryboardApprovalForBlueprint {
  approvedAt: number;
  shotCount: number;
  storyboardSavedAt: number;
}

export interface KeyframeBlueprint {
  uid: string;
  shotUid: string;
  shotLabel: string;
  shotTitle: string;
  visualDescription: string;
  characterReference: string;
  characterState: string;
  scene: string;
  composition: string;
  keyMoment: string;
  props: string;
  lighting: string;
  continuity: string;
  imagePrompt: string;
  negativePrompt: string;
}

export interface KeyframeBlueprintDraft {
  version: typeof KEYFRAME_BLUEPRINT_VERSION;
  seriesTitle: string;
  projectTitle: string;
  sourceStoryboardSavedAt: number;
  sourceStoryboardApprovedAt: number;
  blueprints: KeyframeBlueprint[];
  createdAt: number;
  savedAt: number;
}

export interface KeyframeBlueprintApproval {
  version: typeof KEYFRAME_BLUEPRINT_APPROVAL_VERSION;
  approvedAt: number;
  blueprintSavedAt: number;
  sourceStoryboardSavedAt: number;
  blueprintCount: number;
}

export class KeyframeBlueprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyframeBlueprintError';
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function shotLabel(index: number): string {
  return `S${String(index + 1).padStart(2, '0')}`;
}

export function isStoryboardApprovalCurrent(
  storyboard: StoryboardForBlueprint | null | undefined,
  approval: StoryboardApprovalForBlueprint | null | undefined,
): boolean {
  if (!storyboard || !approval || !Array.isArray(storyboard.shots) || storyboard.shots.length === 0) {
    return false;
  }
  if (!storyboard.savedAt || storyboard.savedAt !== approval.storyboardSavedAt) return false;
  return storyboard.shots.length === approval.shotCount;
}

function buildContinuity(shot: GeneratedStoryboardShot, productionNotes: string): string {
  return [clean(productionNotes), clean(shot.notes)]
    .filter(Boolean)
    .join('；') || '保持人物身份、服装、道具、空间方向与相邻镜头连续。';
}

function buildImagePrompt(
  shot: GeneratedStoryboardShot,
  continuity: string,
  aspectRatio: AspectRatio,
): string {
  const dialogueHint = clean(shot.dialogue)
    ? `对白/旁白语义仅用于表演情绪参考：${clean(shot.dialogue)}。`
    : '';
  return [
    `${aspectRatio} 电影感关键帧。`,
    `场景：${clean(shot.scene)}。`,
    `构图与镜头语言：${clean(shot.camera)}。`,
    `冻结瞬间：${clean(shot.action)}。`,
    dialogueHint,
    `连续性：${continuity}。`,
    '画面必须是可作为后续图生视频首帧的单一稳定瞬间，主体清晰，空间关系明确，不表现时间连续动作。',
  ].filter(Boolean).join(' ');
}

export function buildKeyframeBlueprintDraft(input: {
  projectTitle: string;
  productionNotes?: string;
  storyboard: StoryboardForBlueprint;
  approval: StoryboardApprovalForBlueprint;
  aspectRatio?: AspectRatio;
  formatPolicy?: ProductionFormatPolicy;
  now?: number;
}): KeyframeBlueprintDraft {
  const { storyboard, approval } = input;
  if (!isStoryboardApprovalCurrent(storyboard, approval)) {
    throw new KeyframeBlueprintError('Storyboard 尚未形成与当前版本一致的 PASS，不能创建 Keyframe Blueprint。');
  }

  const now = input.now ?? Date.now();
  const productionNotes = clean(input.productionNotes);
  const blueprints = storyboard.shots.map((shot, index): KeyframeBlueprint => {
    const aspectRatio = resolveFormatPolicy({
      projectPolicy: input.formatPolicy || (input.aspectRatio ? {
        ...LEGACY_FORMAT_POLICY,
        defaultAspectRatio: normalizeAspectRatio(input.aspectRatio, LEGACY_FORMAT_POLICY.defaultAspectRatio),
        allowedAspectRatios: [normalizeAspectRatio(input.aspectRatio, LEGACY_FORMAT_POLICY.defaultAspectRatio)],
      } : undefined),
      shotOverride: shot.formatPolicy,
    }).expectedAspectRatio;
    const label = shotLabel(index);
    const continuity = buildContinuity(shot, productionNotes);
    const notes = clean(shot.notes);

    return {
      uid: `keyframe-${shot.uid}`,
      shotUid: shot.uid,
      shotLabel: label,
      shotTitle: clean(shot.title) || label,
      visualDescription: `${clean(shot.action)}；关键帧冻结这一镜最具叙事信息、最适合作为视频首帧的静态瞬间。`,
      characterReference: '使用本项目已确认的角色母板；若该镜头无人物，则改为“无人物”。',
      characterState: notes || '保持与前后镜头一致的角色身份、发型、服装、表情与身体比例。',
      scene: clean(shot.scene),
      composition: clean(shot.camera),
      keyMoment: clean(shot.action),
      props: notes ? `按分镜备注保留必要道具：${notes}` : '按画面动作保留必要道具；无关键道具时填写“无”。',
      lighting: `依据“${clean(shot.scene)}”建立自然、可信且与相邻镜头连续的环境光与时间感。`,
      continuity,
      imagePrompt: buildImagePrompt(shot, continuity, aspectRatio),
      negativePrompt: '人物身份漂移、换脸、服装变化、场景跳变、左右方向错误、肢体异常、额外手指或手臂、重复人物、文字水印、UI 元素、过度磨皮、塑料皮、失焦主体、构图裁切错误。',
    };
  });

  return {
    version: KEYFRAME_BLUEPRINT_VERSION,
    seriesTitle: CURRENT_SERIES_TITLE,
    projectTitle: clean(input.projectTitle) || '未命名项目',
    sourceStoryboardSavedAt: approval.storyboardSavedAt,
    sourceStoryboardApprovedAt: approval.approvedAt,
    blueprints,
    createdAt: now,
    savedAt: now,
  };
}

export function normalizeKeyframeBlueprintDraft(
  draft: KeyframeBlueprintDraft,
  savedAt = Date.now(),
): KeyframeBlueprintDraft {
  return {
    ...draft,
    version: KEYFRAME_BLUEPRINT_VERSION,
    seriesTitle: CURRENT_SERIES_TITLE,
    blueprints: draft.blueprints.map((item, index) => ({
      ...item,
      shotLabel: shotLabel(index),
      shotTitle: clean(item.shotTitle),
      visualDescription: clean(item.visualDescription),
      characterReference: clean(item.characterReference),
      characterState: clean(item.characterState),
      scene: clean(item.scene),
      composition: clean(item.composition),
      keyMoment: clean(item.keyMoment),
      props: clean(item.props),
      lighting: clean(item.lighting),
      continuity: clean(item.continuity),
      imagePrompt: clean(item.imagePrompt),
      negativePrompt: clean(item.negativePrompt),
    })),
    savedAt,
  };
}

export function findIncompleteBlueprintIndex(draft: KeyframeBlueprintDraft): number {
  return draft.blueprints.findIndex((item) => (
    !clean(item.visualDescription) ||
    !clean(item.characterReference) ||
    !clean(item.characterState) ||
    !clean(item.scene) ||
    !clean(item.composition) ||
    !clean(item.keyMoment) ||
    !clean(item.props) ||
    !clean(item.lighting) ||
    !clean(item.continuity) ||
    !clean(item.imagePrompt) ||
    !clean(item.negativePrompt)
  ));
}
