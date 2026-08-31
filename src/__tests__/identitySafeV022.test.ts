import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { preprocessVeoImage } from '../server/services/imagePreprocessor';
import { normalizeIdentityIntentDecision } from '../mvp/identityIntent';
import { evaluateSceneQa } from '../mvp/sceneSafe';

describe('Identity Safe v0.2.2 protected routing', () => {
  it('auto-upscales 800x450 to 1280x720 and keeps landscape routing', async () => {
    const input = await sharp({ create: { width: 800, height: 450, channels: 3, background: '#777' } }).jpeg().toBuffer();
    const result = await preprocessVeoImage(input);
    expect(result.autoEnhanced).toBe(true);
    expect(result.originalWidth).toBe(800);
    expect(result.originalHeight).toBe(450);
    expect(result.processedWidth).toBe(1280);
    expect(result.processedHeight).toBe(720);
    expect(result.orientation).toBe('16:9');
  });

  it('auto-upscales portrait input and routes to 9:16', async () => {
    const input = await sharp({ create: { width: 450, height: 800, channels: 3, background: '#777' } }).jpeg().toBuffer();
    const result = await preprocessVeoImage(input);
    expect(result.autoEnhanced).toBe(true);
    expect(result.processedWidth).toBe(720);
    expect(result.processedHeight).toBe(1280);
    expect(result.orientation).toBe('9:16');
  });

  it('does not re-encode a sufficiently large input', async () => {
    const input = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#777' } }).png().toBuffer();
    const result = await preprocessVeoImage(input);
    expect(result.autoEnhanced).toBe(false);
    expect(result.buffer.equals(input)).toBe(true);
    expect(result.orientation).toBe('16:9');
  });

  it('allows SCENE only for high-confidence non-dominant identity decisions', () => {
    const result = normalizeIdentityIntentDecision({
      mode: 'SCENE', confidence: 0.97, identityLockRequired: false,
      dominantIdentityVisible: false, estimatedPersonCount: 9,
      reason: 'wide classroom ensemble',
    });
    expect(result.mode).toBe('SCENE');
    expect(result.failClosed).toBe(false);
  });

  it('fails closed to IDENTITY when scene classification is uncertain', () => {
    const result = normalizeIdentityIntentDecision({
      mode: 'SCENE', confidence: 0.72, identityLockRequired: false,
      dominantIdentityVisible: false, estimatedPersonCount: 8,
      reason: 'uncertain ensemble',
    });
    expect(result.mode).toBe('IDENTITY');
    expect(result.identityLockRequired).toBe(true);
    expect(result.failClosed).toBe(true);
  });

  it('fails closed to IDENTITY when a dominant identity is visible', () => {
    const result = normalizeIdentityIntentDecision({
      mode: 'SCENE', confidence: 0.99, identityLockRequired: false,
      dominantIdentityVisible: true, estimatedPersonCount: 2,
      reason: 'two people but one dominant face',
    });
    expect(result.mode).toBe('IDENTITY');
  });

  it('passes scene QA only when scene continuity gates pass', () => {
    const report = evaluateSceneQa({
      sceneSimilarityScore: 91,
      compositionConsistencyScore: 86,
      subjectContinuityScore: 88,
      temporalConsistencyScore: 94,
      severeSceneBreakDetected: false,
      summary: 'same classroom and ensemble',
    }, 'gemini-2.5-flash');
    expect(report.pass).toBe(true);
    expect(report.gateStatus).toBe('pass');
  });

  it('fails scene QA on catastrophic scene replacement regardless of scores', () => {
    const report = evaluateSceneQa({
      sceneSimilarityScore: 95,
      compositionConsistencyScore: 95,
      subjectContinuityScore: 95,
      temporalConsistencyScore: 95,
      severeSceneBreakDetected: true,
      summary: 'location changed',
    }, 'gemini-2.5-flash');
    expect(report.pass).toBe(false);
    expect(report.gateStatus).toBe('fail');
  });
});
