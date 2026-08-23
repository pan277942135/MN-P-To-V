import { describe, expect, it } from 'vitest';
import {
  HEAD_ONLY_IMAGE_VERSION,
  buildHeadOnlyEditPrompt,
  evaluateHeadOnlyQaGate,
  type HeadOnlyQaReport,
} from '../mvp/headOnlyImagePolicy';

function passingReport(overrides: Partial<HeadOnlyQaReport> = {}): HeadOnlyQaReport {
  return {
    identityScore: 98,
    targetIdentitySimilarity: 98,
    sourceIdentityResidualScore: 2,
    hairOnlyChangeDetected: false,
    faceGeometryReplacementScore: 98,
    headOnlyPreservationScore: 99,
    bodyPreservationScore: 99,
    outfitPreservationScore: 99,
    backgroundPreservationScore: 99,
    posePreservationScore: 99,
    headBodyProportionScore: 96,
    anatomyScore: 96,
    fullBodyVisible: true,
    estimatedHeadBodyRatio: 9,
    alteredOutsideHead: false,
    issues: [],
    summary: 'target identity dominates; immutable regions preserved',
    ...overrides,
  };
}

describe('HEAD-ONLY identity takeover policy', () => {
  it('publishes a new pipeline version', () => {
    expect(HEAD_ONLY_IMAGE_VERSION).toBe('head-only-v1.2-identity-takeover-gate');
  });

  it('passes only when target identity, geometry replacement and preservation all pass', () => {
    expect(evaluateHeadOnlyQaGate(passingReport())).toEqual({ pass: true, failedChecks: [] });
  });

  it.each([
    [{ targetIdentitySimilarity: 94 }, 'TARGET_IDENTITY_TOO_WEAK'],
    [{ sourceIdentityResidualScore: 6 }, 'SOURCE_FACE_RESIDUAL_TOO_HIGH'],
    [{ hairOnlyChangeDetected: true }, 'HAIR_ONLY_CHANGE_DETECTED'],
    [{ faceGeometryReplacementScore: 94 }, 'FACE_GEOMETRY_NOT_REPLACED'],
  ] as const)('hard-fails source-face retention: %j', (override, code) => {
    const gate = evaluateHeadOnlyQaGate(passingReport(override));
    expect(gate.pass).toBe(false);
    expect(gate.failedChecks).toContain(code);
  });

  it('explicitly makes masters authoritative for all identity geometry and keeps the body immutable', () => {
    const prompt = buildHeadOnlyEditPrompt({
      characterName: '梅凝',
      identityLockPromptEnglish: 'cool fair skin; gray-blue cat-shaped eyes; blue-black long hair; mature, elegant, non-template face',
      repairInstruction: 'HAIR_ONLY_CHANGE_DETECTED',
    });
    expect(prompt).toContain('absolute and sole authority');
    expect(prompt).toContain('face shape and proportions');
    expect(prompt).toContain('Changing only hairstyle, hair color');
    expect(prompt).toContain('If the output still looks primarily like the source person and only the hair has changed, the result is invalid.');
    expect(prompt).toContain('Everything below the base of the neck must remain visually unchanged');
    expect(prompt).toContain('Start again from the ORIGINAL SOURCE IMAGE');
  });
});
