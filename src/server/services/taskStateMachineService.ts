import type { ServerVideoTaskRecord, TaskStatus } from '../../types';
import { firestoreTaskRepository } from '../repositories/firestoreTaskRepository';
import { gcsArtifactStore, getVeoBucketName, getVeoObjectPath } from '../storage/gcsArtifactStore';

export interface StructuredError {
  code: string;
  message: string;
  stage: string;
  retryable: boolean;
  executionId?: string;
  attempt?: number;
  timestamp: number;
  httpStatus?: number;
  details?: any;
}

export class InvalidStateTransitionError extends Error {
  constructor(public fromStatus: TaskStatus, public toStatus: TaskStatus, public taskId: string) {
    super(`[State Machine] Illegal transition for task ${taskId}: ${fromStatus} -> ${toStatus}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class StateVersionMismatchError extends Error {
  constructor(public taskId: string, public expectedVersion: number, public actualVersion: number) {
    super(`[State Machine] Version mismatch for task ${taskId}: expected ${expectedVersion}, actual ${actualVersion}`);
    this.name = 'StateVersionMismatchError';
  }
}

export class LateWorkerError extends Error {
  constructor(public taskId: string, public workerExecutionId: string, public currentExecutionId: string) {
    super(`[State Machine] Late worker rejected for task ${taskId}: worker executionId ${workerExecutionId} vs current ${currentExecutionId}`);
    this.name = 'LateWorkerError';
  }
}

const ALLOWED_TRANSITIONS: Record<string, TaskStatus[]> = {
  created: ['preparing', 'submitting', 'failed', 'cancelled', 'canceled'],
  preparing: ['generating', 'submitting', 'failed', 'cancelled', 'canceled'],
  submitting: ['submitted', 'preparing', 'generating', 'failed', 'cancelled', 'canceled'],
  submitted: ['polling', 'generating', 'failed', 'cancelled', 'canceled'],
  generating: ['generation_succeeded', 'polling', 'failed', 'cancelled', 'canceled'],
  polling: ['generation_succeeded', 'polling_timeout', 'failed', 'cancelled', 'canceled'],
  polling_timeout: ['polling', 'generating', 'failed', 'cancelled', 'canceled'],
  generation_succeeded: ['artifact_persisting', 'failed', 'cancelled', 'canceled'],
  artifact_persisting: ['artifact_persisted', 'artifact_persist_failed', 'failed'],
  artifact_persist_failed: ['artifact_persisting', 'failed', 'cancelled', 'canceled'],
  artifact_persisted: ['qa_pending', 'completed', 'failed'],
  qa_pending: ['completed', 'failed', 'cancelled', 'canceled'],
  completed: [],
  failed: [],
  cancelled: [],
  canceled: [],
};

export function canTransition(fromStatus: TaskStatus, toStatus: TaskStatus): boolean {
  if (fromStatus === toStatus) return true;
  const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

export function buildStructuredError(params: {
  code?: string;
  message: string;
  stage: string;
  retryable?: boolean;
  executionId?: string;
  attempt?: number;
  httpStatus?: number;
  details?: any;
}): StructuredError {
  return {
    code: params.code || 'TASK_EXECUTION_ERROR',
    message: params.message,
    stage: params.stage,
    retryable: params.retryable ?? false,
    executionId: params.executionId,
    attempt: params.attempt,
    timestamp: Date.now(),
    httpStatus: params.httpStatus,
    details: params.details,
  };
}

export interface AcquireLeaseResult {
  acquired: boolean;
  reason?: 'terminal_state' | 'already_running' | 'max_attempts_exceeded' | 'acquired';
  executionId?: string;
  task?: ServerVideoTaskRecord;
}

export class TaskStateMachineService {
  /**
   * Atomic state transition with CAN check, version match check (CAS), and executionId verify
   */
  public async transitionTask(params: {
    taskId: string;
    toStatus: TaskStatus;
    expectedStateVersion?: number;
    executionId?: string;
    patch?: Partial<ServerVideoTaskRecord>;
    force?: boolean;
  }): Promise<ServerVideoTaskRecord> {
    const { taskId, toStatus, expectedStateVersion, executionId, patch = {}, force = false } = params;

    return await firestoreTaskRepository.runTaskTransaction(taskId, (currentTask) => {
      if (!currentTask) {
        throw new Error(`[TaskStateMachine] Task ${taskId} not found in Firestore.`);
      }

      // Check transition legality
      if (!force && !canTransition(currentTask.status, toStatus)) {
        throw new InvalidStateTransitionError(currentTask.status, toStatus, taskId);
      }

      // Check state version (CAS)
      const currentVersion = currentTask.stateVersion ?? currentTask.statusVersion ?? 1;
      if (expectedStateVersion !== undefined && currentVersion !== expectedStateVersion) {
        throw new StateVersionMismatchError(taskId, expectedStateVersion, currentVersion);
      }

      // Check late worker execution ID
      if (executionId !== undefined && currentTask.executionId && currentTask.executionId !== executionId) {
        throw new LateWorkerError(taskId, executionId, currentTask.executionId);
      }

      const nextVersion = currentVersion + 1;
      const now = Date.now();

      const updatedRecord: ServerVideoTaskRecord = {
        ...currentTask,
        ...patch,
        status: toStatus,
        stateVersion: nextVersion,
        statusVersion: nextVersion,
        updatedAt: now,
        ...(toStatus === 'completed' ? { completedAt: patch.completedAt || now } : {}),
      };

      return {
        taskPatch: updatedRecord,
        result: updatedRecord,
      };
    });
  }

  /**
   * Atomically acquires an execution lease on a task for a given worker.
   */
  public async acquireLease(params: {
    taskId: string;
    leaseOwner: string;
    leaseDurationMs?: number;
    maxAttempts?: number;
  }): Promise<AcquireLeaseResult> {
    const { taskId, leaseOwner, leaseDurationMs = 60000, maxAttempts = 3 } = params;

    return await firestoreTaskRepository.runTaskTransaction<AcquireLeaseResult>(taskId, (currentTask) => {
      if (!currentTask) {
        throw new Error(`[TaskStateMachine] Task ${taskId} not found.`);
      }

      const now = Date.now();

      // Check terminal state
      if (['completed', 'failed', 'cancelled', 'canceled'].includes(currentTask.status)) {
        return {
          taskPatch: undefined,
          result: { acquired: false, reason: 'terminal_state' as const, task: currentTask },
        };
      }

      // Check active unexpired lease by another owner
      const isLeaseActive = currentTask.leaseExpiresAt && currentTask.leaseExpiresAt > now;
      if (isLeaseActive && currentTask.leaseOwner && currentTask.leaseOwner !== leaseOwner) {
        return {
          taskPatch: undefined,
          result: { acquired: false, reason: 'already_running' as const, task: currentTask },
        };
      }

      // Check attempts limit
      const currentAttempt = (currentTask.attempt || 0) + 1;
      const effectiveMax = currentTask.maxAttempts || maxAttempts;

      if (currentAttempt > effectiveMax) {
        const errorMsg = `Exceeded max execution attempts (${effectiveMax}).`;
        const updatedTask: ServerVideoTaskRecord = {
          ...currentTask,
          status: 'failed',
          error: errorMsg,
          structuredError: buildStructuredError({
            code: 'MAX_ATTEMPTS_EXCEEDED',
            message: errorMsg,
            stage: 'execution_lease',
            retryable: false,
            attempt: currentAttempt,
          }),
          updatedAt: now,
        };
        return {
          taskPatch: updatedTask,
          result: { acquired: false, reason: 'max_attempts_exceeded' as const, task: updatedTask },
        };
      }

      // Acquire lease
      const executionId = `exec_${now}_${Math.random().toString(36).substring(2, 9)}`;
      const nextVersion = (currentTask.stateVersion ?? currentTask.statusVersion ?? 1) + 1;

      const taskPatch: Partial<ServerVideoTaskRecord> = {
        executionId,
        leaseOwner,
        leaseExpiresAt: now + leaseDurationMs,
        heartbeatAt: now,
        attempt: currentAttempt,
        maxAttempts: effectiveMax,
        stateVersion: nextVersion,
        statusVersion: nextVersion,
        updatedAt: now,
      };

      const updatedTask: ServerVideoTaskRecord = {
        ...currentTask,
        ...taskPatch,
      };

      return {
        taskPatch,
        result: {
          acquired: true,
          reason: 'acquired' as const,
          executionId,
          task: updatedTask,
        },
      };
    });
  }

  /**
   * Renew lease heartbeat for an ongoing execution
   */
  public async renewLease(taskId: string, executionId: string, leaseDurationMs = 60000): Promise<boolean> {
    return await firestoreTaskRepository.runTaskTransaction(taskId, (currentTask) => {
      if (!currentTask || currentTask.executionId !== executionId) {
        return { taskPatch: undefined, result: false };
      }

      const now = Date.now();
      const taskPatch: Partial<ServerVideoTaskRecord> = {
        heartbeatAt: now,
        leaseExpiresAt: now + leaseDurationMs,
        updatedAt: now,
      };

      return {
        taskPatch,
        result: true,
      };
    });
  }

  /**
   * Release lease upon task completion, failure, or cancellation
   */
  public async releaseLease(taskId: string, executionId?: string): Promise<boolean> {
    return await firestoreTaskRepository.runTaskTransaction(taskId, (currentTask) => {
      if (!currentTask) return { taskPatch: undefined, result: false };
      if (executionId && currentTask.executionId !== executionId) {
        return { taskPatch: undefined, result: false };
      }

      const taskPatch: Partial<ServerVideoTaskRecord> = {
        leaseExpiresAt: 0,
        updatedAt: Date.now(),
      };

      return { taskPatch, result: true };
    });
  }

  /**
   * Run background crash recovery scan for abandoned or stalled tasks
   */
  public async recoverAbandonedTasks(): Promise<{ recoveredCount: number; evaluatedCount: number }> {
    if (!firestoreTaskRepository.isAvailable()) {
      return { recoveredCount: 0, evaluatedCount: 0 };
    }

    const tasks = await firestoreTaskRepository.listTasks(100);
    const now = Date.now();
    let recoveredCount = 0;

    for (const task of tasks) {
      // Ignore terminal tasks
      if (['completed', 'failed', 'cancelled', 'canceled'].includes(task.status)) {
        continue;
      }

      const isExpired = !task.leaseExpiresAt || task.leaseExpiresAt <= now;
      if (!isExpired) {
        continue;
      }

      // Task lease expired or abandoned. Attempt recovery based on current state.
      try {
        if (task.status === 'artifact_persisting' || task.status === 'artifact_persist_failed') {
          const bucket = task.outputBucket || getVeoBucketName();
          const objectPath = task.outputObjectPath || getVeoObjectPath(task.taskId);
          // Check if GCS artifact was already persisted
          const checkRes = await gcsArtifactStore.checkArtifactExists(bucket, objectPath);
          if (checkRes.exists) {
            console.log(`[TaskRecovery] Recovering task ${task.taskId}: GCS artifact verified. Transitioning to completed.`);
            await this.transitionTask({
              taskId: task.taskId,
              toStatus: 'artifact_persisted',
              patch: {
                outputBucket: bucket,
                outputObjectPath: objectPath,
                videoUri: `gs://${bucket}/${objectPath}`,
                sizeBytes: checkRes.sizeBytes || task.sizeBytes,
                artifactPersisted: true,
                artifactPersistedAt: Date.now(),
              },
            });
            await this.transitionTask({
              taskId: task.taskId,
              toStatus: 'qa_pending',
            });
            await this.transitionTask({
              taskId: task.taskId,
              toStatus: 'completed',
              patch: {
                completedAt: Date.now(),
                videoDataUrl: `/api/videos/stream/${task.taskId}`,
              },
            });
            await this.releaseLease(task.taskId);
            recoveredCount++;
            continue;
          }
        }

        if (task.status === 'generation_succeeded') {
          // If video output bucket and path exist or videoUri exists
          if (task.outputBucket && task.outputObjectPath) {
            await this.transitionTask({
              taskId: task.taskId,
              toStatus: 'artifact_persisting',
            });
            await this.transitionTask({
              taskId: task.taskId,
              toStatus: 'artifact_persisted',
              patch: { artifactPersisted: true, artifactPersistedAt: Date.now() },
            });
            await this.transitionTask({
              taskId: task.taskId,
              toStatus: 'qa_pending',
            });
            await this.transitionTask({
              taskId: task.taskId,
              toStatus: 'completed',
              patch: {
                completedAt: Date.now(),
                videoDataUrl: `/api/videos/stream/${task.taskId}`,
              },
            });
            await this.releaseLease(task.taskId);
            recoveredCount++;
            continue;
          }
        }

        // For stuck preparing / submitting / generating without active lease
        if (['created', 'preparing', 'submitting', 'submitted', 'generating', 'polling'].includes(task.status)) {
          const attempt = (task.attempt || 0) + 1;
          if (attempt > (task.maxAttempts || 3)) {
            console.warn(`[TaskRecovery] Task ${task.taskId} reached max attempts. Marking failed.`);
            await this.transitionTask({
              taskId: task.taskId,
              toStatus: 'failed',
              patch: {
                error: 'Task abandoned and exceeded max recovery attempts.',
                structuredError: buildStructuredError({
                  code: 'RECOVERY_MAX_ATTEMPTS',
                  message: 'Task abandoned and exceeded max recovery attempts.',
                  stage: 'recovery',
                  retryable: false,
                  attempt,
                }),
              },
              force: true,
            });
            await this.releaseLease(task.taskId);
            recoveredCount++;
          }
        }
      } catch (recoveryErr) {
        console.error(`[TaskRecovery] Error recovering task ${task.taskId}:`, recoveryErr);
      }
    }

    return { recoveredCount, evaluatedCount: tasks.length };
  }
}

export const taskStateMachineService = new TaskStateMachineService();
