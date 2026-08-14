import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerVideoTaskRecord } from '../types';
import { FirestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';
import { setFirestoreInstanceForTesting } from '../server/db/firestore';

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

const makeTask = (id: string, projectId: string, status: any): ServerVideoTaskRecord => ({
  id,
  taskId: id,
  status,
  modelId: 'veo-3.1-fast-generate-001',
  projectId,
  region: 'us-central1',
  durationSeconds: 4,
  aspectRatio: '9:16',
  resolution: '720p',
  generateAudio: false,
  pollAttempt: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

describe('FirestoreTaskRepository durable provider admission', () => {
  let db: MockFirestore;
  let instanceA: FirestoreTaskRepository;
  let instanceB: FirestoreTaskRepository;

  beforeEach(() => {
    db = new MockFirestore();
    setFirestoreInstanceForTesting(db as any);
    instanceA = new FirestoreTaskRepository();
    instanceB = new FirestoreTaskRepository();
  });

  it('allows only one different blocking task per project across repository instances', async () => {
    await instanceA.createTask(makeTask('task_a', 'project-a', 'polling'));

    await expect(instanceB.createTask(makeTask('task_b', 'project-a', 'submitting'))).rejects.toMatchObject({
      code: 'PROVIDER_ADMISSION_BUSY',
      blockingTaskId: 'task_a',
      blockingStatus: 'polling',
    });

    expect(await instanceB.getTask('task_b')).toBeNull();
  });

  it('keeps submission_outcome_unknown fail-closed', async () => {
    await instanceA.createTask(makeTask('task_unknown', 'project-a', 'submission_outcome_unknown'));
    await expect(instanceB.createTask(makeTask('task_next', 'project-a', 'submitting'))).rejects.toMatchObject({
      code: 'PROVIDER_ADMISSION_BUSY',
      blockingTaskId: 'task_unknown',
    });
  });

  it('reclaims a stale slot when the incumbent is terminal', async () => {
    await instanceA.createTask(makeTask('task_done', 'project-a', 'submitting'));
    await instanceA.updateTask('task_done', { status: 'failed' });

    await expect(instanceB.createTask(makeTask('task_next', 'project-a', 'submitting'))).resolves.toBeUndefined();
    expect((await instanceB.getTask('task_next'))?.status).toBe('submitting');
  });

  it('allows human REVIEW to coexist with a new provider task', async () => {
    await instanceA.createTask(makeTask('task_review', 'project-a', 'qa_pending'));
    await instanceA.updateTask('task_review', { identityQaStatus: 'review' });

    await expect(instanceB.createTask(makeTask('task_next', 'project-a', 'submitting'))).resolves.toBeUndefined();
  });

  it('isolates admission between intentionally separate Google Cloud projects', async () => {
    await instanceA.createTask(makeTask('task_a', 'project-a', 'polling'));
    await expect(instanceB.createTask(makeTask('task_b', 'project-b', 'submitting'))).resolves.toBeUndefined();
  });
});
