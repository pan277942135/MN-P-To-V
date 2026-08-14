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
 * qa_pending is special: QA itself may still decide an automatic provider regeneration.
 * We keep the slot until QA reaches the explicit human-review state. A REVIEW task no
 * longer consumes or may automatically consume provider capacity, so a new task may run.
 */
export function isProviderAdmissionBlockingTask(
  task: Partial<ServerVideoTaskRecord> | null | undefined
): boolean {
  if (!task?.taskId && !task?.id) return false;

  if (task.status === 'qa_pending') {
    return task.identityQaStatus !== 'review';
  }

  return BLOCKING_STATUSES.has(task.status as TaskStatus);
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
