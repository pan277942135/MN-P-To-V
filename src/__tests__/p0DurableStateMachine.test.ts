import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ServerVideoTaskRecord, TaskStatus } from '../types';
import {
  taskStateMachineService,
  canTransition,
  InvalidStateTransitionError,
  StateVersionMismatchError,
  LateWorkerError,
  buildStructuredError,
} from '../server/services/taskStateMachineService';
import { firestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';
import { setFirestoreInstanceForTesting } from '../server/db/firestore';
import { gcsArtifactStore } from '../server/storage/gcsArtifactStore';

// Mock in-memory Firestore instance for unit tests
class MockFirestoreDoc {
  constructor(private store: Map<string, any>, private id: string) {}

  async get() {
    const data = this.store.get(this.id);
    return {
      exists: Boolean(data),
      data: () => data ? JSON.parse(JSON.stringify(data)) : undefined,
    };
  }

  async set(data: any) {
    this.store.set(this.id, JSON.parse(JSON.stringify(data)));
  }

  async update(patch: any) {
    const existing = this.store.get(this.id) || {};
    const updated = { ...existing, ...patch };
    this.store.set(this.id, JSON.parse(JSON.stringify(updated)));
  }
}

class MockFirestoreCollection {
  constructor(private store: Map<string, any>) {}

  doc(id: string) {
    return new MockFirestoreDoc(this.store, id);
  }

  orderBy() {
    return this;
  }

  limit() {
    return this;
  }

  async get() {
    const docs = Array.from(this.store.entries()).map(([id, data]) => ({
      id,
      data: () => JSON.parse(JSON.stringify(data)),
    }));
    return {
      forEach: (cb: (doc: any) => void) => docs.forEach(cb),
      docs,
    };
  }
}

class MockFirestore {
  public store = new Map<string, any>();

  collection(name: string) {
    return new MockFirestoreCollection(this.store);
  }

  async runTransaction<T>(updateFn: (transaction: any) => Promise<T>): Promise<T> {
    const transaction = {
      get: async (docRef: MockFirestoreDoc) => docRef.get(),
      set: async (docRef: MockFirestoreDoc, data: any) => docRef.set(data),
      update: async (docRef: MockFirestoreDoc, patch: any) => docRef.update(patch),
    };
    return await updateFn(transaction);
  }
}

describe('P0-3 + P0-4 Durable State Machine & Idempotency / Crash Recovery Suite', () => {
  let mockDb: MockFirestore;

  beforeEach(() => {
    mockDb = new MockFirestore();
    setFirestoreInstanceForTesting(mockDb as any);
    firestoreTaskRepository.resetDiagnostics();
    gcsArtifactStore.resetMockStore();
    gcsArtifactStore.setMockMode(true);
  });

  afterEach(() => {
    setFirestoreInstanceForTesting(null);
  });

  it('S1: Legal State Machine Transitions Lifecycle', async () => {
    const taskId = 'task_s1';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'created',
      stateVersion: 1,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await firestoreTaskRepository.createTask(task);

    // created -> preparing
    let updated = await taskStateMachineService.transitionTask({ taskId, toStatus: 'preparing' });
    expect(updated.status).toBe('preparing');
    expect(updated.stateVersion).toBe(2);

    // preparing -> generating
    updated = await taskStateMachineService.transitionTask({ taskId, toStatus: 'generating' });
    expect(updated.status).toBe('generating');

    // generating -> generation_succeeded
    updated = await taskStateMachineService.transitionTask({ taskId, toStatus: 'generation_succeeded' });
    expect(updated.status).toBe('generation_succeeded');

    // generation_succeeded -> artifact_persisting
    updated = await taskStateMachineService.transitionTask({ taskId, toStatus: 'artifact_persisting' });
    expect(updated.status).toBe('artifact_persisting');

    // artifact_persisting -> artifact_persisted only after authoritative artifact persistence
    const lifecycleArtifact = await gcsArtifactStore.uploadVideoArtifact({
      taskId,
      videoBuffer: Buffer.concat([
        Buffer.from('000000206674797069736f6d0000020069736f6d69736f3261766331', 'hex'),
        Buffer.alloc(2000, 1),
      ]),
    });
    updated = await taskStateMachineService.transitionTask({
      taskId,
      toStatus: 'artifact_persisted',
      patch: {
        artifactPersisted: true,
        outputBucket: lifecycleArtifact.outputBucket,
        outputObjectPath: lifecycleArtifact.outputObjectPath,
        videoUri: lifecycleArtifact.videoUri,
        sizeBytes: lifecycleArtifact.sizeBytes,
        artifactPersistedAt: lifecycleArtifact.artifactPersistedAt,
      },
    });
    expect(updated.status).toBe('artifact_persisted');

    // artifact_persisted -> qa_pending
    updated = await taskStateMachineService.transitionTask({ taskId, toStatus: 'qa_pending' });
    expect(updated.status).toBe('qa_pending');

    // qa_pending -> completed
    updated = await taskStateMachineService.transitionTask({ taskId, toStatus: 'completed' });
    expect(updated.status).toBe('completed');
    expect(updated.completedAt).toBeDefined();
  });

  it('S2: Illegal State Machine Transition Guard', async () => {
    const taskId = 'task_s2';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'created',
      stateVersion: 1,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await firestoreTaskRepository.createTask(task);

    // created -> completed (ILLEGAL)
    await expect(
      taskStateMachineService.transitionTask({ taskId, toStatus: 'completed' })
    ).rejects.toThrow(InvalidStateTransitionError);

    // Check status remains created
    const record = await firestoreTaskRepository.getTask(taskId);
    expect(record?.status).toBe('created');
  });

  it('S3: Duplicate Task Start Idempotency', async () => {
    const taskId = 'task_s3';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'preparing',
      stateVersion: 1,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await firestoreTaskRepository.createTask(task);

    // First acquire lease
    const lease1 = await taskStateMachineService.acquireLease({
      taskId,
      leaseOwner: 'worker_1',
      leaseDurationMs: 60000,
    });
    expect(lease1.acquired).toBe(true);

    // Duplicate attempt by second worker while active
    const lease2 = await taskStateMachineService.acquireLease({
      taskId,
      leaseOwner: 'worker_2',
      leaseDurationMs: 60000,
    });
    expect(lease2.acquired).toBe(false);
    expect(lease2.reason).toBe('already_running');
  });

  it('S4: Concurrent Worker Lease Acquisition', async () => {
    const taskId = 'task_s4';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'created',
      stateVersion: 1,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await firestoreTaskRepository.createTask(task);

    const res1 = await taskStateMachineService.acquireLease({ taskId, leaseOwner: 'worker_A' });
    const res2 = await taskStateMachineService.acquireLease({ taskId, leaseOwner: 'worker_B' });

    expect(res1.acquired).toBe(true);
    expect(res2.acquired).toBe(false);
    expect(res2.reason).toBe('already_running');
  });

  it('S5: Lease Expiration & Takeover', async () => {
    const taskId = 'task_s5';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'preparing',
      stateVersion: 1,
      executionId: 'exec_old',
      leaseOwner: 'worker_1',
      leaseExpiresAt: Date.now() - 5000, // Expired 5 seconds ago!
      attempt: 1,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 5000,
    };

    await firestoreTaskRepository.createTask(task);

    // Worker 2 takes over expired lease
    const leaseRes = await taskStateMachineService.acquireLease({
      taskId,
      leaseOwner: 'worker_2',
      leaseDurationMs: 60000,
    });

    expect(leaseRes.acquired).toBe(true);
    expect(leaseRes.executionId).not.toBe('exec_old');
    expect(leaseRes.task?.leaseOwner).toBe('worker_2');
    expect(leaseRes.task?.attempt).toBe(2);
  });

  it('S6: Late Worker Write Defense', async () => {
    const taskId = 'task_s6';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'preparing',
      stateVersion: 1,
      executionId: 'exec_2', // Worker 2 currently holds lease
      leaseOwner: 'worker_2',
      leaseExpiresAt: Date.now() + 60000,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await firestoreTaskRepository.createTask(task);

    // Stale Worker 1 (with exec_1) attempts to write transition
    await expect(
      taskStateMachineService.transitionTask({
        taskId,
        toStatus: 'generating',
        executionId: 'exec_1', // Mismatched execution ID!
      })
    ).rejects.toThrow(LateWorkerError);
  });

  it('S7: State Version Conflict (CAS / Optimistic Lock)', async () => {
    const taskId = 'task_s7';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'preparing',
      stateVersion: 5, // Current version is 5
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await firestoreTaskRepository.createTask(task);

    // Attempt update expecting version 4 (stale version!)
    await expect(
      taskStateMachineService.transitionTask({
        taskId,
        toStatus: 'generating',
        expectedStateVersion: 4,
      })
    ).rejects.toThrow(StateVersionMismatchError);
  });

  it('S8: Completed Task Idempotent Start', async () => {
    const taskId = 'task_s8';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'completed',
      stateVersion: 10,
      artifactPersisted: true,
      outputBucket: 'ai-studio-bucket-89614354864-asia-south1',
      outputObjectPath: 'veo/task_s8/video.mp4',
      videoUri: 'gs://ai-studio-bucket-89614354864-asia-south1/veo/task_s8/video.mp4',
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await firestoreTaskRepository.createTask(task);

    const leaseRes = await taskStateMachineService.acquireLease({
      taskId,
      leaseOwner: 'worker_retry',
    });

    expect(leaseRes.acquired).toBe(false);
    expect(leaseRes.reason).toBe('terminal_state');
    expect(leaseRes.task?.status).toBe('completed');
  });

  it('S9: Crash Recovery in artifact_persisting (GCS Object Exists)', async () => {
    const taskId = 'task_s9';
    const bucket = 'ai-studio-bucket-89614354864-asia-south1';
    const objectPath = 'veo/task_s9/video.mp4';

    const validHeader = Buffer.from('000000206674797069736f6d0000020069736f6d69736f3261766331', 'hex');
    const sampleMp4Buffer = Buffer.concat([validHeader, Buffer.alloc(2000, 1)]);

    // Seed mock GCS artifact as already uploaded
    await gcsArtifactStore.uploadVideoArtifact({
      taskId,
      videoBuffer: sampleMp4Buffer,
    });

    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'artifact_persisting',
      stateVersion: 4,
      leaseExpiresAt: Date.now() - 1000, // Expired lease
      outputBucket: bucket,
      outputObjectPath: objectPath,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now() - 60000,
      updatedAt: Date.now() - 30000,
    };

    await firestoreTaskRepository.createTask(task);

    // Run recovery scan
    const recoveryRes = await taskStateMachineService.recoverAbandonedTasks();
    expect(recoveryRes.recoveredCount).toBe(1);

    const recovered = await firestoreTaskRepository.getTask(taskId);
    expect(recovered?.status).toBe('qa_pending');
    expect(recovered?.artifactPersisted).toBe(true);
  });

  it('S10: Crash Recovery in generation_succeeded', async () => {
    const taskId = 'task_s10';
    const bucket = 'ai-studio-bucket-89614354864-asia-south1';
    const objectPath = 'veo/task_s10/video.mp4';

    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'generation_succeeded',
      stateVersion: 3,
      leaseExpiresAt: Date.now() - 1000,
      outputBucket: bucket,
      outputObjectPath: objectPath,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now() - 60000,
      updatedAt: Date.now() - 30000,
    };

    const generationSucceededArtifact = await gcsArtifactStore.uploadVideoArtifact({
      taskId,
      videoBuffer: Buffer.concat([
        Buffer.from('000000206674797069736f6d0000020069736f6d69736f3261766331', 'hex'),
        Buffer.alloc(2000, 2),
      ]),
    });
    expect(generationSucceededArtifact.outputBucket).toBe(bucket);
    expect(generationSucceededArtifact.outputObjectPath).toBe(objectPath);

    await firestoreTaskRepository.createTask(task);

    const recoveryRes = await taskStateMachineService.recoverAbandonedTasks();
    expect(recoveryRes.recoveredCount).toBe(1);

    const recovered = await firestoreTaskRepository.getTask(taskId);
    expect(recovered?.status).toBe('qa_pending');
  });

  it('S11: Max Execution Attempts Guard', async () => {
    const taskId = 'task_s11';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'preparing',
      stateVersion: 1,
      attempt: 3,
      maxAttempts: 3, // Already used 3 attempts!
      leaseExpiresAt: Date.now() - 1000,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now() - 60000,
      updatedAt: Date.now() - 10000,
    };

    await firestoreTaskRepository.createTask(task);

    const leaseRes = await taskStateMachineService.acquireLease({
      taskId,
      leaseOwner: 'worker_retry',
    });

    expect(leaseRes.acquired).toBe(false);
    expect(leaseRes.reason).toBe('max_attempts_exceeded');

    const updated = await firestoreTaskRepository.getTask(taskId);
    expect(updated?.status).toBe('failed');
    expect(updated?.structuredError?.code).toBe('MAX_ATTEMPTS_EXCEEDED');
  });

  it('S12: Structured Error Formatting & Classification', () => {
    const err = buildStructuredError({
      code: 'GCS_PERSIST_FAILED',
      message: 'Cloud Storage upload timeout',
      stage: 'artifact_persist',
      retryable: true,
      executionId: 'exec_123',
      attempt: 2,
      httpStatus: 503,
    });

    expect(err.code).toBe('GCS_PERSIST_FAILED');
    expect(err.message).toBe('Cloud Storage upload timeout');
    expect(err.stage).toBe('artifact_persist');
    expect(err.retryable).toBe(true);
    expect(err.executionId).toBe('exec_123');
    expect(err.attempt).toBe(2);
    expect(err.httpStatus).toBe(503);
    expect(err.timestamp).toBeGreaterThan(0);
  });

  it('S13: Heartbeat Renewal', async () => {
    const taskId = 'task_s13';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'generating',
      stateVersion: 1,
      executionId: 'exec_13',
      leaseOwner: 'worker_13',
      leaseExpiresAt: Date.now() + 5000,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await firestoreTaskRepository.createTask(task);

    const renewed = await taskStateMachineService.renewLease(taskId, 'exec_13', 120000);
    expect(renewed).toBe(true);

    const updated = await firestoreTaskRepository.getTask(taskId);
    expect(updated?.leaseExpiresAt).toBeGreaterThan(Date.now() + 100000);
  });

  it('S14: Lease Release on Task Completion', async () => {
    const taskId = 'task_s14';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'generating',
      stateVersion: 1,
      executionId: 'exec_14',
      leaseOwner: 'worker_14',
      leaseExpiresAt: Date.now() + 60000,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await firestoreTaskRepository.createTask(task);

    const released = await taskStateMachineService.releaseLease(taskId, 'exec_14');
    expect(released).toBe(true);

    const updated = await firestoreTaskRepository.getTask(taskId);
    expect(updated?.leaseExpiresAt).toBe(0);
  });

  it('S15: Storage Authority Regression Gate Compatibility', async () => {
    const taskId = 'task_s15';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'created',
      stateVersion: 1,
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await firestoreTaskRepository.createTask(task);

    // Verify task is retrieved from Firestore with evidenceSource = 'firestore'
    const fetched = await firestoreTaskRepository.getTask(taskId);
    expect(fetched?.evidenceSource).toBe('firestore');
    expect(fetched?.taskId).toBe(taskId);
  });

  it('S16: Multi-Worker Concurrent Recovery Safety', async () => {
    const taskId = 'task_s16';
    const task: ServerVideoTaskRecord = {
      id: taskId,
      taskId,
      status: 'preparing',
      stateVersion: 1,
      leaseExpiresAt: Date.now() - 1000, // Expired
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'test-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 5000,
    };

    await firestoreTaskRepository.createTask(task);

    // Concurrent recovery scans
    const [res1, res2] = await Promise.all([
      taskStateMachineService.recoverAbandonedTasks(),
      taskStateMachineService.recoverAbandonedTasks(),
    ]);

    expect(res1.evaluatedCount).toBeGreaterThan(0);
    expect(res2.evaluatedCount).toBeGreaterThan(0);
  });
});
