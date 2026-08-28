import { describe, expect, it } from 'vitest';
import type { KeyframeBlueprintApproval, KeyframeBlueprintDraft } from '../services/director/keyframeBlueprint';
import {
  approveKeyframeAsset,
  attachKeyframeAsset,
  buildKeyframeAssetApproval,
  buildKeyframeAssetManifest,
  isKeyframeAssetManifestComplete,
  isKeyframeBlueprintApprovalCurrent,
  manifestMatchesCurrentBlueprint,
  updateKeyframeAssetQa,
} from '../services/director/keyframeAsset';

const draft: KeyframeBlueprintDraft = {
  version: 'keyframe-blueprint-v0.3.1',
  seriesTitle: '《风从那年教室吹过》系列',
  projectTitle: '第01集',
  sourceStoryboardSavedAt: 100,
  sourceStoryboardApprovedAt: 120,
  createdAt: 130,
  savedAt: 200,
  blueprints: [
    {
      uid: 'keyframe-shot-a',
      shotUid: 'shot-a',
      shotLabel: 'S01',
      shotTitle: '窗边',
      visualDescription: '女生回头。',
      characterReference: '女主母板',
      characterState: '校服',
      scene: '教室',
      composition: '中景',
      keyMoment: '回头',
      props: '书本',
      lighting: '午后',
      continuity: '校服连续',
      imagePrompt: '9:16 教室中景',
      negativePrompt: '换脸',
    },
    {
      uid: 'keyframe-shot-b',
      shotUid: 'shot-b',
      shotLabel: 'S02',
      shotTitle: '走廊',
      visualDescription: '两人擦肩。',
      characterReference: '男女主母板',
      characterState: '校服',
      scene: '走廊',
      composition: '中近景',
      keyMoment: '擦肩',
      props: '书包',
      lighting: '傍晚',
      continuity: '书包连续',
      imagePrompt: '9:16 走廊中近景',
      negativePrompt: '肢体异常',
    },
  ],
};

const approval: KeyframeBlueprintApproval = {
  version: 'keyframe-blueprint-approval-v0.3.1',
  approvedAt: 220,
  blueprintSavedAt: 200,
  sourceStoryboardSavedAt: 100,
  blueprintCount: 2,
};

describe('Step 3.2 keyframe asset model', () => {
  it('requires current Step 3.1 PASS and creates one asset slot per shot', () => {
    expect(isKeyframeBlueprintApprovalCurrent(draft, approval)).toBe(true);
    expect(isKeyframeBlueprintApprovalCurrent(draft, { ...approval, blueprintSavedAt: 199 })).toBe(false);

    const manifest = buildKeyframeAssetManifest({ draft, approval, now: 300 });
    expect(manifest.assets).toHaveLength(2);
    expect(manifest.assets[0]).toMatchObject({ shotUid: 'shot-a', shotLabel: 'S01', status: 'EMPTY' });
    expect(manifest.assets[1]).toMatchObject({ shotUid: 'shot-b', shotLabel: 'S02', status: 'EMPTY' });
    expect(manifestMatchesCurrentBlueprint(manifest, draft, approval)).toBe(true);
    expect(manifestMatchesCurrentBlueprint(manifest, draft, { ...approval, approvedAt: 221 })).toBe(false);
  });

  it('only forms Step 3.2 PASS after every image is attached and manually approved', () => {
    let manifest = buildKeyframeAssetManifest({ draft, approval, now: 300 });
    manifest = attachKeyframeAsset(manifest, 'shot-a', {
      source: 'upload',
      blobKey: 'blob-a',
      fileName: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      now: 310,
    });
    expect(manifest.assets[0].status).toBe('READY');
    manifest = approveKeyframeAsset(manifest, 'shot-a', 320);
    expect(manifest.assets[0].status).toBe('PASS');
    expect(isKeyframeAssetManifestComplete(manifest)).toBe(false);

    manifest = attachKeyframeAsset(manifest, 'shot-b', {
      source: 'gemini',
      blobKey: 'blob-b',
      fileName: 'b.png',
      mimeType: 'image/png',
      sizeBytes: 120,
      provider: 'vertex-gemini-image',
      model: 'gemini-3.1-flash-image',
      now: 330,
    });
    manifest = approveKeyframeAsset(manifest, 'shot-b', 340);
    expect(isKeyframeAssetManifestComplete(manifest)).toBe(true);
    expect(buildKeyframeAssetApproval(manifest, 350)).toMatchObject({ assetCount: 2, approvedAt: 350 });
  });

  it('invalidates a shot PASS when QA changes or the image is replaced', () => {
    let manifest = buildKeyframeAssetManifest({ draft, approval, now: 300 });
    manifest = attachKeyframeAsset(manifest, 'shot-a', {
      source: 'upload', blobKey: 'blob-a', fileName: 'a.png', mimeType: 'image/png', sizeBytes: 100, now: 310,
    });
    manifest = approveKeyframeAsset(manifest, 'shot-a', 320);
    manifest = updateKeyframeAssetQa(manifest, 'shot-a', '需要再看手部', 330);
    expect(manifest.assets[0].status).toBe('READY');
    expect(manifest.assets[0].approvedAt).toBeNull();

    manifest = approveKeyframeAsset(manifest, 'shot-a', 340);
    manifest = attachKeyframeAsset(manifest, 'shot-a', {
      source: 'gemini', blobKey: 'blob-a2', fileName: 'a2.png', mimeType: 'image/png', sizeBytes: 110, now: 350,
    });
    expect(manifest.assets[0].status).toBe('READY');
    expect(manifest.assets[0].approvedAt).toBeNull();
  });
});
