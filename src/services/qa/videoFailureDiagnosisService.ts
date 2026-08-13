import type { VideoIdentityQaReport, IdentityDriftSegment } from './videoIdentityQaService';

export type VideoFailureCode =
  | 'IDENTITY_SWAP_OR_SEVERE_LOSS'
  | 'IDENTITY_DRIFT'
  | 'EYE_OR_FACE_INSTABILITY'
  | 'HAIR_IDENTITY_DRIFT'
  | 'ANATOMY_DEFORMATION'
  | 'TEMPORAL_INSTABILITY'
  | 'MOTION_UNNATURALNESS'
  | 'SCENE_DISCONTINUITY'
  | 'PROMPT_NONCOMPLIANCE'
  | 'OBJECT_CONTINUITY_FAILURE'
  | 'CAMERA_INSTABILITY'
  | 'QA_EVIDENCE_INCOMPLETE'
  | 'UNKNOWN_VIDEO_QA_FAILURE';

export type FailureSeverity = 'review' | 'major' | 'critical';

export type RepairStrategy =
  | 'LOCK_IDENTITY_REDUCE_MOTION'
  | 'STABILIZE_FACE_AND_EYES'
  | 'LOCK_HAIR_IDENTITY'
  | 'REDUCE_ARTICULATION_COMPLEXITY'
  | 'TEMPORAL_STABILIZATION'
  | 'REDUCE_MOTION_INTENSITY'
  | 'LOCK_SCENE_AND_CAMERA'
  | 'TIGHTEN_PROMPT_CONSTRAINTS'
  | 'LOCK_OBJECT_CONTINUITY'
  | 'REEXTRACT_AND_REQA'
  | 'MANUAL_REVIEW';

export interface FailureEvidence {
  source: 'metric' | 'critical_issue' | 'drift_segment' | 'frame_score';
  code: string;
  value?: number | string;
  threshold?: number | string;
  timestampSec?: number;
  description: string;
}

export interface VideoFailureDiagnosis {
  version: 'm2-3-v1';
  primaryCode: VideoFailureCode;
  secondaryCodes: VideoFailureCode[];
  severity: FailureSeverity;
  retryRecommended: boolean;
  repairStrategy: RepairStrategy;
  repairPromptAppend: string;
  affectedRanges: IdentityDriftSegment[];
  worstFrameTimestamp: number | null;
  evidence: FailureEvidence[];
  summary: string;
}

interface Candidate {
  code: VideoFailureCode;
  severity: FailureSeverity;
  priority: number;
  strategy: RepairStrategy;
  prompt: string;
  evidence: FailureEvidence[];
}

const severityRank: Record<FailureSeverity, number> = {
  review: 1,
  major: 2,
  critical: 3,
};

