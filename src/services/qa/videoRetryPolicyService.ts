import crypto from 'crypto';
import type { VideoFailureDiagnosis } from './videoFailureDiagnosisService';
import type { VideoIdentityQaReport } from './videoIdentityQaService';

export type RetryAction =
  | 'COMPLETE'
  | 'MANUAL_REVIEW'
  | 'REQA_SAME_ARTIFACT'
  | 'REGENERATE_VIDEO'
  | 'TERMINAL_FAIL';

export interface VideoRetryPolicyInput {
  taskId: string;
  qaReport: VideoIdentityQaReport;
  diagnosis: VideoFailureDiagnosis | null;
  providerAttempt: number;
  qaAttempt: number;
  maxProviderAttempts?: number;
  maxQaAttempts?: number;
  artifactObjectPath?: string;
}

export interface VideoRetryDecision {
  version: 'm2-4-v1';
  action: RetryAction;
  reasonCode: string;
  automatic: boolean;
  consumesProviderAttempt: boolean;
  nextProviderAttempt: number;
  nextQaAttempt: number;
  providerAttemptsRemaining: number;
  qaAttemptsRemaining: number;
  idempotencyKey?: string;
  repairPromptAppend?: string;
  preserveCurrentArtifact: boolean;
  requiresHumanReview: boolean;
}

const PROVIDER_RETRYABLE_CODES = new Set([
  'IDENTITY_SWAP_OR_SEVERE_LOSS',
  'IDENTITY_DRIFT',
  'EYE_OR_FACE_INSTABILITY',
  'HAIR_IDENTITY_DRIFT',
  'ANATOMY_DEFORMATION',
  'TEMPORAL_INSTABILITY',
  'MOTION_UNNATURALNESS',
  'SCENE_DISCONTINUITY',
  'PROMPT_NONCOMPLIANCE',
  'OBJECT_CONTINUITY_FAILURE',
  'CAMERA_INSTABILITY',
]);

export class VideoRetryPolicyService {
  static buildProviderRetryIdempotencyKey(params: {
    taskId: string;
    nextProviderAttempt: number;
    diagnosisCode: string;
    artifactObjectPath?: string;
  }): string {
    const stable = [
      'm2-4-provider-retry-v1',
      params.taskId,
      String(params.nextProviderAttempt),
      params.diagnosisCode,
      params.artifactObjectPath || 'no-artifact-path',
    ].join('|');
    return `retry_${crypto.createHash('sha256').update(stable).digest('hex').slice(0, 32)}`;
  }

  static decide(input: VideoRetryPolicyInput): VideoRetryDecision {
    const maxProviderAttempts = input.maxProviderAttempts ?? 2;
    const maxQaAttempts = input.maxQaAttempts ?? 2;
    const providerAttempt = Math.max(1, input.providerAttempt || 1);
    const qaAttempt = Math.max(1, input.qaAttempt || 1);
    const providerAttemptsRemaining = Math.max(0, maxProviderAttempts - providerAttempt);
    const qaAttemptsRemaining = Math.max(0, maxQaAttempts - qaAttempt);

    const base = {
      version: 'm2-4-v1' as const,
      nextProviderAttempt: providerAttempt,
      nextQaAttempt: qaAttempt,
      providerAttemptsRemaining,
      qaAttemptsRemaining,
      preserveCurrentArtifact: true,
    };

    if (input.qaReport.pass === true && input.qaReport.gateStatus === 'pass') {
      return {
        ...base,
        action: 'COMPLETE',
        reasonCode: 'QA_PASS',
        automatic: false,
        consumesProviderAttempt: false,
        requiresHumanReview: false,
      };
    }

    // REVIEW is deliberately not auto-regenerated. It represents evidence that is
    // close enough to require a person rather than spending provider quota blindly.
    if (input.qaReport.gateStatus === 'review') {
      return {
        ...base,
        action: 'MANUAL_REVIEW',
        reasonCode: 'QA_REVIEW_REQUIRES_HUMAN',
        automatic: false,
        consumesProviderAttempt: false,
        requiresHumanReview: true,
      };
    }

    if (!input.diagnosis) {
      return {
        ...base,
        action: 'MANUAL_REVIEW',
        reasonCode: 'DIAGNOSIS_MISSING',
        automatic: false,
        consumesProviderAttempt: false,
        requiresHumanReview: true,
      };
    }

    if (input.diagnosis.primaryCode === 'QA_EVIDENCE_INCOMPLETE') {
      if (qaAttemptsRemaining > 0) {
        return {
          ...base,
          action: 'REQA_SAME_ARTIFACT',
          reasonCode: 'QA_EVIDENCE_INCOMPLETE_REQA',
          automatic: true,
          consumesProviderAttempt: false,
          nextQaAttempt: qaAttempt + 1,
          requiresHumanReview: false,
        };
      }
      return {
        ...base,
        action: 'MANUAL_REVIEW',
        reasonCode: 'QA_EVIDENCE_RETRY_EXHAUSTED',
        automatic: false,
        consumesProviderAttempt: false,
        requiresHumanReview: true,
      };
    }

    if (
      input.diagnosis.retryRecommended !== true ||
      !PROVIDER_RETRYABLE_CODES.has(input.diagnosis.primaryCode)
    ) {
      return {
        ...base,
        action: 'MANUAL_REVIEW',
        reasonCode: 'DIAGNOSIS_NOT_PROVIDER_RETRYABLE',
        automatic: false,
        consumesProviderAttempt: false,
        requiresHumanReview: true,
      };
    }

    if (providerAttemptsRemaining <= 0) {
      return {
        ...base,
        action: 'TERMINAL_FAIL',
        reasonCode: 'PROVIDER_RETRY_BUDGET_EXHAUSTED',
        automatic: false,
        consumesProviderAttempt: false,
        requiresHumanReview: true,
      };
    }

    const nextProviderAttempt = providerAttempt + 1;
    return {
      ...base,
      action: 'REGENERATE_VIDEO',
      reasonCode: `RETRY_${input.diagnosis.primaryCode}`,
      automatic: true,
      consumesProviderAttempt: true,
      nextProviderAttempt,
      idempotencyKey: this.buildProviderRetryIdempotencyKey({
        taskId: input.taskId,
        nextProviderAttempt,
        diagnosisCode: input.diagnosis.primaryCode,
        artifactObjectPath: input.artifactObjectPath,
      }),
      repairPromptAppend: input.diagnosis.repairPromptAppend,
      requiresHumanReview: false,
    };
  }
}
