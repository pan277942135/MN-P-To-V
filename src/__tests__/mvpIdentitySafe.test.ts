import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  buildIdentitySafePrompt,
  decideFirstFrameEnhancement,
  normalizeIdentityQaParsedScores,
  shouldRetryIdentity,
  validateIdentitySafeInput,
  type MvpIdentityQaReport,
} from '../mvp/identitySafe';
import { IDENTITY_STABILITY_BENCHMARK_V1, summarizeIdentityBenchmark } from '../mvp/identityBenchmark';
import { isIdentitySafeCompletionSatisfied } from '../mvp/mvpContract';

function report(overrides: Partial<MvpIdentityQaReport> = {}): MvpIdentityQaReport {
  return {
    version: 'identity-safe-v0.2',
    qaModel: 'gemini-2.5-flash',
    gateStatus: 'pass',
    pass: true,
    identityDriftDetected: false,
    differentPersonDetected: false,
    meanFaceSimilarityScore: 94,
    minimumFaceSimilarityScore: 89,
    temporalConsistencyScore: 93,
    visibleFrameRatio: 1,
    worstFrameTimestamp: 2,
    frames: [],
    summary: 'pass',
    ...overrides,
  };
}

describe('MVP Identity Safe v0.2', () => {
  it('contains exactly 24 identity stability benchmark generation cases', () => {
    expect(IDENTITY_STABILITY_BENCHMARK_V1).toHaveLength(24);
    expect(new Set(IDENTITY_STABILITY_BENCHMARK_V1.map((item) => item.id)).size).toBe(24);
    expect(IDENTITY_STABILITY_BENCHMARK_V1.filter((item) => item.durationSeconds === 4)).toHaveLength(8);
    expect(IDENTITY_STABILITY_BENCHMARK_V1.filter((item) => item.durationSeconds === 6)).toHaveLength(8);
    expect(IDENTITY_STABILITY_BENCHMARK_V1.filter((item) => item.durationSeconds === 8)).toHaveLength(8);
  });

  it('rejects too-small images and reports high-risk identity prompt motion', async () => {
    const tiny = await sharp({ create: { width: 320, height: 480, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const checked = await validateIdentitySafeInput({
      imageBuffer: tiny,
      prompt: 'She quickly turns around and covers her face.',
    });
    expect(checked.pass).toBe(false);
    expect(checked.issues.map((item) => item.code)).toContain('IMAGE_TOO_SMALL');
    expect(checked.issues.map((item) => item.code)).toContain('PROMPT_IDENTITY_RISK');
  });

  it('accepts a normal portrait-sized image and low-motion prompt', async () => {
    const image = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const checked = await validateIdentitySafeInput({
      imageBuffer: image,
      prompt: 'Subtle breathing and one natural blink with locked camera.',
    });
    expect(checked.pass).toBe(true);
    expect(checked.issues).toEqual([]);
  });

  it('treats high-risk prompt motion as advisory when the identity frame itself is valid', async () => {
    const image = await sharp({ create: { width: 864, height: 1536, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const prompt = 'Camera orbits around her while she quickly turns around and briefly covers her face.';
    const checked = await validateIdentitySafeInput({ imageBuffer: image, prompt });

    expect(checked.pass).toBe(true);
    expect(checked.issues.map((item) => item.code)).toContain('PROMPT_IDENTITY_RISK');
    expect(checked.issues.find((item) => item.code === 'PROMPT_IDENTITY_RISK')?.message).toContain('不阻断提交');

    const effectivePrompt = buildIdentitySafePrompt(prompt, false);
    expect(effectivePrompt).toContain('No face occlusion, no large head turns');
    expect(effectivePrompt).toContain('Camera is locked or near-locked');
    expect(effectivePrompt).toContain('identity preservation takes priority');
  });

  it('normalizes the observed 5/5 perfect-identity fixture before 0-100 gating', () => {
    const parsed = {
      frameAssessments: Array.from({ length: 9 }, (_, frameIndex) => ({
        frameIndex,
        faceSimilarityScore: 5,
        faceVisible: true,
        differentPersonDetected: false,
        notes: frameIndex < 5
          ? 'Face matches the reference image perfectly and remains consistent.'
          : 'Face is consistent with the reference; only a blue tint appears in the hair.',
      })),
      temporalConsistencyScore: 5,
      summary: 'The identity of the person is perfectly maintained across all video frames and matches the reference image.',
    };

    const normalized = normalizeIdentityQaParsedScores(parsed);
    expect(normalized.sourceScoreScale).toBe('legacy-1-5-normalized');
    expect(normalized.parsed.frameAssessments).toHaveLength(9);
    expect(normalized.parsed.frameAssessments.every((frame: any) => frame.faceSimilarityScore === 100)).toBe(true);
    expect(normalized.parsed.temporalConsistencyScore).toBe(100);
  });

  it('fails closed on ambiguous or contradictory 1-5-like QA evidence instead of treating it as identity drift', () => {
    const contradictory = {
      frameAssessments: Array.from({ length: 9 }, (_, frameIndex) => ({
        frameIndex,
        faceSimilarityScore: 5,
        faceVisible: true,
        differentPersonDetected: frameIndex === 4,
        notes: 'Identity appears inconsistent with the reference.',
      })),
      temporalConsistencyScore: 5,
      summary: 'Possible identity drift and a different person in one frame.',
    };

    expect(() => normalizeIdentityQaParsedScores(contradictory)).toThrow('IDENTITY_QA_EVIDENCE_CONFLICT');
  });

  it('adds a fixed identity-safe block and a stronger conservative retry block', () => {
    const first = buildIdentitySafePrompt('Subtle breathing.', false);
    const retry = buildIdentitySafePrompt('Subtle breathing.', true);
    expect(first).toContain('[IDENTITY SAFE MODE — REQUIRED]');
    expect(first).toContain('Never replace');
    expect(retry).toContain('[CONSERVATIVE IDENTITY RETRY]');
    expect(retry).toContain('Previous generation showed identity drift');
    expect(retry.length).toBeGreaterThan(first.length);
  });

  it('permits exactly one automatic identity retry', () => {
    const failed = report({ gateStatus: 'fail', pass: false, identityDriftDetected: true });
    expect(shouldRetryIdentity(failed, 1)).toBe(true);
    expect(shouldRetryIdentity(failed, 2)).toBe(false);
    expect(shouldRetryIdentity(report(), 1)).toBe(false);
  });

  it('requires both artifact verification and passing identity QA for Identity Safe completion', () => {
    const artifact = {
      artifactPersisted: true,
      artifactVerified: true,
      outputBucket: 'bucket',
      outputObjectPath: 'veo/task/video.mp4',
      videoUri: 'gs://bucket/veo/task/video.mp4',
      sizeBytes: 10000,
      contentType: 'video/mp4',
      identitySafeMode: true,
    };
    expect(isIdentitySafeCompletionSatisfied({ ...artifact, identityReport: report() })).toBe(true);
    expect(isIdentitySafeCompletionSatisfied({
      ...artifact,
      identityReport: report({ gateStatus: 'fail', pass: false, identityDriftDetected: true }),
    })).toBe(false);
  });

  it('only recommends first-frame enhancement after a complete benchmark shows material residual drift', () => {
    expect(decideFirstFrameEnhancement({
      evaluatedCases: 19,
      firstAttemptPassRate: 0.5,
      postRetryPassRate: 0.5,
      earlyDriftRate: 0.5,
    }).recommended).toBe(false);

    expect(decideFirstFrameEnhancement({
      evaluatedCases: 24,
      firstAttemptPassRate: 0.7,
      postRetryPassRate: 0.85,
      earlyDriftRate: 0.1,
    })).toEqual({ recommended: true, reason: 'POST_RETRY_PASS_RATE_BELOW_90_PERCENT' });
  });

  it('summarizes a 24-case benchmark and makes the P0-07 decision from final results', () => {
    const firstFail = report({
      gateStatus: 'fail',
      pass: false,
      identityDriftDetected: true,
      worstFrameTimestamp: 0.5,
    });
    const results = IDENTITY_STABILITY_BENCHMARK_V1.map((item, index) => ({
      caseId: item.id,
      firstAttemptReport: index < 8 ? firstFail : report(),
      finalReport: index < 3 ? firstFail : report(),
      retried: index < 8,
    }));
    const summary = summarizeIdentityBenchmark(results);
    expect(summary.evaluatedCases).toBe(24);
    expect(summary.retriedCases).toBe(8);
    expect(summary.postRetryPassRate).toBeCloseTo(21 / 24, 3);
    expect(summary.firstFrameEnhancementDecision.recommended).toBe(true);
  });
});
