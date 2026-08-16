import { describe, expect, it } from 'vitest';
import { VideoFailureDiagnosisService } from '../services/qa/videoFailureDiagnosisService';
import type { VideoIdentityQaReport } from '../services/qa/videoIdentityQaService';

function report(overrides: Partial<VideoIdentityQaReport> = {}): VideoIdentityQaReport {
  return {
    pass: false,
    gateStatus: 'fail',
    averageIdentityScore: 94,
    minimumIdentityScore: 85,
    temporalConsistencyScore: 92,
    motionNaturalnessScore: 92,
    anatomyScore: 92,
    sceneContinuityScore: 95,
    promptComplianceScore: 95,
    frameReports: [
      { frameIndex: 0, timestampSec: 0, identityScore: 98, qualityScore: 95, notes: '' },
      { frameIndex: 1, timestampSec: 2, identityScore: 85, qualityScore: 92, notes: '' },
    ],
    criticalIssues: [],
    repairInstruction: 'free-form model repair text',
    summary: 'QA did not pass',
    identityDriftDetected: true,
    worstFrameTimestamp: 2,
    identityDriftSegments: [
      { startTimestampSec: 2, endTimestampSec: 2, minimumIdentityScore: 85, severity: 'review' },
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

describe('M2-3 deterministic VideoFailureDiagnosisService', () => {
  it('classifies severe identity loss from numeric frame evidence', () => {
    const diagnosis = VideoFailureDiagnosisService.diagnose(report({
      minimumIdentityScore: 72,
      averageIdentityScore: 90,
      identityDriftSegments: [
        { startTimestampSec: 2, endTimestampSec: 3, minimumIdentityScore: 72, severity: 'fail' },
      ],
      worstFrameTimestamp: 2,
    }));

    expect(diagnosis?.primaryCode).toBe('IDENTITY_SWAP_OR_SEVERE_LOSS');
    expect(diagnosis?.severity).toBe('critical');
    expect(diagnosis?.retryRecommended).toBe(true);
    expect(diagnosis?.repairStrategy).toBe('LOCK_IDENTITY_REDUCE_MOTION');
    expect(diagnosis?.worstFrameTimestamp).toBe(2);
    expect(diagnosis?.evidence.some((item) => item.code === 'MIN_IDENTITY_SCORE')).toBe(true);
  });

  it('classifies eye/face instability from a critical issue when numeric identity is otherwise stable', () => {
    const diagnosis = VideoFailureDiagnosisService.diagnose(report({
      minimumIdentityScore: 94,
      averageIdentityScore: 96,
      identityDriftSegments: [],
      temporalConsistencyScore: 94,
      criticalIssues: ['frame_3@2.400s: eyes flicker and pupil direction becomes unstable'],
    }));

    expect(diagnosis?.primaryCode).toBe('EYE_OR_FACE_INSTABILITY');
    expect(diagnosis?.repairStrategy).toBe('STABILIZE_FACE_AND_EYES');
    expect(diagnosis?.repairPromptAppend).toContain('Stabilize facial geometry');
  });

  it('classifies anatomy deformation from hard-fail anatomy score', () => {
    const diagnosis = VideoFailureDiagnosisService.diagnose(report({
      minimumIdentityScore: 95,
      averageIdentityScore: 97,
      identityDriftSegments: [],
      anatomyScore: 69,
    }));

    expect(diagnosis?.primaryCode).toBe('ANATOMY_DEFORMATION');
    expect(diagnosis?.severity).toBe('critical');
    expect(diagnosis?.repairStrategy).toBe('REDUCE_ARTICULATION_COMPLEXITY');
  });

  it('maps a recoverable REVIEW identity drift to a deterministic repair instead of model free text', () => {
    const diagnosis = VideoFailureDiagnosisService.diagnose(report({
      gateStatus: 'review',
      minimumIdentityScore: 88,
      averageIdentityScore: 93,
      identityDriftSegments: [
        { startTimestampSec: 1.5, endTimestampSec: 3, minimumIdentityScore: 88, severity: 'review' },
      ],
    }));

    expect(diagnosis?.primaryCode).toBe('IDENTITY_DRIFT');
    expect(diagnosis?.retryRecommended).toBe(true);
    expect(diagnosis?.affectedRanges[0].startTimestampSec).toBe(1.5);
    expect(diagnosis?.repairPromptAppend).not.toBe('free-form model repair text');
  });

  it('fails diagnosis toward re-extraction when sampled-frame evidence is missing', () => {
    const diagnosis = VideoFailureDiagnosisService.diagnose(report({
      frameReports: [],
      identityDriftSegments: [],
      minimumIdentityScore: 95,
      averageIdentityScore: 96,
      temporalConsistencyScore: 95,
      anatomyScore: 95,
      motionNaturalnessScore: 95,
    }));

    expect(diagnosis?.primaryCode).toBe('QA_EVIDENCE_INCOMPLETE');
    expect(diagnosis?.retryRecommended).toBe(false);
    expect(diagnosis?.repairStrategy).toBe('REEXTRACT_AND_REQA');
  });

  it('classifies object disappearance as object continuity failure', () => {
    const diagnosis = VideoFailureDiagnosisService.diagnose(report({
      minimumIdentityScore: 96,
      averageIdentityScore: 97,
      identityDriftSegments: [],
      criticalIssues: ['phone disappears from the hand at frame 4'],
    }));

    expect(diagnosis?.primaryCode).toBe('OBJECT_CONTINUITY_FAILURE');
    expect(diagnosis?.repairStrategy).toBe('LOCK_OBJECT_CONTINUITY');
  });

  it('returns null for a certified PASS report', () => {
    const diagnosis = VideoFailureDiagnosisService.diagnose(report({
      pass: true,
      gateStatus: 'pass',
      averageIdentityScore: 98,
      minimumIdentityScore: 96,
      temporalConsistencyScore: 96,
      motionNaturalnessScore: 95,
      anatomyScore: 96,
      sceneContinuityScore: 95,
      promptComplianceScore: 96,
      identityDriftDetected: false,
      identityDriftSegments: [],
      criticalIssues: [],
    }));

    expect(diagnosis).toBeNull();
  });
});
