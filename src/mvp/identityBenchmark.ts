import type { MvpIdentityQaReport } from './identitySafe';
import { decideFirstFrameEnhancement } from './identitySafe';

export interface IdentityBenchmarkCase {
  id: string;
  durationSeconds: 4 | 6 | 8;
  category: 'micro_expression' | 'hair_motion' | 'upper_body' | 'environment_motion';
  prompt: string;
}

const cases: IdentityBenchmarkCase[] = [
  { id: 'IDSAFE-01', durationSeconds: 4, category: 'micro_expression', prompt: 'Locked camera. Natural breathing and one gentle blink. Keep the same pose and expression.' },
  { id: 'IDSAFE-02', durationSeconds: 4, category: 'micro_expression', prompt: 'Locked camera. A faint stable smile appears very slightly, with one natural blink.' },
  { id: 'IDSAFE-03', durationSeconds: 4, category: 'micro_expression', prompt: 'Very subtle breathing. Eyes remain on the same point. One soft blink only.' },
  { id: 'IDSAFE-04', durationSeconds: 4, category: 'micro_expression', prompt: 'Keep the exact head angle. Minimal lip movement from relaxed to a faint smile.' },
  { id: 'IDSAFE-05', durationSeconds: 4, category: 'hair_motion', prompt: 'Locked camera. Only a few loose hair strands move gently in a light indoor breeze.' },
  { id: 'IDSAFE-06', durationSeconds: 4, category: 'hair_motion', prompt: 'Subtle breathing with minimal ponytail movement. Face orientation remains unchanged.' },
  { id: 'IDSAFE-07', durationSeconds: 4, category: 'upper_body', prompt: 'Very small shoulder relaxation and breathing. Head and face remain anchored.' },
  { id: 'IDSAFE-08', durationSeconds: 4, category: 'environment_motion', prompt: 'Person remains almost still while candlelight and background bokeh move subtly.' },

  { id: 'IDSAFE-09', durationSeconds: 6, category: 'micro_expression', prompt: 'Locked camera. Natural breathing, one blink near the middle, and a stable faint smile.' },
  { id: 'IDSAFE-10', durationSeconds: 6, category: 'micro_expression', prompt: 'Maintain the same gaze and head angle. One blink and tiny cheek movement only.' },
  { id: 'IDSAFE-11', durationSeconds: 6, category: 'hair_motion', prompt: 'Very gentle air movement affects only a few hair strands; body and face stay stable.' },
  { id: 'IDSAFE-12', durationSeconds: 6, category: 'hair_motion', prompt: 'Minimal natural hair motion and breathing. No head turn and no camera movement.' },
  { id: 'IDSAFE-13', durationSeconds: 6, category: 'upper_body', prompt: 'Tiny posture settling in place, then stillness. Keep face fully visible.' },
  { id: 'IDSAFE-14', durationSeconds: 6, category: 'upper_body', prompt: 'Subtle chest breathing and very small shoulder movement while maintaining the same pose.' },
  { id: 'IDSAFE-15', durationSeconds: 6, category: 'environment_motion', prompt: 'Person remains stable while curtains move slightly in the background.' },
  { id: 'IDSAFE-16', durationSeconds: 6, category: 'environment_motion', prompt: 'Keep person nearly motionless; only soft ambient light changes and background bokeh shimmer.' },

  { id: 'IDSAFE-17', durationSeconds: 8, category: 'micro_expression', prompt: 'Locked camera. Stable pose for eight seconds with two natural blinks and subtle breathing.' },
  { id: 'IDSAFE-18', durationSeconds: 8, category: 'micro_expression', prompt: 'Maintain identical head orientation and gaze. One blink early, one blink late, faint stable smile.' },
  { id: 'IDSAFE-19', durationSeconds: 8, category: 'hair_motion', prompt: 'Minimal hair-strand movement over time, with the face continuously visible and unchanged.' },
  { id: 'IDSAFE-20', durationSeconds: 8, category: 'hair_motion', prompt: 'Subtle breathing and tiny ponytail settling. No head movement, no camera movement.' },
  { id: 'IDSAFE-21', durationSeconds: 8, category: 'upper_body', prompt: 'Very slight posture settling once, then remain stable. Face stays fully visible.' },
  { id: 'IDSAFE-22', durationSeconds: 8, category: 'upper_body', prompt: 'Small natural breathing motion only. Preserve exact pose, framing and head angle.' },
  { id: 'IDSAFE-23', durationSeconds: 8, category: 'environment_motion', prompt: 'Person stays still while distant city lights shimmer subtly in the background.' },
  { id: 'IDSAFE-24', durationSeconds: 8, category: 'environment_motion', prompt: 'Locked person and camera; only ambient curtain and light movement in the environment.' },
];

export const IDENTITY_STABILITY_BENCHMARK_V1 = Object.freeze(cases);

export interface IdentityBenchmarkResult {
  caseId: string;
  firstAttemptReport: MvpIdentityQaReport;
  finalReport: MvpIdentityQaReport;
  retried: boolean;
}

export function summarizeIdentityBenchmark(results: IdentityBenchmarkResult[]) {
  const evaluatedCases = results.length;
  const firstPasses = results.filter((item) => item.firstAttemptReport.pass).length;
  const finalPasses = results.filter((item) => item.finalReport.pass).length;
  const earlyDrifts = results.filter((item) => {
    const report = item.firstAttemptReport;
    return report.identityDriftDetected && report.worstFrameTimestamp !== null && report.worstFrameTimestamp <= 1.0;
  }).length;
  const firstAttemptPassRate = evaluatedCases ? firstPasses / evaluatedCases : 0;
  const postRetryPassRate = evaluatedCases ? finalPasses / evaluatedCases : 0;
  const earlyDriftRate = evaluatedCases ? earlyDrifts / evaluatedCases : 0;
  const firstFrameEnhancementDecision = decideFirstFrameEnhancement({
    evaluatedCases,
    firstAttemptPassRate,
    postRetryPassRate,
    earlyDriftRate,
  });

  return {
    version: 'identity-stability-benchmark-v1',
    evaluatedCases,
    firstAttemptPassRate: Number(firstAttemptPassRate.toFixed(3)),
    postRetryPassRate: Number(postRetryPassRate.toFixed(3)),
    earlyDriftRate: Number(earlyDriftRate.toFixed(3)),
    retriedCases: results.filter((item) => item.retried).length,
    firstFrameEnhancementDecision,
  };
}
