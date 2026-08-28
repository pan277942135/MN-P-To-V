import { describe, expect, it } from 'vitest';
import type { KeyframeBlueprintDraft, StoryboardForBlueprint } from '../services/director/keyframeBlueprint';
import type { KeyframeAssetManifest } from '../services/director/keyframeAsset';
import type { KeyframeQaApproval, KeyframeQaManifest } from '../services/director/keyframeQa';
import {
  buildVideoBlueprintApproval,
  buildVideoBlueprintDraft,
  isVideoBlueprintApprovalCurrent,
  normalizeVeoDuration,
} from '../services/director/videoBlueprint';

function fixture() {
  const storyboard: StoryboardForBlueprint = {
    savedAt: 100,
    shots: [
      { uid: 'shot-a', title: '窗边回头', durationSeconds: 5, scene: '教室午后', camera: '中景，缓慢推进', action: '风吹窗帘，女生轻轻回头。', dialogue: '', notes: '' },
      { uid: 'shot-b', title: '后排停顿', durationSeconds: 7, scene: '同一教室', camera: '中近景，固定机位', action: '男生握笔停顿，抬眼看向前方。', dialogue: '', notes: '' },
    ],
  };
  const keyframeBlueprint: KeyframeBlueprintDraft = {
    version: 'keyframe-blueprint-v0.3.1',
    seriesTitle: '《风从那年教室吹过》系列',
    projectTitle: '第01集',
    sourceStoryboardSavedAt: 100,
    sourceStoryboardApprovedAt: 110,
    blueprints: [
      { uid: 'keyframe-shot-a', shotUid: 'shot-a', shotLabel: 'S01', shotTitle: '窗边回头', visualDescription: '', characterReference: '', characterState: '', scene: '教室午后', composition: '中景，缓慢推进', keyMoment: '风吹窗帘，女生轻轻回头。', props: '', lighting: '', continuity: '校服与发型保持一致。', imagePrompt: '', negativePrompt: '' },
      { uid: 'keyframe-shot-b', shotUid: 'shot-b', shotLabel: 'S02', shotTitle: '后排停顿', visualDescription: '', characterReference: '', characterState: '', scene: '同一教室', composition: '中近景，固定机位', keyMoment: '男生握笔停顿，抬眼看向前方。', props: '', lighting: '', continuity: '桌椅、光线与人物位置连续。', imagePrompt: '', negativePrompt: '' },
    ],
    createdAt: 120,
    savedAt: 130,
  };
  const assets: KeyframeAssetManifest = {
    version: 'keyframe-asset-v0.3.2',
    sourceBlueprintSavedAt: 130,
    sourceBlueprintApprovedAt: 135,
    sourceStoryboardSavedAt: 100,
    assets: [
      { uid: 'asset-a', shotUid: 'shot-a', shotLabel: 'S01', blueprintUid: 'keyframe-shot-a', blueprintPrompt: '', status: 'PASS', source: 'upload', blobKey: 'blob-a', fileName: 'a.png', mimeType: 'image/png', sizeBytes: 1, characterId: 'char-a', provider: '', model: '', createdAt: 140, approvedAt: 160, qaNote: '' },
      { uid: 'asset-b', shotUid: 'shot-b', shotLabel: 'S02', blueprintUid: 'keyframe-shot-b', blueprintPrompt: '', status: 'PASS', source: 'upload', blobKey: 'blob-b', fileName: 'b.png', mimeType: 'image/png', sizeBytes: 1, characterId: 'char-b', provider: '', model: '', createdAt: 141, approvedAt: 161, qaNote: '' },
    ],
    createdAt: 140,
    savedAt: 161,
  };
  const qa: KeyframeQaManifest = {
    version: 'keyframe-qa-v0.3.3',
    sourceBlueprintSavedAt: 130,
    items: [
      { uid: 'qa-a', shotUid: 'shot-a', shotLabel: 'S01', blueprintUid: 'keyframe-shot-a', assetBlobKey: 'blob-a', previousAssetBlobKey: '', characterId: 'char-a', autoStatus: 'PASS', report: { provider: 'vertex-gemini', model: 'gemini-2.5-flash', analyzedAt: 150, pass: true, identityAssessed: true, continuityAssessed: false, scores: { identityScore: 98, promptComplianceScore: 95, anatomyScore: 96, visualQualityScore: 94, compositionScore: 92, continuityScore: null }, issues: [], warnings: [], summary: 'pass', repairInstruction: '' }, humanDecision: 'APPROVED', humanReviewedAt: 160, humanNote: '' },
      { uid: 'qa-b', shotUid: 'shot-b', shotLabel: 'S02', blueprintUid: 'keyframe-shot-b', assetBlobKey: 'blob-b', previousAssetBlobKey: 'blob-a', characterId: 'char-b', autoStatus: 'PASS', report: { provider: 'vertex-gemini', model: 'gemini-2.5-flash', analyzedAt: 151, pass: true, identityAssessed: true, continuityAssessed: true, scores: { identityScore: 97, promptComplianceScore: 94, anatomyScore: 95, visualQualityScore: 93, compositionScore: 91, continuityScore: 94 }, issues: [], warnings: [], summary: 'pass', repairInstruction: '' }, humanDecision: 'APPROVED', humanReviewedAt: 161, humanNote: '' },
    ],
    createdAt: 150,
    savedAt: 161,
  };
  const qaApproval: KeyframeQaApproval = {
    version: 'keyframe-qa-approval-v0.3.3',
    approvedAt: 162,
    sourceBlueprintSavedAt: 130,
    itemCount: 2,
    assetSignatures: [
      { shotUid: 'shot-a', assetBlobKey: 'blob-a', characterId: 'char-a' },
      { shotUid: 'shot-b', assetBlobKey: 'blob-b', characterId: 'char-b' },
    ],
  };
  return { storyboard, keyframeBlueprint, assets, qa, qaApproval };
}

