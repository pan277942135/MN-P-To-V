import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../episode-server';
import type { StoryboardGeneratorLike } from '../server/services/geminiStoryboardService';

const originalPreview = process.env.PUBLIC_PREVIEW_READ_ONLY;
const originalProduction = process.env.DIRECTOR_PRODUCTION_RUN_ENABLED;
const originalGeminiEnabled = process.env.DIRECTOR_STORYBOARD_GEMINI_ENABLED;
const originalStoryboardModel = process.env.DIRECTOR_STORYBOARD_MODEL;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('Gemini Storyboard Director API', () => {
  beforeEach(() => {
    process.env.PUBLIC_PREVIEW_READ_ONLY = '1';
    process.env.DIRECTOR_PRODUCTION_RUN_ENABLED = '0';
    process.env.DIRECTOR_STORYBOARD_GEMINI_ENABLED = '1';
    process.env.DIRECTOR_STORYBOARD_MODEL = 'gemini-2.5-flash';
  });

  afterEach(() => {
    restore('PUBLIC_PREVIEW_READ_ONLY', originalPreview);
    restore('DIRECTOR_PRODUCTION_RUN_ENABLED', originalProduction);
    restore('DIRECTOR_STORYBOARD_GEMINI_ENABLED', originalGeminiEnabled);
    restore('DIRECTOR_STORYBOARD_MODEL', originalStoryboardModel);
    vi.restoreAllMocks();
  });

  it('allows only the explicitly enabled Gemini Storyboard provider route in read-only preview', async () => {
    const generate = vi.fn().mockResolvedValue({
      provider: 'vertex-gemini',
      model: 'gemini-2.5-flash',
      generatedAt: 123,
      shots: [
        {
          uid: 'gemini-1',
          title: '拒信特写',
          durationSeconds: 4,
          scene: '出租屋',
          action: '手机显示拒信。',
          camera: '特写',
          dialogue: '',
          notes: '真实梅凝。',
        },
      ],
    });

    const storyboardGenerator: StoryboardGeneratorLike = { generate };
    const app = await createApp({ storyboardGenerator });

    const response = await request(app)
      .post('/api/director/storyboard/generate')
      .set('X-Director-Generation-Intent', 'storyboard-v0.2.2')
      .send({
        title: '押金扣光的第七天',
        creativeBrief: '梅凝失业后手搓法杖。',
        targetDurationSeconds: 30,
        targetFormat: 'story_short',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      provider: 'vertex-gemini',
      model: 'gemini-2.5-flash',
    });
    expect(response.body.shots).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);

    const blocked = await request(app)
      .post('/api/episodes/MN-EP001/run')
      .send({});
    expect(blocked.status).toBe(423);
    expect(blocked.body.error).toBe('PREVIEW_READ_ONLY');
  });

  it('exposes Gemini Storyboard capability without making a paid call', async () => {
    const storyboardGenerator: StoryboardGeneratorLike = {
      generate: vi.fn(),
    };
    const app = await createApp({ storyboardGenerator });

    const response = await request(app).get('/api/director/capabilities');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      readOnlyPreview: true,
      productionRunEnabled: false,
      storyboardGeminiEnabled: true,
      storyboardModel: 'gemini-2.5-flash',
    });
    expect(storyboardGenerator.generate).not.toHaveBeenCalled();
  });

  it('requires explicit generation intent before invoking Gemini', async () => {
    const generate = vi.fn();
    const app = await createApp({
      storyboardGenerator: { generate },
    });

    const response = await request(app)
      .post('/api/director/storyboard/generate')
      .send({
        title: '测试',
        creativeBrief: '测试故事。',
        targetDurationSeconds: 12,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('STORYBOARD_GENERATION_INTENT_REQUIRED');
    expect(generate).not.toHaveBeenCalled();
  });
});
