
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server';
import {
  S01ProductionService,
  type S01ProductionRunInput,
  type S01ProductionShotRepository,
  type S01RunnerFactory,
} from '../server/services/s01ProductionService';
import type { ShotSpec } from '../domain/episode/episodeTypes';
import { SHOT_SCHEMA_VERSION } from '../domain/episode/episodeTypes';

function shotFixture(overrides: Partial<ShotSpec> = {}): ShotSpec {
  const now = 1_800_000_000_000;
  return {
    episodeId: 'MN-EP001',
    shotId: 'S01',
    order: 0,
    durationSeconds: 4,
    status: 'KEYFRAME_PENDING',
    scene: { location: 'old rental room', time: 'night' },
    action: '梅凝整理桌面材料。',
    camera: 'static slow push-in',
    emotion: 'tired but focused',
    props: ['EVA foam', 'unfinished staff'],
    keyframe: {
      provider: 'CHATGPT_UPLOAD',
      status: 'PASS',
      assetId: 'kf-ep001-s01-v1',
      sourceFileId: 'file_s01',
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

class FakeShotRepository implements S01ProductionShotRepository {
  public shot: ShotSpec;
  public readonly calls: string[] = [];

  constructor(shot = shotFixture()) {
    this.shot = shot;
  }

  isAvailable(): boolean {
    return true;
  }

  async getShot(_episodeId: string, _shotId: string): Promise<ShotSpec | null> {
    this.calls.push('getShot');
    return this.shot;
  }

  async prepareVideoExecution(params: { episodeId: string; shotId: string; idempotencyKey: string }): Promise<ShotSpec> {
    this.calls.push('prepareVideoExecution');
    this.shot = {
      ...this.shot,
      status: 'VIDEO_PENDING',
      video: { ...this.shot.video, status: 'PENDING', idempotencyKey: params.idempotencyKey },
    };
    return this.shot;
  }

  async markVideoGenerating(params: {
    episodeId: string;
    shotId: string;
    idempotencyKey: string;
    generationTaskId: string;
    providerAttempt?: number;
  }): Promise<ShotSpec> {
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
    episodeId: string;
    shotId: string;
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

  async failVideo(params: {
    episodeId: string;
    shotId: string;
    idempotencyKey: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<ShotSpec> {
    this.calls.push('failVideo:' + params.errorCode);
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

function successfulRunnerFactory(calls: string[]): S01RunnerFactory {
  return (dependencies) => ({
    run: async () => {
      calls.push('runner.run');
      await dependencies.onTaskCreated?.({ taskId: 'veo_s01_001', providerAttempt: 1 });
      return {
        episodeId: 'MN-EP001',
        shotId: 'S01',
        taskId: 'veo_s01_001',
        status: 'COMPLETED',
        videoUrl: 'https://example.test/s01.mp4',
        downloadUrl: 'https://example.test/s01-download.mp4',
        expiresAt: '2026-08-28T00:00:00Z',
        providerAttempt: 1,
        identityReport: { pass: true },
        artifactPersisted: true,
        artifactVerified: true,
      };
    },
  });
}

describe('S01ProductionService', () => {
  it('binds the runner task and completes the Firestore-shaped shot state', async () => {
    const repository = new FakeShotRepository();
    const calls: string[] = [];
    const service = new S01ProductionService(repository, successfulRunnerFactory(calls));

    const result = await service.run({
      episodeId: 'MN-EP001',
      shotId: 'S01',
      openaiFileRef: { id: 'file_s01' },
      idempotencyKey: 'mn-ep001-s01-intent-0001',
    });

    expect(result).toMatchObject({
      taskId: 'veo_s01_001',
      shotStatus: 'COMPLETED',
      replayed: false,
      artifactPersisted: true,
      artifactVerified: true,
    });
    expect(repository.calls).toEqual([
      'getShot',
      'prepareVideoExecution',
      'runner.run',
      'markVideoGenerating',
      'completeVideo',
    ]);
  });

  it('blocks Veo when the keyframe gate is not PASS', async () => {
    const repository = new FakeShotRepository(shotFixture({
      keyframe: { ...shotFixture().keyframe, status: 'REVIEW' },
    }));
    const factory = vi.fn(successfulRunnerFactory([]));
    const service = new S01ProductionService(repository, factory);

    await expect(service.run({
      episodeId: 'MN-EP001',
      shotId: 'S01',
      openaiFileRef: { id: 'file_s01' },
      idempotencyKey: 'mn-ep001-s01-intent-0002',
    })).rejects.toMatchObject({ code: 'KEYFRAME_GATE_BLOCKED', statusCode: 409 });
    expect(factory).not.toHaveBeenCalled();
    expect(repository.calls).toEqual(['getShot']);
  });

  it('replays a completed shot with the same idempotency key without calling the runner', async () => {
    const repository = new FakeShotRepository(shotFixture({
      status: 'COMPLETED',
      completedAt: 1_800_000_010_000,
      video: {
        provider: 'VEO',
        status: 'PASS',
        generationTaskId: 'veo_s01_001',
        assetId: 'veo_s01_001',
        idempotencyKey: 'mn-ep001-s01-intent-0001',
        artifactUrl: 'https://example.test/s01.mp4',
        downloadUrl: 'https://example.test/s01-download.mp4',
        artifactPersisted: true,
        artifactVerified: true,
        providerAttempt: 1,
        qaAttempt: 1,
      },
    }));
    const factory = vi.fn(successfulRunnerFactory([]));
    const service = new S01ProductionService(repository, factory);

    const result = await service.run({
      episodeId: 'MN-EP001',
      shotId: 'S01',
      openaiFileRef: { id: 'file_s01' },
      idempotencyKey: 'mn-ep001-s01-intent-0001',
    });

    expect(result.replayed).toBe(true);
    expect(result.taskId).toBe('veo_s01_001');
    expect(factory).not.toHaveBeenCalled();
    expect(repository.calls).toEqual(['getShot']);
  });

  it('rejects a different intent while a shot is active', async () => {
    const repository = new FakeShotRepository(shotFixture({
      status: 'VIDEO_GENERATING',
      video: {
        provider: 'VEO',
        status: 'GENERATING',
        generationTaskId: 'veo_s01_001',
        idempotencyKey: 'mn-ep001-s01-intent-0001',
        providerAttempt: 1,
        qaAttempt: 0,
      },
    }));
    const factory = vi.fn(successfulRunnerFactory([]));
    const service = new S01ProductionService(repository, factory);

    await expect(service.run({
      episodeId: 'MN-EP001',
      shotId: 'S01',
      openaiFileRef: { id: 'file_s01' },
      idempotencyKey: 'mn-ep001-s01-intent-0002',
    })).rejects.toMatchObject({ code: 'S01_IDEMPOTENCY_CONFLICT', statusCode: 409 });
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('S01 production API', () => {
  it('exposes a callable production route and forwards the stable request contract', async () => {
    const service = {
      run: vi.fn(async (input: S01ProductionRunInput) => ({
        episodeId: input.episodeId,
        shotId: input.shotId,
        taskId: 'veo_s01_api_001',
        status: 'COMPLETED' as const,
        videoUrl: 'https://example.test/s01.mp4',
        downloadUrl: 'https://example.test/s01-download.mp4',
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
      .post('/api/episodes/MN-EP001/shots/S01/run')
      .set('x-idempotency-key', 'mn-ep001-s01-intent-0003')
      .send({ openaiFileRef: { id: 'file_s01' } });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      episodeId: 'MN-EP001',
      shotId: 'S01',
      taskId: 'veo_s01_api_001',
    });
    expect(service.run).toHaveBeenCalledWith({
      episodeId: 'MN-EP001',
      shotId: 'S01',
      openaiFileRef: { id: 'file_s01' },
      idempotencyKey: 'mn-ep001-s01-intent-0003',
      prompt: undefined,
    });
  });

  it('rejects missing keyframe references before invoking the service', async () => {
    const service = { run: vi.fn() };
    const app = await createApp({ s01ProductionService: service });

    const response = await request(app)
      .post('/api/episodes/MN-EP001/shots/S01/run')
      .set('x-idempotency-key', 'mn-ep001-s01-intent-0004')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('OPENAI_FILE_REF_REQUIRED');
    expect(service.run).not.toHaveBeenCalled();
  });
});
