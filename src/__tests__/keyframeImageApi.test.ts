import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../episode-server';
import type { KeyframeImageGeneratorLike } from '../server/services/geminiKeyframeImageService';

const originalPreview = process.env.PUBLIC_PREVIEW_READ_ONLY;
const originalProduction = process.env.DIRECTOR_PRODUCTION_RUN_ENABLED;
const originalStoryboardEnabled = process.env.DIRECTOR_STORYBOARD_GEMINI_ENABLED;
const originalImageEnabled = process.env.DIRECTOR_KEYFRAME_IMAGE_ENABLED;
const originalImageModel = process.env.DIRECTOR_KEYFRAME_IMAGE_MODEL;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('Step 3.2 keyframe image API', () => {
  beforeEach(() => {
    process.env.PUBLIC_PREVIEW_READ_ONLY = '1';
    process.env.DIRECTOR_PRODUCTION_RUN_ENABLED = '0';
    process.env.DIRECTOR_STORYBOARD_GEMINI_ENABLED = '1';
    process.env.DIRECTOR_KEYFRAME_IMAGE_ENABLED = '1';
    process.env.DIRECTOR_KEYFRAME_IMAGE_MODEL = 'gemini-3.1-flash-image';
  });

  afterEach(() => {
    restore('PUBLIC_PREVIEW_READ_ONLY', originalPreview);
    restore('DIRECTOR_PRODUCTION_RUN_ENABLED', originalProduction);
    restore('DIRECTOR_STORYBOARD_GEMINI_ENABLED', originalStoryboardEnabled);
    restore('DIRECTOR_KEYFRAME_IMAGE_ENABLED', originalImageEnabled);
    restore('DIRECTOR_KEYFRAME_IMAGE_MODEL', originalImageModel);
    vi.restoreAllMocks();
  });

  it('allows only an explicit keyframe image generation intent in public preview', async () => {
    const generate = vi.fn().mockResolvedValue({
      provider: 'vertex-gemini-image',
      model: 'gemini-3.1-flash-image',
      generatedAt: 123,
      mimeType: 'image/png',
      imageBase64: 'aW1hZ2U=',
    });
    const keyframeImageGenerator: KeyframeImageGeneratorLike = { generate };
    const app = await createApp({ keyframeImageGenerator });

    const response = await request(app)
      .post('/api/director/keyframes/generate')
      .set('X-Director-Generation-Intent', 'keyframe-image-v0.3.2')
      .send({
        prompt: '9:16 教室中景，女生回头。',
        negativePrompt: '换脸、肢体异常',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      provider: 'vertex-gemini-image',
      model: 'gemini-3.1-flash-image',
      mimeType: 'image/png',
    });
    expect(generate).toHaveBeenCalledTimes(1);

    const blocked = await request(app).post('/api/episodes/EP001/run').send({});
    expect(blocked.status).toBe(423);
    expect(blocked.body.error).toBe('PREVIEW_READ_ONLY');
  });

  it('rejects generation when explicit intent header is missing', async () => {
    const generate = vi.fn();
    const app = await createApp({ keyframeImageGenerator: { generate } });

    const response = await request(app)
      .post('/api/director/keyframes/generate')
      .send({ prompt: '9:16 关键帧' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('KEYFRAME_IMAGE_GENERATION_INTENT_REQUIRED');
    expect(generate).not.toHaveBeenCalled();
  });

  it('exposes image capability without invoking a paid provider call', async () => {
    const generate = vi.fn();
    const app = await createApp({ keyframeImageGenerator: { generate } });
    const response = await request(app).get('/api/director/capabilities');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      readOnlyPreview: true,
      productionRunEnabled: false,
      keyframeImageEnabled: true,
      keyframeImageModel: 'gemini-3.1-flash-image',
    });
    expect(generate).not.toHaveBeenCalled();
  });
});
