import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../episode-server';

function progress(completed = 0) {
  return {
    totalShots: 6,
    completed,
    running: 0,
    failed: 0,
    currentShotId: completed < 6 ? `S0${completed + 1}` : null,
    percent: Math.round((completed / 6) * 100),
  };
}

function episodeRecord() {
  return {
    id: 'MN-EP001',
    title: 'EP001 Director Console Test',
    synopsis: 'Six-shot durable episode',
    characterId: 'mei-ning',
    characterVersion: 'v1',
    characterSnapshot: {
      characterId: 'mei-ning',
      characterVersion: 'v1',
      referenceImageIds: ['ref-1'],
    },
    durationTargetSeconds: 24,
    aspectRatio: '9:16' as const,
    status: 'PLANNED' as const,
    shotIds: ['S01', 'S02', 'S03', 'S04', 'S05', 'S06'],
    schemaVersion: 'episode-v0.1' as const,
    createdAt: 1,
    updatedAt: 2,
  };
}

function shotRecord(index: number, durable = true) {
  const shotId = `S0${index}`;
  return {
    episodeId: 'MN-EP001',
    shotId,
    order: index,
    title: `Shot ${index}`,
    durationSeconds: 4 as const,
    status: 'VIDEO_PENDING' as const,
    scene: { location: 'room', time: 'night' },
    action: `action ${index}`,
    camera: 'locked',
    props: [],
    keyframe: {
      provider: 'MANUAL_IMPORT' as const,
      status: 'PASS' as const,
      assetId: durable ? `kf_${shotId}` : undefined,
      outputBucket: durable ? 'test-bucket' : undefined,
      outputObjectPath: durable ? `episodes/MN-EP001/${shotId}/keyframes/v1/test.jpg` : undefined,
      contentSha256: durable ? 'a'.repeat(64) : undefined,
      mimeType: durable ? 'image/jpeg' as const : undefined,
      version: 1,
      generationAttempt: 1,
      qaAttempt: 1,
    },
    video: {
      provider: 'VEO' as const,
      status: 'PENDING' as const,
      providerAttempt: 1,
      qaAttempt: 0,
    },
    schemaVersion: 'shot-v0.1' as const,
    createdAt: 1,
    updatedAt: 2,
  };
}

const originalPreview = process.env.PUBLIC_PREVIEW_READ_ONLY;
const originalProduction = process.env.DIRECTOR_PRODUCTION_RUN_ENABLED;

afterEach(() => {
  if (originalPreview === undefined) delete process.env.PUBLIC_PREVIEW_READ_ONLY;
  else process.env.PUBLIC_PREVIEW_READ_ONLY = originalPreview;
  if (originalProduction === undefined) delete process.env.DIRECTOR_PRODUCTION_RUN_ENABLED;
  else process.env.DIRECTOR_PRODUCTION_RUN_ENABLED = originalProduction;
});