const issuePatterns: Array<{
  code: VideoFailureCode;
  pattern: RegExp;
  severity: FailureSeverity;
  priority: number;
  strategy: RepairStrategy;
  prompt: string;
}> = [
  {
    code: 'IDENTITY_SWAP_OR_SEVERE_LOSS',
    pattern: /(identity\s*(swap|change)|different\s*person|face\s*swap|换脸|换人|身份变化|不是同一人)/i,
    severity: 'critical',
    priority: 120,
    strategy: 'LOCK_IDENTITY_REDUCE_MOTION',
    prompt: 'Lock the character identity to the approved first frame and master references. Reduce identity-risk head motion and do not change facial structure at any time.',
  },
  {
    code: 'EYE_OR_FACE_INSTABILITY',
    pattern: /(eye|eyes|gaze|pupil|iris|face|facial|blink|眼|瞳|视线|五官|脸).*(flicker|drift|warp|deform|unstable|asym|闪|漂|变形|不稳|大小不一)|(?:flicker|drift|warp|deform|unstable|闪|漂|变形).*(eye|eyes|face|眼|脸)/i,
    severity: 'major',
    priority: 105,
    strategy: 'STABILIZE_FACE_AND_EYES',
    prompt: 'Stabilize facial geometry, eye shape, pupil direction and blink timing. Preserve the approved face exactly; use only one natural blink and avoid rapid gaze or head changes.',
  },
  {
    code: 'HAIR_IDENTITY_DRIFT',
    pattern: /(hair|ponytail|hairstyle|发型|头发|马尾).*(change|drift|morph|flicker|变|漂|闪|错)/i,
    severity: 'major',
    priority: 95,
    strategy: 'LOCK_HAIR_IDENTITY',
    prompt: 'Keep the exact approved hairstyle, hairline, hair color, length and accessory placement stable across all frames. Only allow physically minimal hair movement.',
  },
  {
    code: 'ANATOMY_DEFORMATION',
    pattern: /(hand|finger|arm|leg|limb|body|anatom|extra\s*(hand|finger|limb)|手|手指|胳膊|腿|肢体|身体|多手|多指).*(warp|deform|extra|missing|wrong|变形|异常|多|缺)|(?:warp|deform|extra|missing|变形|异常|多出).*(hand|finger|limb|手|手指|肢体)/i,
    severity: 'critical',
    priority: 100,
    strategy: 'REDUCE_ARTICULATION_COMPLEXITY',
    prompt: 'Simplify limb and hand articulation. Preserve the original body pose and hand topology; avoid occlusion-heavy gestures, crossed limbs and large arm motion.',
  },
  {
    code: 'OBJECT_CONTINUITY_FAILURE',
    pattern: /(object|phone|cup|prop|手机|杯|道具|物体).*(disappear|vanish|float|morph|teleport|消失|悬空|变形|跳变)/i,
    severity: 'major',
    priority: 90,
    strategy: 'LOCK_OBJECT_CONTINUITY',
    prompt: 'Keep all visible props present, physically supported and in the same hand/location. Do not make the phone, cup or other objects disappear, float, morph or switch hands.',
  },
  {
    code: 'CAMERA_INSTABILITY',
    pattern: /(camera|framing|crop|zoom|pan|tilt|镜头|机位|构图).*(move|shift|jump|drift|zoom|移动|漂|跳|缩放)/i,
    severity: 'major',
    priority: 85,
    strategy: 'LOCK_SCENE_AND_CAMERA',
    prompt: 'Lock camera position, focal length, framing and subject placement. No zoom, pan, tilt, recentering or perspective jump unless explicitly requested.',
  },
  {
    code: 'TEMPORAL_INSTABILITY',
    pattern: /(flicker|temporal|frame\s*jump|jump\s*cut|闪烁|跳帧|时序|抖动|突变)/i,
    severity: 'major',
    priority: 80,
    strategy: 'TEMPORAL_STABILIZATION',
    prompt: 'Increase temporal consistency. Keep face, clothing, props, lighting and background continuous without frame-to-frame flicker or sudden geometry changes.',
  },
];

function addCandidate(candidates: Candidate[], candidate: Candidate) {
  const existing = candidates.find((item) => item.code === candidate.code);
  if (!existing) {
    candidates.push(candidate);
    return;
  }
  if (severityRank[candidate.severity] > severityRank[existing.severity]) {
    existing.severity = candidate.severity;
  }
  existing.priority = Math.max(existing.priority, candidate.priority);
  existing.evidence.push(...candidate.evidence);
}

function metricEvidence(
  code: string,
  value: number,
  threshold: number,
  description: string
): FailureEvidence {
  return { source: 'metric', code, value, threshold, description };
}

