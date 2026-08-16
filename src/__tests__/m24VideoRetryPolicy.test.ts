import { describe, expect, it } from 'vitest';
import { VideoRetryPolicyService } from '../services/qa/videoRetryPolicyService';
import type { VideoFailureDiagnosis } from '../services/qa/videoFailureDiagnosisService';
import type { VideoIdentityQaReport } from '../services/qa/videoIdentityQaService';

function qa(overrides: Partial<VideoIdentityQaReport> = {}): VideoIdentityQaReport {
  return {
    pass: false,
    gateStatus: 'fail',
    averageIdentityScore: 92,
    minimumIdentityScore: 82,
    temporalConsistencyScore: 90,
    motionNaturalnessScore: 90,
    anatomyScore: 90,
    sceneContinuityScore: 95,
    promptComplianceScore: 95,
    frameReports: [
      { frameIndex: 0, timestampSec: 0, identityScore: 98, qualityScore: 95, notes: '' },
      { frameIndex: 1, timestampSec: 2, identityScore: 82, qualityScore: 90, notes: '' },
    ],
    criticalIssues: [],
    repairInstruction: 'free-form fallback',
    summary: 'qa failed',
    identityDriftDetected: true,
    worstFrameTimestamp: 2,
    identityDriftSegments: [
      { startTimestampSec: 2, endTimestampSec: 2, minimumIdentityScore: 82, severity: 'review' },
    ],
    samplingManifest: {
      version: 'fixture',
      sampleCount: 2,
      timestampsSec: [0, 2],
      firstTimestampSec: 0,
      lastTimestampSec: 2,
      maximumGapSec: 2,
    },
    ...overrides,
  };
}

function diagnosis(overrides: Partial<VideoFailureDiagnosis> = {}): VideoFailureDiagnosis {
  return {
    version: 'm2-3-v1',
    primaryCode: 'IDENTITY_DRIFT',
    secondaryCodes: [],
    severity: 'major',
    retryRecommended: true,
    repairStrategy: 'LOCK_IDENTITY_REDUCE_MOTION',
    repairPromptAppend: 'Lock identity and reduce motion.',
    affectedRanges: [],
    worstFrameTimestamp: 2,
    evidence: [],
    summary: 'identity drift',
    ...overrides,
  };
}

describe('M2-4 VideoRetryPolicyService', () => {
  it('never regenerates a REVIEW automatically', () => {
    const decision = VideoRetryPolicyService.decide({
      taskId: 'task_review',
      qaReport: qa({ gateStatus: 'review' }),
      diagnosis: diagnosis(),
      providerAttempt: 1,
      qaAttempt: 1,
    });

    expect(decision.action).toBe('MANUAL_REVIEW');
    expect(decision.automatic).toBe(false);
    expect(decision.consumesProviderAttempt).toBe(false);
  });

  it('re-QAs incomplete evidence without consuming a provider attempt', () => {
    const decision = VideoRetryPolicyService.decide({
      taskId: 'task_reqa',
      qaReport: qa(),
      diagnosis: diagnosis({
        primaryCode: 'QA_EVIDENCE_INCOMPLETE',
        retryRecommended: false,
        repairStrategy: 'REEXTRACT_AND_REQA',
        repairPromptAppend: '',
      }),
      providerAttempt: 1,
      qaAttempt: 1,
    });

    expect(decision.action).toBe('REQA_SAME_ARTIFACT');
    expect(decision.consumesProviderAttempt).toBe(false);
    expect(decision.nextProviderAttempt).toBe(1);
    expect(decision.nextQaAttempt).toBe(2);
  });

  it('permits exactly one provider regeneration under the default two-attempt budget', () => {
    const firstDecision = VideoRetryPolicyService.decide({
      taskId: 'task_retry',
      qaReport: qa(),
      diagnosis: diagnosis(),
      providerAttempt: 1,
      qaAttempt: 1,
      artifactObjectPath: 'veo/task_retry/attempts/1/result.mp4',
    });

    expect(firstDecision.action).toBe('REGENERATE_VIDEO');
    expect(firstDecision.nextProviderAttempt).toBe(2);
    expect(firstDecision.providerAttemptsRemaining).toBe(1);
    expect(firstDecision.idempotencyKey).toMatch(/^retry_[a-f0-9]{32}$/);

    const exhausted = VideoRetryPolicyService.decide({
      taskId: 'task_retry',
      qaReport: qa(),
      diagnosis: diagnosis(),
      providerAttempt: 2,
      qaAttempt: 2,
      artifactObjectPath: 'veo/task_retry/attempts/2/result.mp4',
    });

    expect(exhausted.action).toBe('TERMINAL_FAIL');
    expect(exhausted.automatic).toBe(false);
  });

  it('creates a stable provider retry idempotency key for the same retry plan', () => {
    const params = {
      taskId: 'task_stable',
      nextProviderAttempt: 2,
      diagnosisCode: 'IDENTITY_DRIFT',
      artifactObjectPath: 'veo/task_stable/attempts/1/result.mp4',
    };
    expect(VideoRetryPolicyService.buildProviderRetryIdempotencyKey(params))
      .toBe(VideoRetryPolicyService.buildProviderRetryIdempotencyKey(params));
  });

  it('changes idempotency key when the provider attempt changes', () => {
    const base = {
      taskId: 'task_stable',
      diagnosisCode: 'IDENTITY_DRIFT',
      artifactObjectPath: 'veo/task_stable/attempts/1/result.mp4',
    };
    const first = VideoRetryPolicyService.buildProviderRetryIdempotencyKey({ ...base, nextProviderAttempt: 2 });
    const second = VideoRetryPolicyService.buildProviderRetryIdempotencyKey({ ...base, nextProviderAttempt: 3 });
    expect(first).not.toBe(second);
  });

  it('does not provider-retry an unknown/manual diagnosis', () => {
    const decision = VideoRetryPolicyService.decide({
      taskId: 'task_unknown',
      qaReport: qa(),
      diagnosis: diagnosis({
        primaryCode: 'UNKNOWN_VIDEO_QA_FAILURE',
        retryRecommended: false,
        repairStrategy: 'MANUAL_REVIEW',
        repairPromptAppend: '',
      }),
      providerAttempt: 1,
      qaAttempt: 1,
    });

    expect(decision.action).toBe('MANUAL_REVIEW');
    expect(decision.requiresHumanReview).toBe(true);
  });

  it('returns COMPLETE for certified PASS without consuming retry budget', () => {
    const decision = VideoRetryPolicyService.decide({
      taskId: 'task_pass',
      qaReport: qa({ pass: true, gateStatus: 'pass' }),
      diagnosis: null,
      providerAttempt: 1,
      qaAttempt: 1,
    });

    expect(decision.action).toBe('COMPLETE');
    expect(decision.consumesProviderAttempt).toBe(false);
  });
});
