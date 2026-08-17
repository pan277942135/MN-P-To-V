import crypto from 'node:crypto';
import type { ServerVideoTaskRecord, TaskStatus } from '../../types';

const BLOCKING_STATUSES = new Set<TaskStatus>([
  'created',
  'preparing',
  'submitting',
  'submitted',
  'generating',
  'polling',
  'polling_timeout',
  'generation_succeeded',
  'artifact_persisting',
  'artifact_persisted',
  'submission_outcome_unknown',
]);

/**
 * Personal-mode provider admission is scoped to the configured Google Cloud project.
 * Different browser tabs / Cloud Run instances using the same project therefore share
 * one durable provider slot, while an intentionally separate project remains isolated.
 */
export function buildProviderAdmissionScopeKey(projectId?: string | null): string {
  const normalized = String(projectId || 'default-project').trim().toLowerCase() || 'default-project';
  const digest = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
  return `project_${digest}`;
}

/**
 * True means a second *different* video task must not be allowed to submit Veo yet.
 *
 * The provider slot protects the window in which a Veo submission may still be active or
 * ambiguous. Once a valid MP4 has been durably persisted to the authoritative GCS bucket,
 * that provider generation is finished. Post-video QA, re-QA, and human review operate on
 * the existing artifact and must not keep Veo capacity locked.
 */
export function isProviderAdmissionBlockingTask(
  task: Partial<ServerVideoTaskRecord> | null | undefined
): boolean {
  if (!task?.taskId && !task?.id) return false;

  const hasDurableVideoArtifact =
    task.artifactPersisted === true &&
    Boolean(task.outputBucket) &&
    Boolean(task.outputObjectPath) &&
    Boolean(task.videoUri);

  if (hasDurableVideoArtifact) {
    return false;
  }

  if (task.status === 'qa_pending') {
    // QA without a durable artifact is an inconsistent/fail-closed state. Keep the slot
    // unless the task has explicitly reached human review, which cannot auto-submit Veo.
    return task.identityQaStatus !== 'review';
  }

  return BLOCKING_STATUSES.has(task.status as TaskStatus);
}

/**
 * A task may be deleted only after it can no longer be consuming — or automatically
 * re-consume — provider capacity. In particular, submission_outcome_unknown must stay
 * durable until it is reconciled with a proven operationName or otherwise resolved by
 * explicit provider evidence; deleting it would reopen the duplicate-charge window.
 */
export function isProviderTaskDeletionSafe(
  task: Partial<ServerVideoTaskRecord> | null | undefined
): boolean {
  if (!task?.taskId && !task?.id) return true;
  return !isProviderAdmissionBlockingTask(task);
}

export interface ProviderAdmissionBusyDetails {
  blockingTaskId: string;
  blockingStatus: string;
  scopeKey: string;
}

export class ProviderAdmissionBusyError extends Error {
  public readonly code = 'PROVIDER_ADMISSION_BUSY';
  public readonly blockingTaskId: string;
  public readonly blockingStatus: string;
  public readonly scopeKey: string;

  constructor(details: ProviderAdmissionBusyDetails) {
    super(
      `[ProviderAdmission] Scope ${details.scopeKey} is occupied by task ${details.blockingTaskId} (${details.blockingStatus}).`
    );
    this.name = 'ProviderAdmissionBusyError';
    this.blockingTaskId = details.blockingTaskId;
    this.blockingStatus = details.blockingStatus;
    this.scopeKey = details.scopeKey;
  }
}
