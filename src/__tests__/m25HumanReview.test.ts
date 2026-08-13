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

function reviewTask(taskId: string, qaStatus: 'review' | 'fail' = 'review'): ServerVideoTaskRecord {
  const now = Date.now();
  return {
    id: taskId,
    taskId,
    status: 'qa_pending',
    stateVersion: 8,
    statusVersion: 8,
    modelId: 'veo-3.1-fast-generate-001',
    projectId: 'test-project',
    region: 'us-central1',
    durationSeconds: 4,
    aspectRatio: '9:16',
    resolution: '1080p',
    generateAudio: false,
    pollAttempt: 3,
    providerAttempt: 1,
    qaAttempt: 1,
    artifactPersisted: true,
    outputBucket: 'test-bucket',
    outputObjectPath: `veo/${taskId}/video.mp4`,
    videoUri: `gs://test-bucket/veo/${taskId}/video.mp4`,
    videoDataUrl: `/api/videos/stream/${taskId}`,
    identityQaStatus: qaStatus,
    qaReport: {
      pass: false,
      gateStatus: qaStatus,
      averageIdentityScore: qaStatus === 'review' ? 93 : 72,
      minimumIdentityScore: qaStatus === 'review' ? 88 : 65,
      temporalConsistencyScore: 91,
      motionNaturalnessScore: 90,
      anatomyScore: 90,
      sceneContinuityScore: 94,
      promptComplianceScore: 95,
      frameReports: [],
      criticalIssues: [],
      repairInstruction: '',
      summary: qaStatus === 'review' ? 'borderline identity review' : 'hard identity failure',
      identityDriftDetected: true,
      worstFrameTimestamp: 2,
      identityDriftSegments: [],
    },
    createdAt: now - 5000,
    updatedAt: now,
  };
}

describe('M2-5 durable human review', () => {
  beforeEach(() => {
    setFirestoreInstanceForTesting(new MockFirestore() as any);
    firestoreTaskRepository.resetDiagnostics();
  });
  afterEach(() => setFirestoreInstanceForTesting(null));

  it('accepts only a persisted QA REVIEW and records durable reviewer evidence', async () => {
    const task = reviewTask('review_accept');
    await firestoreTaskRepository.createTask(task);

    const result = await taskStateMachineService.resolveHumanReview({
      taskId: task.taskId,
      decision: 'accepted',
      reviewerId: 'studio-user',
      note: '视觉复核通过，可接受轻微边界漂移',
    });

    expect(result.status).toBe('completed');
    expect(result.artifactPersisted).toBe(true);
    expect(result.identityQaStatus).toBe('review');
    expect(result.humanReviewDecision).toBe('accepted');
    expect(result.humanReviewRecord?.decision).toBe('accepted');
    expect(result.humanReviewRecord?.sourceQaStatus).toBe('review');
    expect(result.humanReviewRecord?.reviewerId).toBe('studio-user');
    expect(result.completedAt).toBeDefined();
  });

  it('rejects a QA REVIEW into failed while preserving artifact authority', async () => {
    const task = reviewTask('review_reject');
    await firestoreTaskRepository.createTask(task);

    const result = await taskStateMachineService.resolveHumanReview({
      taskId: task.taskId,
      decision: 'rejected',
      reviewerId: 'studio-user',
      note: '人物后段仍明显漂移',
    });

    expect(result.status).toBe('failed');
    expect(result.artifactPersisted).toBe(true);
    expect(result.outputObjectPath).toBe(task.outputObjectPath);
    expect(result.humanReviewDecision).toBe('rejected');
    expect(result.humanReviewRecord?.decision).toBe('rejected');
    expect(result.retryMode).toBe('NO_RETRY');
    expect(result.error).toContain('人工审核拒绝');
  });

  it('does not allow human acceptance to override a hard QA FAIL', async () => {
    const task = reviewTask('review_hard_fail', 'fail');
    await firestoreTaskRepository.createTask(task);

    await expect(taskStateMachineService.resolveHumanReview({
      taskId: task.taskId,
      decision: 'accepted',
      reviewerId: 'studio-user',
    })).rejects.toThrow('HUMAN_REVIEW_NOT_ELIGIBLE');
  });

  it('is idempotent for the same decision and rejects a conflicting second decision', async () => {
    const task = reviewTask('review_idempotent');
    await firestoreTaskRepository.createTask(task);

    const first = await taskStateMachineService.resolveHumanReview({
      taskId: task.taskId,
      decision: 'accepted',
      reviewerId: 'studio-user',
    });
    const same = await taskStateMachineService.resolveHumanReview({
      taskId: task.taskId,
      decision: 'accepted',
      reviewerId: 'studio-user',
    });

    expect(same.humanReviewRecord?.reviewedAt).toBe(first.humanReviewRecord?.reviewedAt);

    await expect(taskStateMachineService.resolveHumanReview({
      taskId: task.taskId,
      decision: 'rejected',
      reviewerId: 'studio-user',
    })).rejects.toThrow('HUMAN_REVIEW_DECISION_CONFLICT');
  });
});
