import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server';
import type { ShotSpec } from '../domain/episode/episodeTypes';
import { SHOT_SCHEMA_VERSION } from '../domain/episode/episodeTypes';
import {
  ShotProductionService,
  type ShotProductionRunInput,
  type ShotProductionShotRepository,
  type ShotRunnerFactory,
} from '../server/services/shotProductionService';

function shotFixture(shotId = 'S02', durationSeconds: 4 | 6 | 8 = 6, overrides: Partial<ShotSpec> = {}): ShotSpec {
  const now = 1_800_000_000_000;
  return {
    episodeId: 'MN-EP001',
    shotId,
    order: Number(shotId.slice(1)) - 1,
    durationSeconds,
    status: 'KEYFRAME_PENDING',
    scene: { location: 'rental room', time: 'night', description: 'EP001 production scene' },
    action: `${shotId} action`,
    camera: 'fixed camera with subtle movement',
    emotion: 'focused',
    props: ['staff'],
    keyframe: {
      provider: 'CHATGPT_UPLOAD',
      status: 'PASS',
      assetId: `kf-${shotId}`,
      sourceFileId: `file_${shotId.toLowerCase()}`,
      version: 1,
      generationAttempt: 1,
      qaAttempt: 1,
    },
    video: {
      provider: 'VEO',
      status: 'NOT_REQUESTED',
      providerAttempt: 0,
      qaAttempt: 0,
    },
    schemaVersion: SHOT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class FakeShotRepository implements ShotProductionShotRepository {
  public shot: ShotSpec;
  public readonly calls: string[] = [];

  constructor(shot: ShotSpec) {
    this.shot = shot;
  }

  isAvailable(): boolean { return true; }

  async getShot(): Promise<ShotSpec | null> {
    this.calls.push('getShot');
    return this.shot;
  }

  async prepareVideoExecution(params: { idempotencyKey: string }): Promise<ShotSpec> {
    this.calls.push('prepareVideoExecution');
    this.shot = {
      ...this.shot,
      status: 'VIDEO_PENDING',
      video: { ...this.shot.video, status: 'PENDING', idempotencyKey: params.idempotencyKey },
    };
    return this.shot;
  }

  async markVideoGenerating(params: { idempotencyKey: string; generationTaskId: string; providerAttempt?: number }): Promise<ShotSpec> {
    this.calls.push('markVideoGenerating');
    this.shot = {
      ...this.shot,
      status: 'VIDEO_GENERATING',
      video: {
        ...this.shot.video,
        status: 'GENERATING',
        idempotencyKey: params.idempotencyKey,
        generationTaskId: params.generationTaskId,
        providerAttempt: params.providerAttempt || 1,
      },
    };
    return this.shot;
  }

  async completeVideo(params: {
    idempotencyKey: string;
    taskId: string;
    videoUrl: string;
    downloadUrl: string;
    expiresAt?: string | null;
    providerAttempt?: number;
    artifactPersisted: boolean;
    artifactVerified: boolean;
  }): Promise<ShotSpec> {
    this.calls.push('completeVideo');
    this.shot = {
      ...this.shot,
      status: 'COMPLETED',
      completedAt: Date.now(),
      video: {
        ...this.shot.video,
        status: 'PASS',
        idempotencyKey: params.idempotencyKey,
        generationTaskId: params.taskId,
        assetId: params.taskId,
        artifactUrl: params.videoUrl,
        downloadUrl: params.downloadUrl,
        artifactExpiresAt: params.expiresAt || undefined,
        artifactPersisted: params.artifactPersisted,
        artifactVerified: params.artifactVerified,
        providerAttempt: params.providerAttempt || 1,
        qaAttempt: this.shot.video.qaAttempt + 1,
      },
    };
    return this.shot;
  }

  async failVideo(params: { errorCode: string; errorMessage: string }): Promise<ShotSpec> {
    this.calls.push(`failVideo:${params.errorCode}`);
    this.shot = {
      ...this.shot,
      status: 'FAILED',
      video: {
        ...this.shot.video,
        status: this.shot.video.generationTaskId ? 'FAIL' : 'NOT_REQUESTED',
        failureCode: params.errorCode,
        failureMessage: params.errorMessage,
      },
    };
    return this.shot;
  }
}

function successfulRunnerFactory(captured: ShotProductionRunInput[] | any[]): ShotRunnerFactory {
  return (dependencies) => ({
    run: async (input) => {
      captured.push(input);
      await dependencies.onTaskCreated?.({ taskId: `veo_${input.shotId.toLowerCase()}_001`, providerAttempt: 1 });
      return {
        episodeId: input.episodeId,
        shotId: input.shotId,
        taskId: `veo_${input.shotId.toLowerCase()}_001`,
        status: 'COMPLETED',
        videoUrl: `https://example.test/${input.shotId}.mp4`,
        downloadUrl: `https://example.test/${input.shotId}-download.mp4`,
        expiresAt: null,
        providerAttempt: 1,
        identityReport: { pass: true },
        artifactPersisted: true,
        artifactVerified: true,
      };
    },
  });
}

describe('ShotProductionService P0-6A', () => {
  it('runs S02 with the duration stored in ShotSpec', async () => {
    const repository = new FakeShotRepository(shotFixture('S02', 6));
    const captured: any[] = [];
    const service = new ShotProductionService(repository, successfulRunnerFactory(captured));

    const result = await service.run({
      episodeId: 'MN-EP001',
      shotId: 'S02',
      openaiFileRef: { id: 'file_s02' },
      idempotencyKey: 'mn-ep001-s02-intent-0001',
    });

    expect(result).toMatchObject({ shotId: 'S02', shotStatus: 'COMPLETED', replayed: false });
    expect(captured[0]).toMatchObject({ shotId: 'S02', durationSeconds: 6 });
    expect(repository.calls).toEqual(['getShot', 'prepareVideoExecution', 'markVideoGenerating', 'completeVideo']);
  });

  it('runs S06 with an 8-second ShotSpec without S01-only restrictions', async () => {
    const repository = new FakeShotRepository(shotFixture('S06', 8));
    const captured: any[] = [];
    const service = new ShotProductionService(repository, successfulRunnerFactory(captured));

    await service.run({
      episodeId: 'MN-EP001',
      shotId: 'S06',
      openaiFileRef: { id: 'file_s06' },
      idempotencyKey: 'mn-ep001-s06-intent-0001',
    });

    expect(captured[0].durationSeconds).toBe(8);
  });

  it('blocks every shot when its keyframe is not PASS', async () => {
    const repository = new FakeShotRepository(shotFixture('S03', 4, {
      keyframe: { ...shotFixture('S03', 4).keyframe, status: 'REVIEW' },
    }));
    const factory = vi.fn(successfulRunnerFactory([]));
    const service = new ShotProductionService(repository, factory);

    await expect(service.run({
      episodeId: 'MN-EP001',
      shotId: 'S03',
      openaiFileRef: { id: 'file_s03' },
      idempotencyKey: 'mn-ep001-s03-intent-0001',
    })).rejects.toMatchObject({ code: 'KEYFRAME_GATE_BLOCKED', statusCode: 409 });
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects a different idempotency intent on an active non-S01 shot', async () => {
    const repository = new FakeShotRepository(shotFixture('S04', 4, {
      status: 'VIDEO_GENERATING',
      video: {
        provider: 'VEO',
        status: 'GENERATING',
        generationTaskId: 'veo_s04_001',
        idempotencyKey: 'mn-ep001-s04-intent-0001',
        providerAttempt: 1,
        qaAttempt: 0,
      },
    }));
    const factory = vi.fn(successfulRunnerFactory([]));
    const service = new ShotProductionService(repository, factory);

    await expect(service.run({
      episodeId: 'MN-EP001',
      shotId: 'S04',
      openaiFileRef: { id: 'file_s04' },
      idempotencyKey: 'mn-ep001-s04-intent-0002',
    })).rejects.toMatchObject({ code: 'SHOT_IDEMPOTENCY_CONFLICT', statusCode: 409 });
  });

  it('replays a completed S05 with its original idempotency key', async () => {
    const repository = new FakeShotRepository(shotFixture('S05', 4, {
      status: 'COMPLETED',
      completedAt: 1_800_000_010_000,
      video: {
        provider: 'VEO',
        status: 'PASS',
        generationTaskId: 'veo_s05_001',
        assetId: 'veo_s05_001',
        idempotencyKey: 'mn-ep001-s05-intent-0001',
        artifactUrl: 'https://example.test/S05.mp4',
        downloadUrl: 'https://example.test/S05-download.mp4',
        artifactPersisted: true,
        artifactVerified: true,
        providerAttempt: 1,
        qaAttempt: 1,
      },
    }));
    const factory = vi.fn(successfulRunnerFactory([]));
    const service = new ShotProductionService(repository, factory);

    const result = await service.run({
      episodeId: 'MN-EP001',
      shotId: 'S05',
      openaiFileRef: { id: 'file_s05' },
      idempotencyKey: 'mn-ep001-s05-intent-0001',
    });

    expect(result.replayed).toBe(true);
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects shot ids outside S01-S06', async () => {
    const repository = new FakeShotRepository(shotFixture('S06', 4));
    const service = new ShotProductionService(repository, successfulRunnerFactory([]));
    await expect(service.run({
      episodeId: 'MN-EP001',
      shotId: 'S07',
      openaiFileRef: { id: 'file_s07' },
      idempotencyKey: 'mn-ep001-s07-intent-0001',
    })).rejects.toMatchObject({ code: 'SHOT_NOT_SUPPORTED', statusCode: 404 });
  });
});

describe('generic shot production API', () => {
  it('forwards S04 through the existing generic :shotId route', async () => {
    const service = {
      run: vi.fn(async (input: ShotProductionRunInput) => ({
        episodeId: input.episodeId,
        shotId: input.shotId,
        taskId: 'veo_s04_api_001',
        status: 'COMPLETED' as const,
        videoUrl: 'https://example.test/S04.mp4',
        downloadUrl: 'https://example.test/S04-download.mp4',
        expiresAt: null,
        providerAttempt: 1,
        artifactPersisted: true,
        artifactVerified: true,
        shotStatus: 'COMPLETED' as const,
        replayed: false,
      })),
    };
    const app = await createApp({ s01ProductionService: service });
    const response = await request(app)
      .post('/api/episodes/MN-EP001/shots/S04/run')
      .set('x-idempotency-key', 'mn-ep001-s04-intent-0003')
      .send({ openaiFileRef: { id: 'file_s04' } });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, shotId: 'S04', taskId: 'veo_s04_api_001' });
  });
});
