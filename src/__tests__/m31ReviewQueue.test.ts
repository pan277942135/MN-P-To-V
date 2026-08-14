import { describe, expect, it } from 'vitest';
import type { ServerVideoTaskRecord } from '../types';
import {
  isHumanReviewEligibleTask,
  isSubmissionOutcomeUnknownTask,
  sortHumanReviewTasks,
} from '../services/review/humanReviewQueueService';

function task(overrides: Partial<ServerVideoTaskRecord> = {}): ServerVideoTaskRecord {
  return {
    id: 'review-task',
    taskId: 'review-task',
    status: 'qa_pending',
    modelId: 'veo-3.1-fast-generate-001',
    projectId: 'test-project',
    region: 'us-central1',
    durationSeconds: 4,
    aspectRatio: '9:16',
    resolution: '1080p',
    generateAudio: false,
    pollAttempt: 1,
    createdAt: 1000,
    updatedAt: 1000,
    artifactPersisted: true,
    outputBucket: 'bucket',
    outputObjectPath: 'veo/review-task/video.mp4',
    videoUri: 'gs://bucket/veo/review-task/video.mp4',
    identityQaStatus: 'review',
    qaReport: {
      pass: false,
      gateStatus: 'review',
      minimumIdentityScore: 88,
      averageIdentityScore: 92,
      summary: 'borderline review',
    },
    ...overrides,
  } as ServerVideoTaskRecord;
}

describe('M3-1 durable review queue selectors', () => {
  it('includes only unresolved qa_pending QA REVIEW tasks with persisted artifact authority', () => {
    expect(isHumanReviewEligibleTask(task())).toBe(true);
    expect(isHumanReviewEligibleTask(task({ artifactPersisted: false }))).toBe(false);
    expect(isHumanReviewEligibleTask(task({ outputObjectPath: '' }))).toBe(false);
    expect(isHumanReviewEligibleTask(task({ identityQaStatus: 'fail' }))).toBe(false);
    expect(isHumanReviewEligibleTask(task({ status: 'failed' }))).toBe(false);
  });

  it('excludes tasks that already have a durable human decision', () => {
    expect(isHumanReviewEligibleTask(task({ humanReviewDecision: 'accepted' }))).toBe(false);
    expect(isHumanReviewEligibleTask(task({
      humanReviewRecord: {
        decision: 'rejected',
        reviewerId: 'studio-workbench',
        reviewedAt: 2000,
        sourceQaStatus: 'review',
        sourceStateVersion: 9,
      },
    }))).toBe(false);
  });

  it('keeps submission_outcome_unknown outside the human acceptance queue', () => {
    const unknown = task({ status: 'submission_outcome_unknown' });
    expect(isSubmissionOutcomeUnknownTask(unknown)).toBe(true);
    expect(isHumanReviewEligibleTask(unknown)).toBe(false);
  });

  it('sorts the riskiest review first, then the oldest when scores tie', () => {
    const low = task({ taskId: 'low', id: 'low', createdAt: 3000, qaReport: { gateStatus: 'review', minimumIdentityScore: 82 } });
    const old = task({ taskId: 'old', id: 'old', createdAt: 1000, qaReport: { gateStatus: 'review', minimumIdentityScore: 90 } });
    const newer = task({ taskId: 'newer', id: 'newer', createdAt: 2000, qaReport: { gateStatus: 'review', minimumIdentityScore: 90 } });

    expect(sortHumanReviewTasks([newer, old, low]).map((item) => item.taskId)).toEqual(['low', 'old', 'newer']);
  });
});
