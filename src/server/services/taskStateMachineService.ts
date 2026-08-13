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
    super(
      `[State Machine] Late worker rejected for task ${taskId}: worker executionId ${workerExecutionId} vs current ${currentExecutionId}`
    );
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

function currentVersion(task: ServerVideoTaskRecord): number {
  return task.stateVersion ?? task.statusVersion ?? 1;
}

export class TaskStateMachineService {
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

      if (!force && !canTransition(currentTask.status, toStatus)) {
        throw new InvalidStateTransitionError(currentTask.status, toStatus, taskId);
      }

      const version = currentVersion(currentTask);
      if (expectedStateVersion !== undefined && version !== expectedStateVersion) {
        throw new StateVersionMismatchError(taskId, expectedStateVersion, version);
      }

      if (
        executionId !== undefined &&
        currentTask.executionId &&
        currentTask.executionId !== executionId
      ) {
        throw new LateWorkerError(taskId, executionId, currentTask.executionId);
      }

      const nextVersion = version + 1;
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
      if (['completed', 'failed', 'cancelled', 'canceled'].includes(currentTask.status)) {
        return {
          taskPatch: undefined,
          result: { acquired: false, reason: 'terminal_state' as const, task: currentTask },
        };
      }

      const isLeaseActive = Boolean(currentTask.leaseExpiresAt && currentTask.leaseExpiresAt > now);
      if (isLeaseActive && currentTask.leaseOwner && currentTask.leaseOwner !== leaseOwner) {
        return {
          taskPatch: undefined,
          result: { acquired: false, reason: 'already_running' as const, task: currentTask },
        };
      }

      const nextAttempt = (currentTask.attempt || 0) + 1;
      const effectiveMax = currentTask.maxAttempts || maxAttempts;
      const nextVersion = currentVersion(currentTask) + 1;

      if (nextAttempt > effectiveMax) {
        const errorMsg = `Exceeded max execution attempts (${effectiveMax}).`;
        const updatedTask: ServerVideoTaskRecord = {
          ...currentTask,
          status: 'failed',
          stateVersion: nextVersion,
          statusVersion: nextVersion,
          attempt: nextAttempt,
          error: errorMsg,
          structuredError: buildStructuredError({
            code: 'MAX_ATTEMPTS_EXCEEDED',
            message: errorMsg,
            stage: 'execution_lease',
            retryable: false,
            attempt: nextAttempt,
          }),
          updatedAt: now,
        };
        return {
          taskPatch: updatedTask,
          result: { acquired: false, reason: 'max_attempts_exceeded' as const, task: updatedTask },
        };
      }

