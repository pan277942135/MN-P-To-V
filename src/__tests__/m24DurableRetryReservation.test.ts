import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerVideoTaskRecord } from '../types';
import { firestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';
import { setFirestoreInstanceForTesting } from '../server/db/firestore';
import { taskStateMachineService } from '../server/services/taskStateMachineService';
import { VideoRetryPolicyService } from '../services/qa/videoRetryPolicyService';
import { DurableVideoRetryService } from '../server/services/durableVideoRetryService';

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

function qaPendingTask(taskId: string): ServerVideoTaskRecord {
  const now = Date.now();
  return {
    id: taskId,
    taskId,
    status: 'qa_pending',
    stateVersion: 4,
    statusVersion: 4,
    modelId: 'veo-3.1-fast-generate-001',
    projectId: 'test-project',
    region: 'us-central1',
    durationSeconds: 4,
    aspectRatio: '9:16',
    resolution: '1080p',
    generateAudio: false,
    pollAttempt: 2,
    providerAttempt: 1,
    qaAttempt: 1,
    retryCount: 0,
    retrySubmissionState: 'none',
    artifactPersisted: true,
    outputBucket: 'test-bucket',
    outputObjectPath: `veo/${taskId}/video.mp4`,
    videoUri: `gs://test-bucket/veo/${taskId}/video.mp4`,
    sizeBytes: 123456,
    artifactPersistedAt: now - 1000,
    identityQaStatus: 'fail',
    qaReport: { pass: false, gateStatus: 'fail' },
    identityQaReport: { pass: false, gateStatus: 'fail' },
    createdAt: now - 5000,
    updatedAt: now,
  };
}

const qaReport: any = {
  pass: false,
  gateStatus: 'fail',
  averageIdentityScore: 91,
  minimumIdentityScore: 84,
  temporalConsistencyScore: 92,
  motionNaturalnessScore: 92,
  anatomyScore: 92,
  sceneContinuityScore: 95,
  promptComplianceScore: 95,
  frameReports: [],
  criticalIssues: [],
  repairInstruction: '',
  summary: 'identity drift',
  identityDriftDetected: true,
  worstFrameTimestamp: 2,
  identityDriftSegments: [],
};
const diagnosis: any = {
  version: 'm2-3-v1',
  primaryCode: 'IDENTITY_DRIFT',
  secondaryCodes: [],
  severity: 'major',
  retryRecommended: true,
  repairStrategy: 'LOCK_IDENTITY_REDUCE_MOTION',
  repairPromptAppend: 'Lock identity and reduce motion.',
  affectedRanges: [],
  worstFrameTimestamp: 2,
  evidence: [],
  summary: 'identity drift',
};

describe('M2-4 durable provider retry reservation', () => {
  beforeEach(() => {
    setFirestoreInstanceForTesting(new MockFirestore() as any);
    firestoreTaskRepository.resetDiagnostics();
  });
  afterEach(() => setFirestoreInstanceForTesting(null));

  it('atomically reserves provider attempt 2 and archives attempt 1 artifact evidence', async () => {
    const task = qaPendingTask('retry_reserve');
    await firestoreTaskRepository.createTask(task);
    const decision = VideoRetryPolicyService.decide({
      taskId: task.taskId,
      qaReport,
      diagnosis,
      providerAttempt: 1,
      qaAttempt: 1,
      artifactObjectPath: task.outputObjectPath,
    });

    const reserved = await taskStateMachineService.reserveAutomaticProviderRetry({
      taskId: task.taskId,
      decision,
      diagnosisCode: diagnosis.primaryCode,
    });

    expect(reserved.reserved).toBe(true);
    expect(reserved.task.status).toBe('generating');
    expect(reserved.task.providerAttempt).toBe(2);
    expect(reserved.task.retryCount).toBe(1);
    expect(reserved.task.retrySubmissionState).toBe('reserved');
    expect(reserved.task.artifactPersisted).toBe(false);
    expect(reserved.task.artifactHistory).toHaveLength(1);
    expect(reserved.task.artifactHistory?.[0].outputObjectPath).toBe(`veo/${task.taskId}/video.mp4`);
    expect(reserved.task.retryHistory?.[0].idempotencyKey).toBe(decision.idempotencyKey);
  });

  it('returns the same reservation without incrementing provider attempt on duplicate idempotency key', async () => {
    const task = qaPendingTask('retry_duplicate');
    await firestoreTaskRepository.createTask(task);
    const decision = VideoRetryPolicyService.decide({
      taskId: task.taskId,
      qaReport,
      diagnosis,
      providerAttempt: 1,
      qaAttempt: 1,
      artifactObjectPath: task.outputObjectPath,
    });

    const first = await taskStateMachineService.reserveAutomaticProviderRetry({
      taskId: task.taskId,
      decision,
      diagnosisCode: diagnosis.primaryCode,
    });
    const second = await taskStateMachineService.reserveAutomaticProviderRetry({
      taskId: task.taskId,
      decision,
      diagnosisCode: diagnosis.primaryCode,
    });

    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(false);
    expect(second.task.providerAttempt).toBe(2);
    expect(second.task.retryHistory).toHaveLength(1);
  });

  it('marks the reserved retry as submitted only when idempotency key still owns the task', async () => {
    const task = qaPendingTask('retry_submit');
    await firestoreTaskRepository.createTask(task);
    const decision = VideoRetryPolicyService.decide({
      taskId: task.taskId,
      qaReport,
      diagnosis,
      providerAttempt: 1,
      qaAttempt: 1,
      artifactObjectPath: task.outputObjectPath,
    });
    await taskStateMachineService.reserveAutomaticProviderRetry({
      taskId: task.taskId,
      decision,
      diagnosisCode: diagnosis.primaryCode,
    });

    const submitted = await taskStateMachineService.markAutomaticRetrySubmitted({
      taskId: task.taskId,
      idempotencyKey: decision.idempotencyKey!,
      operationName: 'projects/test/locations/us-central1/operations/retry-op',
    });

    expect(submitted.status).toBe('polling');
    expect(submitted.retrySubmissionState).toBe('submitted');
    expect(submitted.operationName).toContain('retry-op');
    expect(submitted.retryHistory?.[0].state).toBe('submitted');
  });

  it('uses attempt-specific artifact keys so retry artifacts cannot overwrite attempt 1', () => {
    expect(DurableVideoRetryService.getAttemptTaskKey('task_a', 1)).toBe('task_a');
    expect(DurableVideoRetryService.getAttemptTaskKey('task_a', 2)).toBe('task_a/attempts/2');
    expect(DurableVideoRetryService.getAttemptTaskKey('task_a', 3)).toBe('task_a/attempts/3');
  });
});