describe('POST /api/episodes/:episodeId/run', () => {
  it('forwards shot runtime inputs to the sequential EpisodeProductionRunner', async () => {
    const runner = {
      run: vi.fn(async () => ({
        episodeId: 'MN-EP001',
        episodeStatus: 'COMPOSING' as const,
        progress: progress(6),
        paused: false,
        reasonCode: 'ALL_SHOTS_COMPLETED',
      })),
    };
    const app = await createApp({ episodeProductionRunner: runner });
    const response = await request(app)
      .post('/api/episodes/MN-EP001/run')
      .send({
        shots: {
          S01: { openaiFileRef: { id: 'file_s01', download_link: 'https://files.openai.com/S01' } },
          S02: { openaiFileRef: { id: 'file_s02', download_link: 'https://files.openai.com/S02' } },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      episodeId: 'MN-EP001',
      episodeStatus: 'COMPOSING',
      paused: false,
    });
    expect(runner.run).toHaveBeenCalledWith({
      episodeId: 'MN-EP001',
      shots: {
        S01: { openaiFileRef: { id: 'file_s01', download_link: 'https://files.openai.com/S01' } },
        S02: { openaiFileRef: { id: 'file_s02', download_link: 'https://files.openai.com/S02' } },
      },
    });
  });

  it('returns runner pauses as successful orchestration state instead of fabricating completion', async () => {
    const runner = {
      run: vi.fn(async () => ({
        episodeId: 'MN-EP001',
        episodeStatus: 'REVIEW' as const,
        progress: progress(2),
        paused: true,
        reasonCode: 'KEYFRAME_REVIEW_REQUIRED',
        message: 'S03 requires review',
      })),
    };
    const app = await createApp({ episodeProductionRunner: runner });
    const response = await request(app).post('/api/episodes/MN-EP001/run').send({ shots: {} });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      episodeStatus: 'REVIEW',
      paused: true,
      reasonCode: 'KEYFRAME_REVIEW_REQUIRED',
    });
  });

  it('surfaces structured runner errors without starting a second path', async () => {
    const runner = {
      run: vi.fn(async () => {
        const error = new Error('Episode not found') as Error & { code: string; statusCode: number };
        error.code = 'EPISODE_NOT_FOUND';
        error.statusCode = 404;
        throw error;
      }),
    };
    const app = await createApp({ episodeProductionRunner: runner });
    const response = await request(app).post('/api/episodes/MISSING/run').send({ shots: {} });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      ok: false,
      error: 'EPISODE_NOT_FOUND',
      episodeId: 'MISSING',
    });
  });

  it('fails closed in public preview so no provider execution can be started', async () => {
    process.env.PUBLIC_PREVIEW_READ_ONLY = '1';
    process.env.DIRECTOR_PRODUCTION_RUN_ENABLED = '0';
    const runner = { run: vi.fn() };
    const app = await createApp({ episodeProductionRunner: runner as any });

    const response = await request(app).post('/api/episodes/MN-EP001/run').send({ shots: {} });

    expect(response.status).toBe(423);
    expect(response.body).toMatchObject({ ok: false, error: 'PREVIEW_READ_ONLY' });
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe('Director Console Episode read APIs', () => {
  it('lists real Episode/Shot snapshots with durable production readiness', async () => {
    const episode = episodeRecord();
    const shots = [1, 2, 3, 4, 5, 6].map((index) => shotRecord(index));
    const episodeRepository = {
      isAvailable: () => true,
      listEpisodes: vi.fn(async () => [episode]),
      getEpisode: vi.fn(async () => episode),
    };
    const shotRepository = {
      isAvailable: () => true,
      listShotsByEpisode: vi.fn(async () => shots),
    };
    const runner = { run: vi.fn() };
    const app = await createApp({
      episodeProductionRunner: runner as any,
      episodeRepository,
      shotRepository,
    });

    const response = await request(app).get('/api/episodes?limit=20');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      episode: { id: 'MN-EP001', status: 'PLANNED' },
      summary: {
        totalShots: 6,
        keyframePass: 6,
        durableReady: 6,
        canRunWithoutLegacyFileRefs: true,
      },
    });
    expect(response.body.items[0].shots[0]).toMatchObject({
      shotId: 'S01',
      director: { state: 'READY', durableKeyframeReady: true },
    });
  });

  it('reports the exact legacy-file blocker when a PASS keyframe has no durable asset', async () => {
    const episode = episodeRecord();
    const shots = [shotRecord(1, false), ...[2, 3, 4, 5, 6].map((index) => shotRecord(index))];
    const app = await createApp({
      episodeProductionRunner: { run: vi.fn() } as any,
      episodeRepository: {
        isAvailable: () => true,
        listEpisodes: vi.fn(async () => [episode]),
        getEpisode: vi.fn(async () => episode),
      },
      shotRepository: {
        isAvailable: () => true,
        listShotsByEpisode: vi.fn(async () => shots),
      },
    });

    const response = await request(app).get('/api/episodes/MN-EP001');

    expect(response.status).toBe(200);
    expect(response.body.summary.canRunWithoutLegacyFileRefs).toBe(false);
    expect(response.body.shots[0]).toMatchObject({
      shotId: 'S01',
      director: {
        state: 'BLOCKED',
        durableKeyframeReady: false,
        reasonCode: 'OPENAI_FILE_REF_REQUIRED',
      },
    });
  });
});
