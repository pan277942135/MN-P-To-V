import type { ServerVideoTaskRecord } from '../../types';

export type HumanReviewQueueTask = ServerVideoTaskRecord & {
  qaReport?: any;
  identityQaReport?: any;
};

export function isHumanReviewEligibleTask(
  task: Partial<ServerVideoTaskRecord> | null | undefined
): task is HumanReviewQueueTask {
  if (!task || !task.taskId) return false;
  const qaReport = task.qaReport || task.identityQaReport;
  const artifactValid = task.artifactPersisted === true
    && Boolean(task.outputBucket)
    && Boolean(task.outputObjectPath)
    && Boolean(task.videoUri);

  return task.status === 'qa_pending'
    && task.identityQaStatus === 'review'
    && qaReport?.gateStatus === 'review'
    && artifactValid
    && !task.humanReviewDecision
    && !task.humanReviewRecord;
}

export function isSubmissionOutcomeUnknownTask(
  task: Partial<ServerVideoTaskRecord> | null | undefined
): task is HumanReviewQueueTask {
  return Boolean(task?.taskId) && task?.status === 'submission_outcome_unknown';
}

export function sortHumanReviewTasks(tasks: HumanReviewQueueTask[]): HumanReviewQueueTask[] {
  return [...tasks].sort((a, b) => {
    const aScore = Number(a.qaReport?.minimumIdentityScore ?? a.identityQaReport?.minimumIdentityScore ?? 100);
    const bScore = Number(b.qaReport?.minimumIdentityScore ?? b.identityQaReport?.minimumIdentityScore ?? 100);
    if (aScore !== bScore) return aScore - bScore;
    return Number(a.createdAt || 0) - Number(b.createdAt || 0);
  });
}
