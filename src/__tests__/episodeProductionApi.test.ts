import { describe, expect, it, vi } from 'vitest';
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
});
