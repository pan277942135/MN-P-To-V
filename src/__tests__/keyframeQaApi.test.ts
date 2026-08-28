import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../episode-server';
import type { KeyframeQaGeneratorLike } from '../server/services/geminiKeyframeQaService';

const originalPreview = process.env.PUBLIC_PREVIEW_READ_ONLY;
const originalProduction = process.env.DIRECTOR_PRODUCTION_RUN_ENABLED;
const originalStoryboardEnabled = process.env.DIRECTOR_STORYBOARD_GEMINI_ENABLED;
const originalImageEnabled = process.env.DIRECTOR_KEYFRAME_IMAGE_ENABLED;
const originalQaEnabled = process.env.DIRECTOR_KEYFRAME_QA_ENABLED;
const originalQaModel = process.env.DIRECTOR_KEYFRAME_QA_MODEL;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('Step 3.3 keyframe QA API', () => {
  beforeEach(() => {
    process.env.PUBLIC_PREVIEW_READ_ONLY = '1';
    process.env.DIRECTOR_PRODUCTION_RUN_ENABLED = '0';
    process.env.DIRECTOR_STORYBOARD_GEMINI_ENABLED = '1';
    process.env.DIRECTOR_KEYFRAME_IMAGE_ENABLED = '1';
    process.env.DIRECTOR_KEYFRAME_QA_ENABLED = '1';
    process.env.DIRECTOR_KEYFRAME_QA_MODEL = 'gemini-2.5-flash';
  });

  afterEach(() => {
    restore('PUBLIC_PREVIEW_READ_ONLY', originalPreview);
    restore('DIRECTOR_PRODUCTION_RUN_ENABLED', originalProduction);
    restore('DIRECTOR_STORYBOARD_GEMINI_ENABLED', originalStoryboardEnabled);
    restore('DIRECTOR_KEYFRAME_IMAGE_ENABLED', originalImageEnabled);
    restore('DIRECTOR_KEYFRAME_QA_ENABLED', originalQaEnabled);
    restore('DIRECTOR_KEYFRAME_QA_MODEL', originalQaModel);
    vi.restoreAllMocks();
  });

  it('allows an explicit keyframe QA call while Episode/Veo remains locked', async () => {
    const analyze = vi.fn().mockResolvedValue({
      provider: 'vertex-gemini-qa',
      model: 'gemini-2.5-flash',
      analyzedAt: 123,
      pass: true,
      identityAssessed: true,
      continuityAssessed: false,
      scores: {
        identityScore: 98,
        promptComplianceScore: 95,
        anatomyScore: 96,
        visualQualityScore: 94,
        compositionScore: 92,
        continuityScore: null,
      },
      issues: [],
      warnings: [],
      summary: '通过',
      repairInstruction: '',
    });
    const keyframeQaGenerator: KeyframeQaGeneratorLike = { analyze };
    const app = await createApp({ keyframeQaGenerator });

    const response = await request(app)
      .post('/api/director/keyframes/qa')
      .set('X-Director-Generation-Intent', 'keyframe-qa-v0.3.3')
      .send({
        shotLabel: 'S01',
        prompt: '9:16 出租屋中景，梅凝制作法杖。',
        continuity: '真实世界梅凝，旧卫衣。',
        candidateImageBase64: 'aW1hZ2U=',
        candidateMimeType: 'image/png',
        masterReferences: [{ imageBase64: 'bWFzdGVy', mimeType: 'image/jpeg' }],
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      provider: 'vertex-gemini-qa',
      model: 'gemini-2.5-flash',
      pass: true,
    });
    expect(analyze).toHaveBeenCalledTimes(1);

    const blocked = await request(app).post('/api/episodes/EP001/run').send({});
    expect(blocked.status).toBe(423);
    expect(blocked.body.error).toBe('PREVIEW_READ_ONLY');
  });

  it('requires explicit QA intent before invoking the provider', async () => {
    const analyze = vi.fn();
    const app = await createApp({ keyframeQaGenerator: { analyze } });

    const response = await request(app)
      .post('/api/director/keyframes/qa')
      .send({
        prompt: 'test',
        candidateImageBase64: 'aW1hZ2U=',
        candidateMimeType: 'image/png',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('KEYFRAME_QA_INTENT_REQUIRED');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('exposes QA capability without invoking a paid provider call', async () => {
    const analyze = vi.fn();
    const app = await createApp({ keyframeQaGenerator: { analyze } });
    const response = await request(app).get('/api/director/capabilities');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      readOnlyPreview: true,
      productionRunEnabled: false,
      keyframeQaEnabled: true,
      keyframeQaModel: 'gemini-2.5-flash',
    });
    expect(analyze).not.toHaveBeenCalled();
  });
});
