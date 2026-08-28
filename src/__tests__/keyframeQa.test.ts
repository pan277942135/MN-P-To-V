import { describe, expect, it } from 'vitest';
import {
  approveKeyframeQa,
  attachKeyframeQaReport,
  buildKeyframeQaApproval,
  buildKeyframeQaManifest,
  isKeyframeQaApprovalCurrent,
  isKeyframeQaComplete,
  syncKeyframeQaManifest,
} from '../services/director/keyframeQa';

const blueprint: any = {
  version: 'keyframe-blueprint-v0.3.1',
  savedAt: 100,
  blueprints: [
    { uid: 'bp-a', shotUid: 'shot-a', shotLabel: 'S01' },
    { uid: 'bp-b', shotUid: 'shot-b', shotLabel: 'S02' },
  ],
};

const assets: any = {
  version: 'keyframe-asset-v0.3.2',
  assets: [
    { shotUid: 'shot-a', shotLabel: 'S01', blueprintUid: 'bp-a', blobKey: 'blob-a', characterId: 'char-1' },
    { shotUid: 'shot-b', shotLabel: 'S02', blueprintUid: 'bp-b', blobKey: 'blob-b', characterId: 'char-1' },
  ],
};

const passReport: any = {
  provider: 'vertex-gemini-qa',
  model: 'gemini-2.5-flash',
  analyzedAt: 200,
  pass: true,
  identityAssessed: true,
  continuityAssessed: true,
  scores: {
    identityScore: 98,
    promptComplianceScore: 95,
    anatomyScore: 96,
    visualQualityScore: 94,
    compositionScore: 93,
    continuityScore: 95,
  },
  issues: [],
  warnings: [],
  summary: '通过',
  repairInstruction: '',
};

describe('Step 3.3 keyframe QA state', () => {
  it('binds each QA result to the current image, previous image, and character reference', () => {
    const manifest = buildKeyframeQaManifest({ blueprint, assets, now: 150 });
    expect(manifest.items[0]).toMatchObject({
      shotUid: 'shot-a',
      assetBlobKey: 'blob-a',
      previousAssetBlobKey: '',
      characterId: 'char-1',
    });
    expect(manifest.items[1]).toMatchObject({
      shotUid: 'shot-b',
      assetBlobKey: 'blob-b',
      previousAssetBlobKey: 'blob-a',
      characterId: 'char-1',
    });
  });

  it('invalidates downstream continuity QA when the previous shot image changes', () => {
    let manifest = buildKeyframeQaManifest({ blueprint, assets, now: 150 });
    manifest = attachKeyframeQaReport(manifest, 'shot-b', passReport, 210);
    manifest = approveKeyframeQa(manifest, 'shot-b', 220);

    const changedAssets = {
      ...assets,
      assets: [
        { ...assets.assets[0], blobKey: 'blob-a-v2' },
        assets.assets[1],
      ],
    };
    const synced = syncKeyframeQaManifest({ current: manifest, blueprint, assets: changedAssets, now: 300 });

    expect(synced.invalidatedShotUids).toContain('shot-b');
    expect(synced.manifest.items[1].autoStatus).toBe('NOT_RUN');
    expect(synced.manifest.items[1].humanDecision).toBe('PENDING');
    expect(synced.manifest.items[1].previousAssetBlobKey).toBe('blob-a-v2');
  });

  it('requires AUTO PASS plus human approval for every shot before Step 3.3 PASS', () => {
    let manifest = buildKeyframeQaManifest({ blueprint, assets, now: 150 });
    manifest = attachKeyframeQaReport(manifest, 'shot-a', { ...passReport, continuityAssessed: false, scores: { ...passReport.scores, continuityScore: null } }, 201);
    manifest = attachKeyframeQaReport(manifest, 'shot-b', passReport, 202);
    expect(isKeyframeQaComplete(manifest)).toBe(false);

    manifest = approveKeyframeQa(manifest, 'shot-a', 210);
    expect(isKeyframeQaComplete(manifest)).toBe(false);
    manifest = approveKeyframeQa(manifest, 'shot-b', 211);
    expect(isKeyframeQaComplete(manifest)).toBe(true);

    const approval = buildKeyframeQaApproval(manifest, 220);
    expect(isKeyframeQaApprovalCurrent(manifest, approval)).toBe(true);
  });
});
