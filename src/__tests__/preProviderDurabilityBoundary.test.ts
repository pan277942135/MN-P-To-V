import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { firestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';
import { setFirestoreInstanceForTesting } from '../server/db/firestore';
import { taskStateMachineService } from '../server/services/taskStateMachineService';

class MockCollection {
  docs = new Map<string, any>();
  doc(id: string) {
    return {
      get: async () => {
        const data = this.docs.get(id);
        return { exists: data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };
      },
      set: async (data: any) => this.docs.set(id, structuredClone(data)),
      update: async (patch: any) => this.docs.set(id, { ...(this.docs.get(id) || {}), ...structuredClone(patch) }),
      delete: async () => this.docs.delete(id),
    };
  }
  orderBy() { return this; }
  limit() { return this; }
  get = async () => [];
}

class MockFirestore {
  collections = new Map<string, MockCollection>();
  collection(name: string) {
    if (!this.collections.has(name)) this.collections.set(name, new MockCollection());
    return this.collections.get(name)!;
  }
  runTransaction = async (fn: any) => fn({
    get: async (ref: any) => ref.get(),
    set: (ref: any, data: any) => ref.set(data),
    update: (ref: any, patch: any) => ref.update(patch),
    delete: (ref: any) => ref.delete(),
  });
}
import type { ServerVideoTaskRecord } from '../types';

function preparingTask(id: string, leaseExpiresAt = Date.now() + 180000): ServerVideoTaskRecord {
  const now = Date.now();
  return {
    id, taskId: id, status: 'preparing', projectId: `pre-provider-test-${id}`, region: 'us-central1',
    createdAt: now, updatedAt: now, providerAttempt: 1,
    providerStorageTaskKey: id, expectedProviderStorageUri: `gs://bucket/veo/${id}/`,
    providerStorageIntentPersistedAt: now, executionId: `exec_${id}`, leaseOwner: 'test',
    leaseExpiresAt, heartbeatAt: now, attempt: 1, maxAttempts: 3, stateVersion: 1, statusVersion: 1,
  } as ServerVideoTaskRecord;
}

describe('pre-provider durable authorization boundary', () => {
  beforeEach(() => {
    setFirestoreInstanceForTesting(new MockFirestore() as any);
    firestoreTaskRepository.resetDiagnostics();
  });
  afterEach(() => setFirestoreInstanceForTesting(null));

  it('moves preparing -> submitting only with matching lease and durable storage intent', async () => {
    const task = preparingTask('prep_auth');
    await firestoreTaskRepository.createTask(task);
    const authorized = await taskStateMachineService.authorizeProviderSubmission({
      taskId: task.taskId, executionId: task.executionId!, providerStorageTaskKey: task.providerStorageTaskKey!,
      expectedProviderStorageUri: task.expectedProviderStorageUri!,
    });
    expect(authorized.status).toBe('submitting');
    expect(authorized.providerSubmissionAuthorizedAt).toBeTypeOf('number');
    expect(authorized.providerSubmissionAuthorizedExecutionId).toBe(task.executionId);
  });

  it('is idempotent for the same execution after authorization commit', async () => {
    const task = preparingTask('prep_idempotent');
    await firestoreTaskRepository.createTask(task);
    const first = await taskStateMachineService.authorizeProviderSubmission({
      taskId: task.taskId, executionId: task.executionId!, providerStorageTaskKey: task.providerStorageTaskKey!,
      expectedProviderStorageUri: task.expectedProviderStorageUri!,
    });
    const second = await taskStateMachineService.authorizeProviderSubmission({
      taskId: task.taskId, executionId: task.executionId!, providerStorageTaskKey: task.providerStorageTaskKey!,
      expectedProviderStorageUri: task.expectedProviderStorageUri!,
    });
    expect(second.status).toBe('submitting');
    expect(second.providerSubmissionAuthorizedAt).toBe(first.providerSubmissionAuthorizedAt);
  });

  it('rejects an expired lease without crossing the Provider authorization boundary', async () => {
    const task = preparingTask('prep_expired', Date.now() - 1);
    await firestoreTaskRepository.createTask(task);
    await expect(taskStateMachineService.authorizeProviderSubmission({
      taskId: task.taskId, executionId: task.executionId!, providerStorageTaskKey: task.providerStorageTaskKey!,
      expectedProviderStorageUri: task.expectedProviderStorageUri!,
    })).rejects.toThrow('PRE_PROVIDER_LEASE_EXPIRED');
    const stored = await firestoreTaskRepository.getTask(task.taskId);
    expect(stored?.status).toBe('preparing');
    expect(stored?.providerSubmissionAuthorizedAt).toBeUndefined();
  });

  it('safe-fails preparing work before Provider authorization', async () => {
    const task = preparingTask('prep_fail');
    await firestoreTaskRepository.createTask(task);
    const failed = await taskStateMachineService.failPreparingBeforeProvider({
      taskId: task.taskId, executionId: task.executionId!, message: 'lease setup failed',
    });
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('pre_provider_authorization_failed');
    expect(failed.retryMode).toBe('SAFE_TO_REGENERATE');
    expect(failed.providerSubmissionAuthorizedAt).toBeUndefined();
  });

  it('reconciles an expired preparing lease to safe failure but leaves a fresh lease alone', async () => {
    const fresh = preparingTask('prep_fresh', Date.now() + 60000);
    const stale = preparingTask('prep_stale', Date.now() - 1);
    await firestoreTaskRepository.createTask(fresh);
    await firestoreTaskRepository.createTask(stale);
    const freshResult = await taskStateMachineService.reconcileStalePreparingTask({ taskId: fresh.taskId });
    const staleResult = await taskStateMachineService.reconcileStalePreparingTask({ taskId: stale.taskId });
    expect(freshResult.failed).toBe(false);
    expect(freshResult.task.status).toBe('preparing');
    expect(staleResult.failed).toBe(true);
    expect(staleResult.task.status).toBe('failed');
    expect(staleResult.task.failureReason).toBe('pre_provider_abandoned');
  });
});
