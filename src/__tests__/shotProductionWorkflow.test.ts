import { describe, expect, it } from 'vitest';
import type { GeneratedStoryboardShot } from '../services/director/localStoryboardGenerator';
import {
  SHOT_VIDEO_BLUEPRINT_VERSION,
  syncShotPipeline,
  type StoryboardDraftForWorkflow,
} from '../services/director/shotProductionWorkflow';
import { DEFAULT_FORMAT_POLICY } from '../services/formatPolicy/formatPolicy';

function shot(uid: string, durationSeconds = 4): GeneratedStoryboardShot {
  return {
    uid,
    title: uid.toUpperCase(),
    durationSeconds,
    scene: '同一间教室',
    action: `${uid} 的动作`,
    camera: '中景固定机位',
    dialogue: '',
    notes: '保持服装与空间连续',
  };
}

function storyboard(shots: GeneratedStoryboardShot[], savedAt = 100): StoryboardDraftForWorkflow {
  return {
    version: 'manual-storyboard-v0.2',
    shots,
    savedAt,
    generationEngine: 'manual',
  };
}

function passEveryAsset<T extends { assets: Array<any> }>(manifest: T, approvedAt = 200): T {
  return {
    ...manifest,
    assets: manifest.assets.map((asset: any, index: number) => ({
      ...asset,
      status: 'PASS',
      blobKey: `blob-${asset.shotUid}`,
      fileName: `${asset.shotUid}.png`,
      mimeType: 'image/png',
      sizeBytes: 1000 + index,
      approvedAt,
    })),
    savedAt: approvedAt,
  };
}

describe('shotProductionWorkflow', () => {
  it('unlocks video blueprint per manually passed keyframe without waiting for other shots', () => {
    const first = syncShotPipeline({ storyboard: storyboard([shot('a'), shot('b'), shot('c')]), now: 100 });
    const onlyA = {
      ...first.assets,
      assets: first.assets.assets.map((asset) => asset.shotUid === 'a'
        ? { ...asset, status: 'PASS' as const, blobKey: 'blob-a', approvedAt: 200 }
        : asset),
      savedAt: 200,
    };

    const synced = syncShotPipeline({
      storyboard: first.storyboard,
      existingBlueprint: first.blueprint,
      existingAssets: onlyA,
      existingVideos: first.videos,
      now: 210,
    });

    expect(synced.videos.version).toBe(SHOT_VIDEO_BLUEPRINT_VERSION);
    expect(synced.videos.items.map((item) => item.shotUid)).toEqual(['a']);
    expect(synced.videos.items[0].status).toBe('DRAFT');
    expect(synced.assets.assets.find((asset) => asset.shotUid === 'b')?.status).toBe('EMPTY');
  });

  it('inserting a shot preserves unrelated work and invalidates the shot whose predecessor changed', () => {
    const base = syncShotPipeline({ storyboard: storyboard([shot('a'), shot('b'), shot('c')]), now: 100 });
    const passedAssets = passEveryAsset(base.assets, 200);
    const produced = syncShotPipeline({
      storyboard: base.storyboard,
      existingBlueprint: base.blueprint,
      existingAssets: passedAssets,
      existingVideos: base.videos,
      now: 210,
    });

    const approvedVideos = {
      ...produced.videos,
      items: produced.videos.items.map((item) => ({ ...item, status: 'PASS' as const, approvedAt: 220 })),
      savedAt: 220,
    };

    const inserted = storyboard([shot('a'), shot('x'), shot('b'), shot('c')], 300);
    const synced = syncShotPipeline({
      storyboard: inserted,
      existingBlueprint: produced.blueprint,
      existingAssets: produced.assets,
      existingVideos: approvedVideos,
      now: 300,
    });

    expect(synced.blueprint.blueprints.map((item) => item.shotUid)).toEqual(['a', 'x', 'b', 'c']);
    expect(synced.assets.assets.find((asset) => asset.shotUid === 'a')?.status).toBe('PASS');
    expect(synced.assets.assets.find((asset) => asset.shotUid === 'x')?.status).toBe('EMPTY');
    expect(synced.assets.assets.find((asset) => asset.shotUid === 'b')?.status).toBe('READY');
    expect(synced.assets.assets.find((asset) => asset.shotUid === 'c')?.status).toBe('PASS');
    expect(synced.invalidatedKeyframeShotUids).toEqual(expect.arrayContaining(['x', 'b']));
    expect(synced.videos.items.find((item) => item.shotUid === 'a')?.status).toBe('PASS');
    expect(synced.videos.items.find((item) => item.shotUid === 'c')?.status).toBe('PASS');
    expect(synced.videos.items.some((item) => item.shotUid === 'b')).toBe(false);
  });

  it('duration-only edits preserve manual keyframe PASS but rebuild only that shot video blueprint', () => {
    const base = syncShotPipeline({ storyboard: storyboard([shot('a'), shot('b', 4)]), now: 100 });
    const passedAssets = passEveryAsset(base.assets, 200);
    const produced = syncShotPipeline({
      storyboard: base.storyboard,
      existingBlueprint: base.blueprint,
      existingAssets: passedAssets,
      existingVideos: base.videos,
      now: 210,
    });
    const approvedVideos = {
      ...produced.videos,
      items: produced.videos.items.map((item) => ({ ...item, status: 'PASS' as const, approvedAt: 220 })),
      savedAt: 220,
    };

    const changed = storyboard([shot('a'), shot('b', 7)], 300);
    const synced = syncShotPipeline({
      storyboard: changed,
      existingBlueprint: produced.blueprint,
      existingAssets: produced.assets,
      existingVideos: approvedVideos,
      now: 300,
    });

    expect(synced.assets.assets.find((asset) => asset.shotUid === 'b')?.status).toBe('PASS');
    expect(synced.videos.items.find((item) => item.shotUid === 'a')?.status).toBe('PASS');
    const b = synced.videos.items.find((item) => item.shotUid === 'b');
    expect(b?.status).toBe('DRAFT');
    expect(b?.storyboardDurationSeconds).toBe(7);
    expect(b?.productionDurationSeconds).toBe(8);
  });

  it('uses a valid Shot format override when building the keyframe blueprint', () => {
    const overridden = shot('portrait');
    overridden.formatPolicy = { aspectRatio: '9:16' };
    const result = syncShotPipeline({
      storyboard: storyboard([overridden]),
      formatPolicy: DEFAULT_FORMAT_POLICY,
      now: 100,
    });

    expect(result.blueprint.blueprints[0].imagePrompt).toContain('9:16 电影感关键帧');
  });
});
