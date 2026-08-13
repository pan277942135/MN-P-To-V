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

const passReport = {
  pass: true,
  gateStatus: 'pass',
  averageIdentityScore: 98,
  minimumIdentityScore: 96,
  temporalConsistencyScore: 97,
  motionNaturalnessScore: 96,
  anatomyScore: 97,
  sceneContinuityScore: 96,
  promptComplianceScore: 96,
  frameReports: [],
  criticalIssues: [],
  repairInstruction: '',
  summary: 'certified identity pass',
  identityDriftDetected: false,
  worstFrameTimestamp: null,
  identityDriftSegments: [],
};

function qaPendingTask(taskId: string): ServerVideoTaskRecord {
  const now = Date.now();
  return {
    id: taskId,
    taskId,
    status: 'qa_pending',
    stateVersion: 1,
    statusVersion: 1,
    modelId: 'veo-3.1-fast-generate-001',
    projectId: 'test-project',
    region: 'us-central1',
    durationSeconds: 4,
    aspectRatio: '9:16',
    resolution: '720p',
    generateAudio: false,
    pollAttempt: 0,
    artifactPersisted: true,
    outputBucket: 'test-bucket',
    outputObjectPath: `veo/${taskId}/result.mp4`,
    videoUri: `gs://test-bucket/veo/${taskId}/result.mp4`,
    createdAt: now,
    updatedAt: now,
  };
}

describe('M2-2 completed state invariant', () => {
  beforeEach(() => {
    setFirestoreInstanceForTesting(new MockFirestore() as any);
    firestoreTaskRepository.resetDiagnostics();
  });

  afterEach(() => setFirestoreInstanceForTesting(null));

  it('rejects generic qa_pending -> completed when video QA has not passed', async () => {
    const task = qaPendingTask('m22_no_qa');
    await firestoreTaskRepository.createTask(task);

    await expect(
      taskStateMachineService.transitionTask({ taskId: task.taskId, toStatus: 'completed' })
    ).rejects.toThrow('VIDEO_QA_COMPLETION_INVARIANT');
  });

  it('rejects REVIEW as completed even when artifact authority is valid', async () => {
    const task = {
      ...qaPendingTask('m22_review'),
      identityQaStatus: 'review' as const,
      qaReport: { ...passReport, pass: false, gateStatus: 'review' },
    };
    await firestoreTaskRepository.createTask(task);

    await expect(
      taskStateMachineService.transitionTask({ taskId: task.taskId, toStatus: 'completed' })
    ).rejects.toThrow('VIDEO_QA_COMPLETION_INVARIANT');
  });

  it('allows completed only through explicit PASS QA evidence', async () => {
    const task = qaPendingTask('m22_pass');
    await firestoreTaskRepository.createTask(task);

    const completed = await taskStateMachineService.completeAfterQa({
      taskId: task.taskId,
      qaReport: passReport,
    });

    expect(completed.status).toBe('completed');
    expect(completed.artifactPersisted).toBe(true);
    expect(completed.identityQaStatus).toBe('pass');
    expect(completed.qaReport?.pass).toBe(true);
    expect(completed.qaReport?.gateStatus).toBe('pass');
  });
});
