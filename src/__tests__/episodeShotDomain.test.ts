import { describe, expect, it } from 'vitest';
import {
  EPISODE_SCHEMA_VERSION,
  SHOT_SCHEMA_VERSION,
  buildShotDocumentId,
  type EpisodeSpec,
  type ShotSpec,
} from '../domain/episode/episodeTypes';
import { parseEpisodeSpec, parseShotSpec } from '../domain/episode/episodeSchema';

function episodeFixture(overrides: Partial<EpisodeSpec> = {}): EpisodeSpec {
  const now = 1_800_000_000_000;
  return {
    id: 'MN-COS-001',
    title: '押金扣光的第七天，我在出租屋手搓法杖',
    characterId: 'meining',
    characterVersion: 'v3',
    characterSnapshot: {
      characterId: 'meining',
      characterVersion: 'v3',
      characterUpdatedAt: now - 1000,
      identitySpecHash: 'a'.repeat(64),
      referenceImageIds: ['ref_0', 'ref_1'],
    },
    durationTargetSeconds: 24,
    aspectRatio: '9:16',
    status: 'PLANNED',
    budget: {
      limitUsd: 8,
      spentUsd: 0,
      reservedUsd: 0,
      currency: 'USD',
    },
    shotIds: ['S01', 'S02', 'S03', 'S04', 'S05', 'S06'],
    schemaVersion: EPISODE_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function shotFixture(overrides: Partial<ShotSpec> = {}): ShotSpec {
  const now = 1_800_000_000_000;
  return {
    episodeId: 'MN-COS-001',
    shotId: 'S01',
    order: 0,
    durationSeconds: 4,
    status: 'KEYFRAME_PENDING',
    scene: {
      location: 'rental_room',
      time: 'night',
      description: '出租屋工作桌，EVA 泡棉和未完成法杖散落在桌面。',
    },
    action: '梅凝坐在桌前切割 EVA 泡棉。',
    camera: 'static_slow_push',
    emotion: 'tired_focused',
    props: ['EVA foam', 'unfinished staff'],
    voiceover: '押金被扣光后的第七天……',
    keyframe: {
      provider: 'CHATGPT_UPLOAD',
      status: 'NOT_REQUESTED',
      version: 1,
      generationAttempt: 0,
      qaAttempt: 0,
    },
    video: {
      provider: 'VEO',
      status: 'NOT_REQUESTED',
      providerAttempt: 0,
      qaAttempt: 0,
    },
    budget: {
      limitUsd: 2,
      spentUsd: 0,
      reservedUsd: 0,
      currency: 'USD',
    },
    schemaVersion: SHOT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('V0 Episode domain', () => {
  it('accepts a valid EpisodeSpec and preserves the character snapshot contract', () => {
    const episode = parseEpisodeSpec(episodeFixture());
    expect(episode.id).toBe('MN-COS-001');
    expect(episode.characterSnapshot.characterVersion).toBe('v3');
    expect(episode.shotIds).toHaveLength(6);
  });

  it('rejects duplicate shot ids and a current shot outside the episode', () => {
    expect(() => parseEpisodeSpec(episodeFixture({ shotIds: ['S01', 'S01'] }))).toThrow();
    expect(() => parseEpisodeSpec(episodeFixture({ currentShotId: 'S99' }))).toThrow();
  });

  it('rejects budget reservations that exceed the episode limit', () => {
    expect(() => parseEpisodeSpec(episodeFixture({
      budget: { limitUsd: 8, spentUsd: 7, reservedUsd: 2, currency: 'USD' },
    }))).toThrow();
  });
});

describe('V0 Shot domain', () => {
  it('accepts only Veo-supported V0 durations', () => {
    expect(parseShotSpec(shotFixture()).durationSeconds).toBe(4);
    expect(() => parseShotSpec({ ...shotFixture(), durationSeconds: 5 })).toThrow();
  });

  it('requires a generationTaskId after video execution starts', () => {
    expect(() => parseShotSpec(shotFixture({
      status: 'VIDEO_GENERATING',
      video: {
        provider: 'VEO',
        status: 'GENERATING',
        providerAttempt: 1,
        qaAttempt: 0,
      },
    }))).toThrow();
  });

  it('requires PASS keyframe and video assets before a shot can complete', () => {
    expect(() => parseShotSpec(shotFixture({ status: 'COMPLETED', completedAt: 1_800_000_010_000 }))).toThrow();

    const completed = parseShotSpec(shotFixture({
      status: 'COMPLETED',
      completedAt: 1_800_000_010_000,
      keyframe: {
        provider: 'CHATGPT_UPLOAD',
        status: 'PASS',
        assetId: 'kf_EP001_S01_v1',
        version: 1,
        generationAttempt: 1,
        qaAttempt: 1,
      },
      video: {
        provider: 'VEO',
        status: 'PASS',
        generationTaskId: 'mvp_task_001',
        assetId: 'video_EP001_S01_v1',
        providerAttempt: 1,
        qaAttempt: 1,
      },
    }));

    expect(completed.status).toBe('COMPLETED');
    expect(completed.video.generationTaskId).toBe('mvp_task_001');
  });

  it('builds stable Firestore shot document ids', () => {
    expect(buildShotDocumentId('MN-COS-001', 'S01')).toBe('MN-COS-001__S01');
    expect(() => buildShotDocumentId('MN/COS', 'S01')).toThrow();
  });
});