      const executionId = `exec_${crypto.randomUUID()}`;
      const taskPatch: Partial<ServerVideoTaskRecord> = {
        executionId,
        leaseOwner,
        leaseExpiresAt: now + leaseDurationMs,
        heartbeatAt: now,
        attempt: nextAttempt,
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

  public async renewLease(
    taskId: string,
    executionId: string,
    leaseDurationMs = 60000
  ): Promise<boolean> {
    return await firestoreTaskRepository.runTaskTransaction(taskId, (currentTask) => {
      if (!currentTask || currentTask.executionId !== executionId) {
        return { taskPatch: undefined, result: false };
      }

      const now = Date.now();
      const nextVersion = currentVersion(currentTask) + 1;
      const taskPatch: Partial<ServerVideoTaskRecord> = {
        heartbeatAt: now,
        leaseExpiresAt: now + leaseDurationMs,
        stateVersion: nextVersion,
        statusVersion: nextVersion,
        updatedAt: now,
      };

      return { taskPatch, result: true };
    });
  }

  public async releaseLease(taskId: string, executionId?: string): Promise<boolean> {
    return await firestoreTaskRepository.runTaskTransaction(taskId, (currentTask) => {
      if (!currentTask) return { taskPatch: undefined, result: false };
      if (executionId && currentTask.executionId !== executionId) {
        return { taskPatch: undefined, result: false };
      }

      const nextVersion = currentVersion(currentTask) + 1;
      const taskPatch: Partial<ServerVideoTaskRecord> = {
        leaseExpiresAt: 0,
        stateVersion: nextVersion,
        statusVersion: nextVersion,
        updatedAt: Date.now(),
      };
      return { taskPatch, result: true };
    });
  }

  public async completeWithPersistedArtifact(params: {
    taskId: string;
    outputBucket: string;
    outputObjectPath: string;
    videoUri: string;
    sizeBytes?: number;
    contentType?: string;
    artifactPersistedAt?: number;
    patch?: Partial<ServerVideoTaskRecord>;
  }): Promise<ServerVideoTaskRecord> {
    const {
      taskId,
      outputBucket,
      outputObjectPath,
      videoUri,
      sizeBytes,
      contentType = 'video/mp4',
      artifactPersistedAt = Date.now(),
      patch = {},
    } = params;

    const advance = async (toStatus: TaskStatus, transitionPatch: Partial<ServerVideoTaskRecord> = {}) => {
      return await this.transitionTask({ taskId, toStatus, patch: transitionPatch });
    };

    let task = await firestoreTaskRepository.getTask(taskId);
    if (!task) {
      throw new Error(`[TaskStateMachine] Task ${taskId} not found while finalizing artifact.`);
    }

    if (task.status === 'completed') {
      if (
        task.artifactPersisted !== true ||
        !task.outputBucket ||
        !task.outputObjectPath ||
        !task.videoUri
      ) {
        throw new Error(`[TaskStateMachine] Completed task ${taskId} violates artifact invariant.`);
      }
      return task;
    }

    // Normalize every legacy/active provider state into the canonical production chain.
    if (task.status === 'created') {
      task = await advance('preparing');
    }
    if (task.status === 'preparing' || task.status === 'submitting' || task.status === 'submitted') {
      task = await advance('generating');
    }
    if (task.status === 'polling_timeout') {
      task = await advance('polling');
    }
    if (task.status === 'generating' || task.status === 'polling') {
      task = await advance('generation_succeeded');
    }
    if (task.status === 'generation_succeeded' || task.status === 'artifact_persist_failed') {
      task = await advance('artifact_persisting');
    }
    if (task.status === 'artifact_persisting') {
      task = await advance('artifact_persisted', {
        ...patch,
        outputBucket,
        outputObjectPath,
        videoUri,
        sizeBytes,
        contentType,
        artifactPersisted: true,
        artifactPersistedAt,
        videoDataUrl: `/api/videos/stream/${taskId}`,
      });
    }
    if (task.status === 'artifact_persisted') {
      task = await advance('qa_pending');
    }
    if (task.status === 'qa_pending') {
      task = await advance('completed', {
        ...patch,
        outputBucket,
        outputObjectPath,
        videoUri,
        sizeBytes,
        contentType,
        artifactPersisted: true,
        artifactPersistedAt,
        videoDataUrl: `/api/videos/stream/${taskId}`,
        completedAt: Date.now(),
      });
    }

    if (task.status !== 'completed') {
      throw new Error(
        `[TaskStateMachine] Task ${taskId} cannot be finalized from state ${task.status}.`
      );
    }

    return task;
  }

  private async finalizeExistingArtifact(
    task: ServerVideoTaskRecord,
    bucket: string,
    objectPath: string,
    sizeBytes?: number
  ): Promise<void> {
    let status = task.status;

    if (status === 'generation_succeeded') {
      await this.transitionTask({
        taskId: task.taskId,
        toStatus: 'artifact_persisting',
      });
      status = 'artifact_persisting';
    }

    if (status === 'artifact_persist_failed') {
      await this.transitionTask({
        taskId: task.taskId,
        toStatus: 'artifact_persisting',
      });
      status = 'artifact_persisting';
    }

    if (status === 'artifact_persisting') {
      await this.transitionTask({
        taskId: task.taskId,
        toStatus: 'artifact_persisted',
        patch: {
          outputBucket: bucket,
          outputObjectPath: objectPath,
          videoUri: `gs://${bucket}/${objectPath}`,
          sizeBytes: sizeBytes || task.sizeBytes,
          artifactPersisted: true,
          artifactPersistedAt: task.artifactPersistedAt || Date.now(),
          videoDataUrl: `/api/videos/stream/${task.taskId}`,
        },
      });
      status = 'artifact_persisted';
    }

    if (status === 'artifact_persisted') {
      await this.transitionTask({ taskId: task.taskId, toStatus: 'qa_pending' });
      status = 'qa_pending';
    }

    if (status === 'qa_pending') {
      await this.transitionTask({
        taskId: task.taskId,
        toStatus: 'completed',
        patch: {
          completedAt: Date.now(),
          videoDataUrl: `/api/videos/stream/${task.taskId}`,
        },
      });
    }

    await this.releaseLease(task.taskId);
  }

  public async recoverAbandonedTasks(): Promise<{
    recoveredCount: number;
    evaluatedCount: number;
  }> {
    if (!firestoreTaskRepository.isAvailable()) {
      return { recoveredCount: 0, evaluatedCount: 0 };
    }

    const tasks = await firestoreTaskRepository.listTasks(100);
    const now = Date.now();
    let recoveredCount = 0;

    for (const task of tasks) {
      if (['completed', 'failed', 'cancelled', 'canceled'].includes(task.status)) {
        continue;
      }

      const isExpired = !task.leaseExpiresAt || task.leaseExpiresAt <= now;
      if (!isExpired) continue;

      try {
        if (
          task.status === 'generation_succeeded' ||
          task.status === 'artifact_persisting' ||
          task.status === 'artifact_persist_failed' ||
          task.status === 'artifact_persisted' ||
          task.status === 'qa_pending'
        ) {
          const bucket = task.outputBucket || getVeoBucketName();
          const objectPath = task.outputObjectPath || getVeoObjectPath(task.taskId);
          const checkRes = await gcsArtifactStore.checkArtifactExists(bucket, objectPath);

          // Critical P0-5 rule: metadata/path presence is never evidence that the video
          // exists. Recovery may finalize only after GCS authority confirms a non-zero object.
          if (checkRes.exists && (checkRes.sizeBytes ?? task.sizeBytes ?? 0) > 0) {
            console.log(
              `[TaskRecovery] Recovering task ${task.taskId}: authoritative GCS artifact verified.`
            );
            await this.finalizeExistingArtifact(
              task,
              bucket,
              objectPath,
              checkRes.sizeBytes || task.sizeBytes
            );
            recoveredCount++;
            continue;
          }

          console.warn(
            `[TaskRecovery] Task ${task.taskId} has recovery metadata but no verified GCS artifact; leaving state ${task.status} unchanged.`
          );
        }

        if (
          ['created', 'preparing', 'submitting', 'submitted', 'generating', 'polling'].includes(
            task.status
          )
        ) {
          const nextAttempt = (task.attempt || 0) + 1;
          if (nextAttempt > (task.maxAttempts || 3)) {
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
                  attempt: nextAttempt,
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
