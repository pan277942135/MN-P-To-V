import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerVideoTaskRecord } from '../types';
import { firestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';
import { setFirestoreInstanceForTesting } from '../server/db/firestore';
import { taskStateMachineService } from '../server/services/taskStateMachineService';

class Doc {
  constructor(private store: Map<string, any>, private id: string) {}
  async get() {
    const data = this.store.get(this.id);
    return { exists: Boolean(data), data: () => data ? structuredClone(data) : undefined };
  }
  async set(data: any) { this.store.set(this.id, structuredClone(data)); }
  async update(patch: any) {
    this.store.set(this.id, { ...(this.store.get(this.id) || {}), ...structuredClone(patch) });
  }
}
class Collection {
  constructor(private store: Map<string, any>) {}
  doc(id: string) { return new Doc(this.store, id); }
  orderBy() { return this; }
  limit() { return this; }
  async get() {
    const docs = [...this.store.entries()].map(([id, data]) => ({ id, data: () => structuredClone(data) }));
    return { docs, forEach: (cb: (doc: any) => void) => docs.forEach(cb) };
  }
}
class MockFirestore {
  store = new Map<string, any>();
  collection() { return new Collection(this.store); }
  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return await fn({
      get: (ref: Doc) => ref.get(),
      set: (ref: Doc, data: any) => ref.set(data),
      update: (ref: Doc, patch: any) => ref.update(patch),
    });
  }
}

describe('M2-4 ambiguous automatic retry submission', () => {
  beforeEach(() => {
    setFirestoreInstanceForTesting(new MockFirestore() as any);
    firestoreTaskRepository.resetDiagnostics();
  });
  afterEach(() => setFirestoreInstanceForTesting(null));

  it('moves a reserved retry to submission_outcome_unknown instead of allowing blind resubmission', async () => {
    const now = Date.now();
    const task: ServerVideoTaskRecord = {
      id: 'retry_unknown',
      taskId: 'retry_unknown',
      status: 'generating',
      stateVersion: 5,
      statusVersion: 5,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '1080p',
      generateAudio: false,
      pollAttempt: 0,
      providerAttempt: 2,
      qaAttempt: 1,
      retryCount: 1,
      providerRetryIdempotencyKey: 'retry_123',
      retrySubmissionState: 'reserved',
      retryReservedAt: now - 200000,
      automaticRetryPlan: { action: 'REGENERATE_VIDEO' },
      artifactPersisted: false,
      createdAt: now - 300000,
      updatedAt: now - 200000,
    };
    await firestoreTaskRepository.createTask(task);

    const unknown = await taskStateMachineService.markAutomaticRetryOutcomeUnknown({
      taskId: task.taskId,
      idempotencyKey: 'retry_123',
      message: 'provider submission result could not be proven',
    });

    expect(unknown.status).toBe('submission_outcome_unknown');
    expect(unknown.retrySubmissionState).toBe('outcome_unknown');
    expect(unknown.providerAttempt).toBe(2);
    expect(unknown.operationName).toBeFalsy();
    expect(unknown.structuredError?.code).toBe('AUTOMATIC_RETRY_SUBMISSION_OUTCOME_UNKNOWN');
    expect(unknown.structuredError?.retryable).toBe(false);
  });
});