describe('Step 4.1 Video Blueprint', () => {
  it('normalizes storyboard durations to Veo 4/6/8-second production clips', () => {
    expect(normalizeVeoDuration(2)).toBe(4);
    expect(normalizeVeoDuration(4)).toBe(4);
    expect(normalizeVeoDuration(5)).toBe(6);
    expect(normalizeVeoDuration(7)).toBe(8);
  });

  it('creates S01–Sn video blueprints bound to stable shot and approved keyframe assets', () => {
    const input = fixture();
    const draft = buildVideoBlueprintDraft({ ...input, now: 200 });

    expect(draft.items).toHaveLength(2);
    expect(draft.items[0]).toMatchObject({ shotUid: 'shot-a', shotLabel: 'S01', sourceAssetBlobKey: 'blob-a', storyboardDurationSeconds: 5, productionDurationSeconds: 6, trimHintSeconds: 1, cameraPreset: 'slow_push' });
    expect(draft.items[1]).toMatchObject({ shotUid: 'shot-b', shotLabel: 'S02', sourceAssetBlobKey: 'blob-b', storyboardDurationSeconds: 7, productionDurationSeconds: 8, trimHintSeconds: 1, cameraPreset: 'locked_camera' });
    expect(draft.items[0].providerPromptDraft).toContain('Use the uploaded image as the exact first frame.');
  });

  it('fails closed if current keyframe assets no longer match Step 3.3 approval', () => {
    const input = fixture();
    input.assets.assets[0].blobKey = 'replacement-blob';
    expect(() => buildVideoBlueprintDraft({ ...input, now: 200 })).toThrow(/Step 3.3/);
  });

  it('requires explicit approval and invalidates approval when blueprint savedAt changes', () => {
    const input = fixture();
    const draft = buildVideoBlueprintDraft({ ...input, now: 200 });
    const approval = buildVideoBlueprintApproval(draft, 210);
    expect(isVideoBlueprintApprovalCurrent(draft, approval)).toBe(true);
    expect(isVideoBlueprintApprovalCurrent({ ...draft, savedAt: 211 }, approval)).toBe(false);
  });
});
