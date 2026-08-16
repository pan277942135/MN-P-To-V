import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerVideoTaskRecord } from '../types';
import { firestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';
import { setFirestoreInstanceForTesting } from '../server/db/firestore';
import { taskStateMachineService } from '../server/services/taskStateMachineService';

class Doc {
  constructor(private store: Map<string, any>, private id: string) {}
  async get() { const data = this.store.get(this.id); return { exists: Boolean(data), data: () => data ? structuredClone(data) : undefined }; }
  async set(data: any) { this.store.set(this.id, structuredClone(data)); }
  async update(patch: any) { this.store.set(this.id, { ...(this.store.get(this.id) || {}), ...structuredClone(patch) }); }
}
class Collection {
  constructor(private store: Map<string, any>) {}
  doc(id: string) { return new Doc(this.store, id); }
  orderBy() { return this; }
  limit() { return this; }
  async get() { const docs = [...this.store.entries()].map(([id, data]) => ({ id, data: () => structuredClone(data) })); return { docs, forEach: (cb: (doc: any) => void) => docs.forEach(cb) }; }
}
class MockFirestore {
  store = new Map<string, any>();
  collection() { return new Collection(this.store); }
  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> { return await fn({ get: (ref: Doc) => ref.get(), set: (ref: Doc, data: any) => ref.set(data), update: (ref: Doc, patch: any) => ref.update(patch) }); }
}

function retryTask(id: string, state: 'reserved' | 'authorized', ageMs = 200000): ServerVideoTaskRecord {
  const now = Date.now();
  return {
    id, taskId: id, status: 'generating', stateVersion: 5, statusVersion: 5,
    modelId: 'veo-3.1-fast-generate-001', projectId: 'test-project-' + id, region: 'us-central1',
    durationSeconds: 4, aspectRatio: '9:16', resolution: '1080p', generateAudio: false, pollAttempt: 0,
    providerAttempt: 2, qaAttempt: 1, retryCount: 1, providerRetryIdempotencyKey: 'retry_' + id,
    retrySubmissionState: state, retryReservedAt: now - ageMs,
    retryProviderAuthorizedAt: state === 'authorized' ? now - ageMs : null,
    retryProviderAuthorizedIdempotencyKey: state === 'authorized' ? 'retry_' + id : null,
    automaticRetryPlan: { action: 'REGENERATE_VIDEO' }, artifactPersisted: false,
    providerStorageTaskKey: id + '/attempts/2', expectedProviderStorageUri: 'gs://test-bucket/veo/' + id + '/attempts/2/',
    createdAt: now - 300000, updatedAt: now - ageMs,
  } as ServerVideoTaskRecord;
}

describe('M2-4 automatic retry Provider authorization boundary', () => {
  beforeEach(() => { setFirestoreInstanceForTesting(new MockFirestore() as any); firestoreTaskRepository.resetDiagnostics(); });
  afterEach(() => setFirestoreInstanceForTesting(null));

  it('moves only an authorized retry to submission_outcome_unknown', async () => {
    const task = retryTask('retry_unknown', 'authorized');
    await firestoreTaskRepository.createTask(task);
    const unknown = await taskStateMachineService.markAutomaticRetryOutcomeUnknown({
      taskId: task.taskId, idempotencyKey: task.providerRetryIdempotencyKey!, message: 'provider submission result could not be proven',
    });
    expect(unknown.status).toBe('submission_outcome_unknown');
    expect(unknown.retrySubmissionState).toBe('outcome_unknown');
    expect(unknown.structuredError?.code).toBe('AUTOMATIC_RETRY_SUBMISSION_OUTCOME_UNKNOWN');
    expect(unknown.structuredError?.retryable).toBe(false);
  });

  it('refuses to manufacture unknown from a reservation with no Provider authorization evidence', async () => {
    const task = retryTask('retry_reserved', 'reserved');
    await firestoreTaskRepository.createTask(task);
    await expect(taskStateMachineService.markAutomaticRetryOutcomeUnknown({
      taskId: task.taskId, idempotencyKey: task.providerRetryIdempotencyKey!, message: 'too early',
    })).rejects.toThrow('M2_4_RETRY_OUTCOME_UNKNOWN_BEFORE_AUTHORIZATION');
    const stored = await firestoreTaskRepository.getTask(task.taskId);
    expect(stored?.status).toBe('generating');
    expect(stored?.retrySubmissionState).toBe('reserved');
  });

  it('safely reclaims a stale reserved retry that provably never crossed authorization', async () => {
    const task = retryTask('retry_stale_reserved', 'reserved');
    await firestoreTaskRepository.createTask(task);
    const result = await taskStateMachineService.reconcileStaleAutomaticRetryReservation({ taskId: task.taskId });
    expect(result.reclaimed).toBe(true);
    expect(result.task.status).toBe('failed');
    expect(result.task.failureReason).toBe('pre_provider_retry_abandoned');
    expect(result.task.retryMode).toBe('SAFE_TO_REGENERATE');
  });

  it('never safely reclaims a reservation if durable retry authorization evidence exists', async () => {
    const task = retryTask('retry_inconsistent', 'reserved');
    task.retryProviderAuthorizedAt = Date.now() - 200000;
    task.retryProviderAuthorizedIdempotencyKey = task.providerRetryIdempotencyKey;
    await firestoreTaskRepository.createTask(task);
    const result = await taskStateMachineService.reconcileStaleAutomaticRetryReservation({ taskId: task.taskId });
    expect(result.reclaimed).toBe(false);
    expect(result.task.status).toBe('generating');
  });
});
