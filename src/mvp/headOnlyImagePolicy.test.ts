import { describe, expect, it } from 'vitest';
import { evaluateHeadOnlyQaGate, type HeadOnlyQaReport } from './headOnlyImagePolicy';

function passingReport(): HeadOnlyQaReport {
  return {
    identityScore: 98,
    targetIdentitySimilarity: 98,
    sourceIdentityResidualScore: 1,
    hairOnlyChangeDetected: false,
    faceGeometryReplacementScore: 98,
    headOnlyPreservationScore: 99,
    bodyPreservationScore: 99,
    outfitPreservationScore: 99,
    backgroundPreservationScore: 98,
    posePreservationScore: 99,
    headBodyProportionScore: 96,
    anatomyScore: 96,
    fullBodyVisible: true,
    estimatedHeadBodyRatio: 9,
    alteredOutsideHead: false,
    issues: [],
    summary: 'pass',
  };
}

describe('evaluateHeadOnlyQaGate', () => {
  it('passes a strict compliant candidate', () => {
    expect(evaluateHeadOnlyQaGate(passingReport())).toEqual({ pass: true, failedChecks: [] });
  });

  it('hard-fails any alteration outside the head even with high scores', () => {
    const report = { ...passingReport(), alteredOutsideHead: true };
    const gate = evaluateHeadOnlyQaGate(report);
    expect(gate.pass).toBe(false);
    expect(gate.failedChecks).toContain('alteredOutsideHead=true');
  });

  it('fails identity below 95', () => {
    const report = { ...passingReport(), identityScore: 94 };
    expect(evaluateHeadOnlyQaGate(report).failedChecks).toContain('TARGET_IDENTITY_TOO_WEAK');
  });

  it('fails a non-harmonious head/body proportion', () => {
    const report = { ...passingReport(), headBodyProportionScore: 91 };
    expect(evaluateHeadOnlyQaGate(report).failedChecks).toContain('headBodyProportionScore<92');
  });

  it('fails a critical QA issue regardless of scores', () => {
    const report: HeadOnlyQaReport = {
      ...passingReport(),
      issues: [{ code: 'BODY_CHANGED', severity: 'critical', description: 'Shoulder changed', repairInstruction: 'Restore original shoulder pixels.' }],
    };
    expect(evaluateHeadOnlyQaGate(report).failedChecks).toContain('criticalIssue');
  });
});