export class VideoFailureDiagnosisService {
  static diagnose(report: VideoIdentityQaReport): VideoFailureDiagnosis | null {
    if (report.gateStatus === 'pass' && report.pass === true) return null;

    const candidates: Candidate[] = [];

    if (!Array.isArray(report.frameReports) || report.frameReports.length === 0) {
      addCandidate(candidates, {
        code: 'QA_EVIDENCE_INCOMPLETE',
        severity: 'critical',
        priority: 130,
        strategy: 'REEXTRACT_AND_REQA',
        prompt: '',
        evidence: [{
          source: 'metric',
          code: 'NO_FRAME_REPORTS',
          description: 'Video QA returned no sampled-frame evidence.',
        }],
      });
    }

    if (report.minimumIdentityScore < 80) {
      addCandidate(candidates, {
        code: 'IDENTITY_SWAP_OR_SEVERE_LOSS',
        severity: 'critical',
        priority: 115,
        strategy: 'LOCK_IDENTITY_REDUCE_MOTION',
        prompt: 'Lock the character identity to the approved first frame and master references. Reduce head rotation, expression amplitude and motion intensity; never alter facial structure.',
        evidence: [metricEvidence(
          'MIN_IDENTITY_SCORE',
          report.minimumIdentityScore,
          80,
          'Minimum sampled-frame identity score is below the severe-loss threshold.'
        )],
      });
    } else if (report.minimumIdentityScore < 90) {
      addCandidate(candidates, {
        code: 'IDENTITY_DRIFT',
        severity: 'major',
        priority: 100,
        strategy: 'LOCK_IDENTITY_REDUCE_MOTION',
        prompt: 'Preserve the exact approved identity on every frame. Reduce head turn, expression amplitude and motion intensity around the drift interval.',
        evidence: [metricEvidence(
          'MIN_IDENTITY_SCORE',
          report.minimumIdentityScore,
          90,
          'Minimum sampled-frame identity score is below the stable-identity threshold.'
        )],
      });
    } else if (report.averageIdentityScore < 95) {
      addCandidate(candidates, {
        code: 'IDENTITY_DRIFT',
        severity: 'review',
        priority: 70,
        strategy: 'LOCK_IDENTITY_REDUCE_MOTION',
        prompt: 'Tighten identity preservation to the approved first frame and character masters while keeping motion subtle and continuous.',
        evidence: [metricEvidence(
          'AVERAGE_IDENTITY_SCORE',
          report.averageIdentityScore,
          95,
          'Average identity score is below the strict pass threshold.'
        )],
      });
    }

    if (report.temporalConsistencyScore < 75) {
      addCandidate(candidates, {
        code: 'TEMPORAL_INSTABILITY',
        severity: 'critical',
        priority: 110,
        strategy: 'TEMPORAL_STABILIZATION',
        prompt: 'Prioritize temporal stability over motion richness. Use one simple continuous action; keep face, clothing, props, lighting and background unchanged frame to frame.',
        evidence: [metricEvidence(
          'TEMPORAL_CONSISTENCY',
          report.temporalConsistencyScore,
          75,
          'Temporal consistency is below the hard-fail threshold.'
        )],
      });
    } else if (report.temporalConsistencyScore < 90) {
      addCandidate(candidates, {
        code: 'TEMPORAL_INSTABILITY',
        severity: 'major',
        priority: 88,
        strategy: 'TEMPORAL_STABILIZATION',
        prompt: 'Reduce motion complexity and preserve frame-to-frame continuity of identity, clothing, props, lighting and background.',
        evidence: [metricEvidence(
          'TEMPORAL_CONSISTENCY',
          report.temporalConsistencyScore,
          90,
          'Temporal consistency is below the strict pass threshold.'
        )],
      });
    }

    if (report.anatomyScore < 75) {
      addCandidate(candidates, {
        code: 'ANATOMY_DEFORMATION',
        severity: 'critical',
        priority: 108,
        strategy: 'REDUCE_ARTICULATION_COMPLEXITY',
        prompt: 'Preserve anatomy and limb topology. Simplify hand and limb motion, avoid occlusion-heavy gestures and keep the source pose close to the approved first frame.',
        evidence: [metricEvidence('ANATOMY_SCORE', report.anatomyScore, 75, 'Anatomy score is below the hard-fail threshold.')],
      });
    } else if (report.anatomyScore < 88) {
      addCandidate(candidates, {
        code: 'ANATOMY_DEFORMATION',
        severity: 'major',
        priority: 84,
        strategy: 'REDUCE_ARTICULATION_COMPLEXITY',
        prompt: 'Simplify body and hand articulation while preserving the original pose, proportions and limb topology.',
        evidence: [metricEvidence('ANATOMY_SCORE', report.anatomyScore, 88, 'Anatomy score is below the strict pass threshold.')],
      });
    }

    if (report.motionNaturalnessScore < 88) {
      addCandidate(candidates, {
        code: 'MOTION_UNNATURALNESS',
        severity: report.motionNaturalnessScore < 75 ? 'critical' : 'major',
        priority: 72,
        strategy: 'REDUCE_MOTION_INTENSITY',
        prompt: 'Use slower, smaller, physically plausible motion with stable balance, natural breathing and minimal head/hand acceleration.',
        evidence: [metricEvidence('MOTION_NATURALNESS', report.motionNaturalnessScore, 88, 'Motion naturalness is below the strict pass threshold.')],
      });
    }

    if (report.sceneContinuityScore < 90) {
      addCandidate(candidates, {
        code: 'SCENE_DISCONTINUITY',
        severity: report.sceneContinuityScore < 75 ? 'critical' : 'major',
        priority: 65,
        strategy: 'LOCK_SCENE_AND_CAMERA',
        prompt: 'Lock scene geometry, background, lighting, camera position, framing and perspective. Do not introduce new objects or background morphing.',
        evidence: [metricEvidence('SCENE_CONTINUITY', report.sceneContinuityScore, 90, 'Scene continuity is below the strict target.')],
      });
    }

    if (report.promptComplianceScore < 90) {
      addCandidate(candidates, {
        code: 'PROMPT_NONCOMPLIANCE',
        severity: report.promptComplianceScore < 75 ? 'critical' : 'major',
        priority: 60,
        strategy: 'TIGHTEN_PROMPT_CONSTRAINTS',
        prompt: 'Follow the requested motion literally and do not add unrequested camera moves, gestures, props, expression changes or scene changes.',
        evidence: [metricEvidence('PROMPT_COMPLIANCE', report.promptComplianceScore, 90, 'Prompt compliance is below the strict target.')],
      });
    }

    for (const issue of report.criticalIssues || []) {
      let matched = false;
      for (const rule of issuePatterns) {
        if (!rule.pattern.test(issue)) continue;
        matched = true;
        addCandidate(candidates, {
          code: rule.code,
          severity: rule.severity,
          priority: rule.priority,
          strategy: rule.strategy,
          prompt: rule.prompt,
          evidence: [{
            source: 'critical_issue',
            code: rule.code,
            value: issue,
            description: `Critical QA issue matched ${rule.code}.`,
          }],
        });
      }
      if (!matched) {
        addCandidate(candidates, {
          code: 'UNKNOWN_VIDEO_QA_FAILURE',
          severity: 'major',
          priority: 45,
          strategy: 'MANUAL_REVIEW',
          prompt: '',
          evidence: [{
            source: 'critical_issue',
            code: 'UNCLASSIFIED_CRITICAL_ISSUE',
            value: issue,
            description: 'Critical issue could not be mapped deterministically to a known failure class.',
          }],
        });
      }
    }

    for (const segment of report.identityDriftSegments || []) {
      addCandidate(candidates, {
        code: segment.severity === 'fail' ? 'IDENTITY_SWAP_OR_SEVERE_LOSS' : 'IDENTITY_DRIFT',
        severity: segment.severity === 'fail' ? 'critical' : 'major',
        priority: segment.severity === 'fail' ? 112 : 92,
        strategy: 'LOCK_IDENTITY_REDUCE_MOTION',
        prompt: 'Keep identity locked through the affected interval and reduce motion complexity around that time range.',
        evidence: [{
          source: 'drift_segment',
          code: 'IDENTITY_DRIFT_SEGMENT',
          value: `${segment.startTimestampSec}-${segment.endTimestampSec}s`,
          threshold: 90,
          timestampSec: segment.startTimestampSec,
          description: `Identity drift segment detected; minimum score ${segment.minimumIdentityScore}.`,
        }],
      });
    }

    if (candidates.length === 0) {
      candidates.push({
        code: 'UNKNOWN_VIDEO_QA_FAILURE',
        severity: report.gateStatus === 'review' ? 'review' : 'major',
        priority: 10,
        strategy: 'MANUAL_REVIEW',
        prompt: '',
        evidence: [{
          source: 'metric',
          code: 'UNCLASSIFIED_GATE_FAILURE',
          description: `QA gate returned ${report.gateStatus} without a known deterministic trigger.`,
        }],
      });
    }

    candidates.sort((a, b) => {
      const severityDelta = severityRank[b.severity] - severityRank[a.severity];
      return severityDelta !== 0 ? severityDelta : b.priority - a.priority;
    });

    const primary = candidates[0];
    const secondaryCodes = [...new Set(candidates.slice(1).map((candidate) => candidate.code))]
      .filter((code) => code !== primary.code);
    const evidence = candidates.flatMap((candidate) => candidate.evidence);
    const affectedRanges = report.identityDriftSegments || [];

    const retryRecommended =
      primary.strategy !== 'MANUAL_REVIEW' &&
      primary.strategy !== 'REEXTRACT_AND_REQA' &&
      primary.code !== 'QA_EVIDENCE_INCOMPLETE';

    return {
      version: 'm2-3-v1',
      primaryCode: primary.code,
      secondaryCodes,
      severity: primary.severity,
      retryRecommended,
      repairStrategy: primary.strategy,
      repairPromptAppend: primary.prompt,
      affectedRanges,
      worstFrameTimestamp: report.worstFrameTimestamp,
      evidence,
      summary: `${primary.code}: ${primary.evidence[0]?.description || report.summary}`,
    };
  }
}
