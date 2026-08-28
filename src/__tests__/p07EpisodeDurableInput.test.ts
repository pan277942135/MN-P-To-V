import { describe, expect, it } from 'vitest';
import type { EpisodeSpec, ShotSpec } from '../domain/episode/episodeTypes';
import { EPISODE_SCHEMA_VERSION, SHOT_SCHEMA_VERSION } from '../domain/episode/episodeTypes';
import {
  EpisodeProductionRunner,
  type EpisodeProductionEpisodeRepository,
  type EpisodeProductionShotRepository,
} from '../server/services/episodeProductionRunner';
import type { ShotProductionRunInput, ShotProductionServiceLike } from '../server/services/shotProductionService';

const IDS = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06'] as const;

function episodeFixture(): EpisodeSpec {
  return {
    id: 'MN-EP001',
    title: 'EP001',
    characterId: 'meining',
    characterVersion: 'v1',
    characterSnapshot: { characterId: 'meining', characterVersion: 'v1', referenceImageIds: ['ref_0'] },
    durationTargetSeconds: 24,
    aspectRatio: '9:16',
    status: 'PLANNED',
    shotIds: [...IDS],
    schemaVersion: EPISODE_SCHEMA_VERSION,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };
}

function shotsFixture(): ShotSpec[] {
  return IDS.map((shotId, order) => ({
    episodeId: 'MN-EP001',
    shotId,
    order,
    durationSeconds: 4,
    status: 'VIDEO_PENDING',
    scene: { location: `scene-${shotId}` },
    action: `${shotId} action`,
    camera: 'fixed',
    props: [],
    keyframe: {
      provider: 'CHATGPT_UPLOAD',
      status: 'PASS',
      assetId: `kf_${shotId}`,
      outputBucket: 'ai-studio-bucket-89614354864-asia-south1',
      outputObjectPath: `episodes/MN-EP001/shots/${shotId}/keyframes/v1_deadbeefdeadbeef.png`,
      contentSha256: 'a'.repeat(64),
      mimeType: 'image/png',
      version: 1,
      generationAttempt: 1,
      qaAttempt: 1,
    },
    video: { provider: 'VEO', status: 'PENDING', providerAttempt: 0, qaAttempt: 0 },
    schemaVersion: SHOT_SCHEMA_VERSION,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  }));
}

class EpisodeRepo implements EpisodeProductionEpisodeRepository {
  public episode = episodeFixture();
  isAvailable() { return true; }
  async getEpisode() { return this.episode; }
  async upsertEpisode(record: EpisodeSpec) { this.episode = record; return record; }
}

class ShotRepo implements EpisodeProductionShotRepository {
  constructor(public shots = shotsFixture()) {}
  isAvailable() { return true; }
  async listShotsByEpisode() { return [...this.shots].sort((a, b) => a.order - b.order); }
}

class ShotService implements ShotProductionServiceLike {
  public calls: ShotProductionRunInput[] = [];
  constructor(private readonly repo: ShotRepo) {}
  async run(input: ShotProductionRunInput) {
    this.calls.push(input);
    const index = this.repo.shots.findIndex((shot) => shot.shotId === input.shotId);
    const shot = this.repo.shots[index];
    this.repo.shots[index] = {
      ...shot,
      status: 'COMPLETED',
      video: {
        ...shot.video,
        status: 'PASS',
        idempotencyKey: input.idempotencyKey,
        generationTaskId: `task_${shot.shotId}`,
        artifactUrl: `https://example.test/${shot.shotId}.mp4`,
        downloadUrl: `https://example.test/${shot.shotId}-download.mp4`,
        artifactPersisted: true,
        artifactVerified: true,
        providerAttempt: 1,
        qaAttempt: 1,
      },
    };
    return {
      episodeId: input.episodeId,
      shotId: input.shotId,
      taskId: `task_${input.shotId}`,
      status: 'COMPLETED' as const,
      videoUrl: `https://example.test/${input.shotId}.mp4`,
      downloadUrl: `https://example.test/${input.shotId}-download.mp4`,
      expiresAt: null,
      providerAttempt: 1,
      artifactPersisted: true,
      artifactVerified: true,
      shotStatus: 'COMPLETED' as const,
      replayed: false,
    };
  }
}

describe('EpisodeProductionRunner P0-7 durable input', () => {
  it('runs S01-S06 without runtime openaiFileRef when every PASS keyframe has a durable asset', async () => {
    const episodeRepo = new EpisodeRepo();
    const shotRepo = new ShotRepo();
    const shotService = new ShotService(shotRepo);
    const runner = new EpisodeProductionRunner(episodeRepo, shotRepo, shotService);

    const result = await runner.run({ episodeId: 'MN-EP001', shots: {} });

    expect(shotService.calls.map((call) => call.shotId)).toEqual([...IDS]);
    expect(shotService.calls.every((call) => call.openaiFileRef === undefined)).toBe(true);
    expect(result).toMatchObject({ episodeStatus: 'COMPOSING', paused: false });
  });

  it('fails closed before Shot execution when a durable location is only partially bound', async () => {
    const episodeRepo = new EpisodeRepo();
    const shotRepo = new ShotRepo();
    shotRepo.shots[0] = {
      ...shotRepo.shots[0],
      keyframe: { ...shotRepo.shots[0].keyframe, contentSha256: undefined },
    };
    const shotService = new ShotService(shotRepo);
    const runner = new EpisodeProductionRunner(episodeRepo, shotRepo, shotService);

    const result = await runner.run({ episodeId: 'MN-EP001', shots: {} });

    expect(shotService.calls).toHaveLength(0);
    expect(result).toMatchObject({
      episodeStatus: 'REVIEW',
      paused: true,
      reasonCode: 'KEYFRAME_DURABLE_ASSET_INVALID',
    });
  });
});
