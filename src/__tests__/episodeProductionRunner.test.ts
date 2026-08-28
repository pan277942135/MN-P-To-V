import { describe, expect, it } from 'vitest';
import type { EpisodeSpec, ShotSpec } from '../domain/episode/episodeTypes';
import { EPISODE_SCHEMA_VERSION, SHOT_SCHEMA_VERSION } from '../domain/episode/episodeTypes';
import {
  EpisodeProductionRunner,
  type EpisodeProductionEpisodeRepository,
  type EpisodeProductionShotRepository,
} from '../server/services/episodeProductionRunner';
import type { ShotProductionRunInput, ShotProductionServiceLike } from '../server/services/shotProductionService';

const SHOT_IDS = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06'] as const;

function episodeFixture(overrides: Partial<EpisodeSpec> = {}): EpisodeSpec {
  const now = 1_800_000_000_000;
  return {
    id: 'MN-EP001',
    title: 'EP001',
    characterId: 'meining',
    characterVersion: 'v1',
    characterSnapshot: {
      characterId: 'meining',
      characterVersion: 'v1',
      referenceImageIds: ['ref_0'],
    },
    durationTargetSeconds: 24,
    aspectRatio: '9:16',
    status: 'PLANNED',
    shotIds: [...SHOT_IDS],
    schemaVersion: EPISODE_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function shotFixture(shotId: typeof SHOT_IDS[number], order: number, overrides: Partial<ShotSpec> = {}): ShotSpec {
  const now = 1_800_000_000_000;
  return {
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
      sourceFileId: `file_${shotId.toLowerCase()}`,
      version: 1,
      generationAttempt: 1,
      qaAttempt: 1,
    },
    video: {
      provider: 'VEO',
      status: 'PENDING',
      providerAttempt: 0,
      qaAttempt: 0,
    },
    schemaVersion: SHOT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function sixShots(): ShotSpec[] {
  return SHOT_IDS.map((shotId, index) => shotFixture(shotId, index));
}

function runtimeInputs() {
  return Object.fromEntries(SHOT_IDS.map((shotId) => [
    shotId,
    { openaiFileRef: { id: `file_${shotId.toLowerCase()}`, download_link: `https://files.openai.com/${shotId}` } },
  ])) as any;
}

class FakeEpisodeRepository implements EpisodeProductionEpisodeRepository {
  public episode: EpisodeSpec;
  public readonly states: Array<{ status: string; currentShotId?: string }> = [];

  constructor(episode = episodeFixture()) { this.episode = episode; }
  isAvailable(): boolean { return true; }
  async getEpisode(): Promise<EpisodeSpec | null> { return this.episode; }
  async upsertEpisode(record: EpisodeSpec): Promise<EpisodeSpec> {
    this.episode = record;
    this.states.push({ status: record.status, currentShotId: record.currentShotId });
    return record;
  }
}

class FakeShotRepository implements EpisodeProductionShotRepository {
  constructor(public shots: ShotSpec[]) {}
  isAvailable(): boolean { return true; }
  async listShotsByEpisode(): Promise<ShotSpec[]> {
    return [...this.shots].sort((a, b) => a.order - b.order);
  }
}

class FakeShotService implements ShotProductionServiceLike {
  public readonly calls: ShotProductionRunInput[] = [];
  constructor(private readonly repo: FakeShotRepository) {}

  async run(input: ShotProductionRunInput) {
    this.calls.push(input);
    const index = this.repo.shots.findIndex((shot) => shot.shotId === input.shotId);
    const shot = this.repo.shots[index];
    this.repo.shots[index] = {
      ...shot,
      status: 'COMPLETED',
      completedAt: Date.now(),
      video: {
        ...shot.video,
        status: 'PASS',
        idempotencyKey: shot.video.idempotencyKey || input.idempotencyKey,
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

describe('EpisodeProductionRunner P0-6B', () => {
  it('runs S01-S06 strictly sequentially and finishes at COMPOSING', async () => {
    const episodeRepo = new FakeEpisodeRepository();
    const shotRepo = new FakeShotRepository(sixShots());
    const shotService = new FakeShotService(shotRepo);
    const runner = new EpisodeProductionRunner(episodeRepo, shotRepo, shotService);

    const result = await runner.run({ episodeId: 'MN-EP001', shots: runtimeInputs() });

    expect(shotService.calls.map((call) => call.shotId)).toEqual([...SHOT_IDS]);
    expect(result.episodeStatus).toBe('COMPOSING');
    expect(result.paused).toBe(false);
    expect(result.progress).toMatchObject({ totalShots: 6, completed: 6, failed: 0, percent: 100 });
    expect(episodeRepo.episode.currentShotId).toBeUndefined();
  });

  it('pauses at a REVIEW keyframe and never skips ahead', async () => {
    const shots = sixShots();
    shots[2] = {
      ...shots[2],
      status: 'KEYFRAME_REVIEW',
      keyframe: { ...shots[2].keyframe, status: 'REVIEW' },
      video: { ...shots[2].video, status: 'NOT_REQUESTED' },
    };
    const episodeRepo = new FakeEpisodeRepository();
    const shotRepo = new FakeShotRepository(shots);
    const shotService = new FakeShotService(shotRepo);
    const runner = new EpisodeProductionRunner(episodeRepo, shotRepo, shotService);

    const result = await runner.run({ episodeId: 'MN-EP001', shots: runtimeInputs() });

    expect(shotService.calls.map((call) => call.shotId)).toEqual(['S01', 'S02']);
    expect(result).toMatchObject({
      episodeStatus: 'REVIEW',
      paused: true,
      reasonCode: 'KEYFRAME_REVIEW_REQUIRED',
    });
    expect(result.progress.currentShotId).toBe('S03');
  });

  it('pauses FAILED episodes at the failed shot without running later shots', async () => {
    const shots = sixShots();
    shots[1] = {
      ...shots[1],
      status: 'FAILED',
      video: { ...shots[1].video, status: 'FAIL', failureCode: 'VIDEO_IDENTITY_QA_FAILED' },
    };
    const episodeRepo = new FakeEpisodeRepository();
    const shotRepo = new FakeShotRepository(shots);
    const shotService = new FakeShotService(shotRepo);
    const runner = new EpisodeProductionRunner(episodeRepo, shotRepo, shotService);

    const result = await runner.run({ episodeId: 'MN-EP001', shots: runtimeInputs() });

    expect(shotService.calls.map((call) => call.shotId)).toEqual(['S01']);
    expect(result).toMatchObject({
      episodeStatus: 'FAILED',
      paused: true,
      reasonCode: 'VIDEO_IDENTITY_QA_FAILED',
    });
    expect(result.progress.currentShotId).toBe('S02');
  });

  it('resumes from the first incomplete shot and never regenerates completed shots', async () => {
    const shots = sixShots();
    for (let i = 0; i < 2; i++) {
      shots[i] = {
        ...shots[i],
        status: 'COMPLETED',
        video: {
          ...shots[i].video,
          status: 'PASS',
          idempotencyKey: `existing-${shots[i].shotId}-intent-0001`,
          generationTaskId: `task_${shots[i].shotId}`,
          artifactUrl: `https://example.test/${shots[i].shotId}.mp4`,
          downloadUrl: `https://example.test/${shots[i].shotId}-download.mp4`,
          artifactPersisted: true,
          artifactVerified: true,
        },
      };
    }
    const episodeRepo = new FakeEpisodeRepository(episodeFixture({ status: 'PRODUCTION', currentShotId: 'S03' }));
    const shotRepo = new FakeShotRepository(shots);
    const shotService = new FakeShotService(shotRepo);
    const runner = new EpisodeProductionRunner(episodeRepo, shotRepo, shotService);

    const result = await runner.run({ episodeId: 'MN-EP001', shots: runtimeInputs() });

    expect(shotService.calls.map((call) => call.shotId)).toEqual(['S03', 'S04', 'S05', 'S06']);
    expect(result.episodeStatus).toBe('COMPOSING');
  });

  it('reuses an existing active Shot idempotency key during recovery', async () => {
    const shots = sixShots();
    shots[0] = {
      ...shots[0],
      status: 'VIDEO_GENERATING',
      video: {
        ...shots[0].video,
        status: 'GENERATING',
        idempotencyKey: 'existing-s01-provider-intent-0001',
        generationTaskId: 'task_s01_existing',
      },
    };
    const episodeRepo = new FakeEpisodeRepository(episodeFixture({ status: 'PRODUCTION', currentShotId: 'S01' }));
    const shotRepo = new FakeShotRepository(shots);
    const shotService = new FakeShotService(shotRepo);
    const runner = new EpisodeProductionRunner(episodeRepo, shotRepo, shotService);
    const inputs = runtimeInputs();
    inputs.S01.idempotencyKey = 'new-key-that-must-not-win-0001';

    await runner.run({ episodeId: 'MN-EP001', shots: inputs });

    expect(shotService.calls[0].idempotencyKey).toBe('existing-s01-provider-intent-0001');
  });

  it('pauses before provider execution when the current runtime file reference is missing', async () => {
    const episodeRepo = new FakeEpisodeRepository();
    const shotRepo = new FakeShotRepository(sixShots());
    const shotService = new FakeShotService(shotRepo);
    const runner = new EpisodeProductionRunner(episodeRepo, shotRepo, shotService);
    const inputs = runtimeInputs();
    delete inputs.S01.openaiFileRef;

    const result = await runner.run({ episodeId: 'MN-EP001', shots: inputs });

    expect(shotService.calls).toHaveLength(0);
    expect(result).toMatchObject({
      episodeStatus: 'REVIEW',
      paused: true,
      reasonCode: 'OPENAI_FILE_REF_REQUIRED',
    });
  });

  it('moves directly to COMPOSING when every shot is already complete', async () => {
    const shots = sixShots().map((shot) => ({
      ...shot,
      status: 'COMPLETED' as const,
      video: {
        ...shot.video,
        status: 'PASS' as const,
        generationTaskId: `task_${shot.shotId}`,
        idempotencyKey: `existing-${shot.shotId}-intent-0001`,
        artifactUrl: `https://example.test/${shot.shotId}.mp4`,
        downloadUrl: `https://example.test/${shot.shotId}-download.mp4`,
        artifactPersisted: true,
        artifactVerified: true,
      },
    }));
    const episodeRepo = new FakeEpisodeRepository(episodeFixture({ status: 'PRODUCTION' }));
    const shotRepo = new FakeShotRepository(shots);
    const shotService = new FakeShotService(shotRepo);
    const runner = new EpisodeProductionRunner(episodeRepo, shotRepo, shotService);

    const result = await runner.run({ episodeId: 'MN-EP001', shots: {} });

    expect(shotService.calls).toHaveLength(0);
    expect(result.episodeStatus).toBe('COMPOSING');
    expect(result.progress.percent).toBe(100);
  });
});
