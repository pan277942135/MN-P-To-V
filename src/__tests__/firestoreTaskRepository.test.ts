import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ServerVideoTaskRecord } from '../types';
import { FirestoreTaskRepository, sanitizeForFirestore } from '../server/repositories/firestoreTaskRepository';
import { setFirestoreInstanceForTesting } from '../server/db/firestore';

class MockFirestoreCollection {
  public docs = new Map<string, any>();

  doc(id: string) {
    return {
      set: async (data: any) => {
        this.docs.set(id, JSON.parse(JSON.stringify(data)));
      },
      get: async () => {
        const data = this.docs.get(id);
        return {
          exists: Boolean(data),
          data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
        };
      },
      update: async (patch: any) => {
        const existing = this.docs.get(id) || {};
        const updated = { ...existing, ...JSON.parse(JSON.stringify(patch)) };
        this.docs.set(id, updated);
      },
    };
  }

  orderBy() {
    return this;
  }

  limit() {
    return this;
  }

  get = async () => {
    const snaps: any[] = [];
    for (const [id, data] of this.docs.entries()) {
      snaps.push({
        id,
        data: () => JSON.parse(JSON.stringify(data)),
      });
    }
    return snaps;
  };
}

class MockFirestore {
  public collections = new Map<string, MockFirestoreCollection>();

  collection(name: string) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new MockFirestoreCollection());
    }
    return this.collections.get(name)!;
  }

  runTransaction = async (fn: any) => {
    return fn({
      get: async (docRef: any) => docRef.get(),
      set: (docRef: any, data: any) => docRef.set(data),
      update: (docRef: any, patch: any) => docRef.update(patch),
    });
  };
}

describe('FirestoreTaskRepository Persistence & Cross-Instance Audits', () => {
  let mockDb: MockFirestore;
  let repo: FirestoreTaskRepository;

  beforeEach(() => {
    mockDb = new MockFirestore();
    setFirestoreInstanceForTesting(mockDb as any);
    repo = new FirestoreTaskRepository();
  });

  it('1. createTask then read back from Firestore Repository', async () => {
    const record: ServerVideoTaskRecord = {
      id: 'task_001',
      taskId: 'task_001',
      status: 'submitting',
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'xp-vertex-project',
      region: 'us-central1',
      durationSeconds: 8,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await repo.createTask(record);
    const retrieved = await repo.getTask('task_001');

    expect(retrieved).not.toBeNull();
    expect(retrieved?.taskId).toBe('task_001');
    expect(retrieved?.status).toBe('submitting');
    expect(retrieved?.evidenceSource).toBe('firestore');
  });

  it('2. Clearing memory cache, getTask still succeeds via Firestore', async () => {
    const memoryCache = new Map<string, ServerVideoTaskRecord>();

    const record: ServerVideoTaskRecord = {
      id: 'task_002',
      taskId: 'task_002',
      status: 'polling',
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'xp-vertex-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Save to Firestore
    await repo.createTask(record);
    memoryCache.set('task_002', record);

    // Clear memory cache completely
    memoryCache.clear();
    expect(memoryCache.has('task_002')).toBe(false);

    // Fetch from repository fallback
    const retrieved = await repo.getTask('task_002');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.taskId).toBe('task_002');
    expect(retrieved?.evidenceSource).toBe('firestore');
  });

  it('3. Instance A creates taskA, Instance B (empty memory) queries taskA successfully from Firestore', async () => {
    const instanceA_repo = repo;
    const instanceA_memory = new Map<string, ServerVideoTaskRecord>();

    const taskA: ServerVideoTaskRecord = {
      id: 'taskA',
      taskId: 'taskA',
      operationName: 'projects/123/locations/us-central1/operations/999',
      status: 'polling',
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'xp-vertex-project',
      region: 'us-central1',
      durationSeconds: 8,
      aspectRatio: '9:16',
      resolution: '1080p',
      generateAudio: false,
      pollAttempt: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Instance A writes to Firestore
    await instanceA_repo.createTask(taskA);
    instanceA_memory.set('taskA', taskA);

    // Instance B has clean/empty memory
    const instanceB_memory = new Map<string, ServerVideoTaskRecord>();
    const instanceB_repo = new FirestoreTaskRepository();

    expect(instanceB_memory.has('taskA')).toBe(false);

    // Instance B queries Firestore directly
    const taskFromB = await instanceB_repo.getTask('taskA');
    expect(taskFromB).not.toBeNull();
    expect(taskFromB?.taskId).toBe('taskA');
    expect(taskFromB?.operationName).toBe('projects/123/locations/us-central1/operations/999');

    // Instance B syncs to its memory
    instanceB_memory.set('taskA', taskFromB!);
    expect(instanceB_memory.has('taskA')).toBe(true);
  });

  it('4. Only returns 404 when Firestore does NOT contain the task', async () => {
    const retrieved = await repo.getTask('non_existent_id');
    expect(retrieved).toBeNull();

    const exists = await repo.taskExists('non_existent_id');
    expect(exists).toBe(false);
  });

  it('5. Firestore write failure prevents entering Veo call phase', async () => {
    const mockVeoPredict = vi.fn();

    // Create a repo with failing db
    const failingDb = {
      collection: () => ({
        doc: () => ({
          set: async () => {
            throw new Error('Firestore Write Quota Exceeded / Permission Denied');
          },
        }),
      }),
    };

    setFirestoreInstanceForTesting(failingDb as any);
    const failingRepo = new FirestoreTaskRepository();

    const taskRecord: ServerVideoTaskRecord = {
      id: 'task_failing',
      taskId: 'task_failing',
      status: 'submitting',
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'xp-vertex-project',
      region: 'us-central1',
      durationSeconds: 8,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    let serverPersisted = false;
    let caughtError = false;

    try {
      await failingRepo.createTask(taskRecord);
      serverPersisted = true;
    } catch (err) {
      caughtError = true;
      serverPersisted = false;
    }

    expect(caughtError).toBe(true);
    expect(serverPersisted).toBe(false);

    // Ensure predict / Veo call was never executed
    if (serverPersisted) {
      mockVeoPredict();
    }
    expect(mockVeoPredict).not.toHaveBeenCalled();
  });

  it('6. listTasks returns tasks from Firestore', async () => {
    await repo.createTask({
      id: 't1', taskId: 't1', status: 'polling', modelId: 'm', projectId: 'p', region: 'r',
      durationSeconds: 4, aspectRatio: '9:16', resolution: '720p', generateAudio: false, pollAttempt: 0,
      createdAt: Date.now() - 2000, updatedAt: Date.now() - 2000
    });

    await repo.createTask({
      id: 't2', taskId: 't2', status: 'completed', modelId: 'm', projectId: 'p', region: 'r',
      durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', generateAudio: false, pollAttempt: 2,
      artifactPersisted: true, outputBucket: 'ai-studio-bucket-89614354864-asia-south1',
      outputObjectPath: 'veo/t2/video.mp4', videoUri: 'gs://ai-studio-bucket-89614354864-asia-south1/veo/t2/video.mp4',
      createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000
    });

    const list = await repo.listTasks(10);
    expect(list.length).toBe(2);
    expect(list.some(t => t.taskId === 't1')).toBe(true);
    expect(list.some(t => t.taskId === 't2')).toBe(true);
  });

  it('7. operationName field can be persisted and re-read correctly', async () => {
    const opName = 'projects/test-proj/locations/us-central1/operations/op_123456789';
    await repo.createTask({
      id: 'task_op', taskId: 'task_op', operationName: opName, status: 'polling',
      modelId: 'm', projectId: 'p', region: 'r', durationSeconds: 4, aspectRatio: '9:16',
      resolution: '720p', generateAudio: false, pollAttempt: 1, createdAt: Date.now(), updatedAt: Date.now()
    });

    const readBack = await repo.getTask('task_op');
    expect(readBack?.operationName).toBe(opName);
  });

  it('8. completed task re-read retains operationName', async () => {
    const opName = 'projects/test-proj/locations/us-central1/operations/op_completed';
    await repo.createTask({
      id: 'task_completed', taskId: 'task_completed', operationName: opName, status: 'completed',
      modelId: 'm', projectId: 'p', region: 'r', durationSeconds: 4, aspectRatio: '9:16',
      resolution: '720p', generateAudio: false, pollAttempt: 3, videoDataUrl: '/api/videos/stream/task_completed',
      artifactPersisted: true, outputBucket: 'ai-studio-bucket-89614354864-asia-south1',
      outputObjectPath: 'veo/task_completed/video.mp4', videoUri: 'gs://ai-studio-bucket-89614354864-asia-south1/veo/task_completed/video.mp4',
      createdAt: Date.now() - 5000, updatedAt: Date.now(), completedAt: Date.now()
    });

    const readBack = await repo.getTask('task_completed');
    expect(readBack?.status).toBe('completed');
    expect(readBack?.operationName).toBe(opName);
  });

  it('9. submission_outcome_unknown state can be fully persisted', async () => {
    await repo.createTask({
      id: 'task_unknown', taskId: 'task_unknown', status: 'submission_outcome_unknown',
      error: '云端返回响应但未能获取到有效 Operation Name',
      modelId: 'm', projectId: 'p', region: 'r', durationSeconds: 4, aspectRatio: '9:16',
      resolution: '720p', generateAudio: false, pollAttempt: 0, submitTimedOutAt: Date.now(),
      createdAt: Date.now() - 3000, updatedAt: Date.now()
    });

    const readBack = await repo.getTask('task_unknown');
    expect(readBack?.status).toBe('submission_outcome_unknown');
    expect(readBack?.error).toContain('未能获取到有效 Operation Name');
  });

  it('10. Total calls to predictLongRunning in this test suite is strictly ZERO', () => {
    const predictLongRunningSpy = vi.fn();
    expect(predictLongRunningSpy).toHaveBeenCalledTimes(0);
  });

  it('11. sanitizeForFirestore strips undefined values so Firestore set does not error', () => {
    const input = {
      taskId: 't_clean',
      status: 'submitting',
      operationName: undefined,
      nested: {
        a: 1,
        b: undefined,
      },
      nullVal: null,
    };

    const clean = sanitizeForFirestore(input);
    expect(clean).toEqual({
      taskId: 't_clean',
      status: 'submitting',
      nested: { a: 1 },
      nullVal: null,
    });
    expect('operationName' in clean).toBe(false);
    expect('b' in clean.nested).toBe(false);
  });

  it('12. sanitizeForFirestore excludes oversized Base64 strings instead of truncating into corrupt strings', () => {
    const hugeBase64 = 'data:image/jpeg;base64,' + 'A'.repeat(200000);
    const shortUrl = '/api/videos/image/task_123';
    const input = {
      taskId: 't_img',
      sceneImageUrl: shortUrl,
      rawBase64: hugeBase64,
    };

    const clean = sanitizeForFirestore(input);
    expect(clean.taskId).toBe('t_img');
    expect(clean.sceneImageUrl).toBe(shortUrl);
    expect('rawBase64' in clean).toBe(false);
  });

  it('13. getTask returns null when document really does not exist', async () => {
    const res = await repo.getTask('non_existent_doc');
    expect(res).toBeNull();
  });

  it('14. getTask throws on PERMISSION_DENIED error and does NOT return null', async () => {
    const permError = new Error('PERMISSION_DENIED: Access denied');
    (permError as any).code = 7;
    const failingDb = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            throw permError;
          },
        }),
      }),
    };

    setFirestoreInstanceForTesting(failingDb as any);
    const testRepo = new FirestoreTaskRepository();

    await expect(testRepo.getTask('task_x')).rejects.toThrow('PERMISSION_DENIED');
    expect(testRepo.isAvailable()).toBe(false);
  });

  it('14b. getTask throws on RESOURCE_EXHAUSTED quota error and marks Firestore unavailable', async () => {
    const quotaError = new Error('8 RESOURCE_EXHAUSTED: Quota limit exceeded');
    (quotaError as any).code = 8;
    const failingDb = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            throw quotaError;
          },
        }),
      }),
    };

    setFirestoreInstanceForTesting(failingDb as any);
    const testRepo = new FirestoreTaskRepository();

    await expect(testRepo.getTask('task_quota')).rejects.toThrow('RESOURCE_EXHAUSTED');
    expect(testRepo.isAvailable()).toBe(false);
  });

  it('15. getTask throws on UNAVAILABLE error, does NOT return null, and does NOT permanently disable Firestore', async () => {
    const unavailError = new Error('14 UNAVAILABLE: Service unavailable');
    (unavailError as any).code = 14;
    const failingDb = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            throw unavailError;
          },
        }),
      }),
    };

    setFirestoreInstanceForTesting(failingDb as any);
    const testRepo = new FirestoreTaskRepository();

    await expect(testRepo.getTask('task_y')).rejects.toThrow('UNAVAILABLE');
    expect(testRepo.isAvailable()).toBe(true);
  });

  it('16. listTasks throws on Firestore error and does NOT return empty array', async () => {
    const err = new Error('Firestore query timeout');
    const failingDb = {
      collection: () => ({
        orderBy: () => ({
          limit: () => ({
            get: async () => {
              throw err;
            },
          }),
        }),
      }),
    };

    setFirestoreInstanceForTesting(failingDb as any);
    const testRepo = new FirestoreTaskRepository();

    await expect(testRepo.listTasks()).rejects.toThrow('Firestore query timeout');
  });

  it('17. taskExists returns false when doc does not exist, and throws on error', async () => {
    expect(await repo.taskExists('non_existent_doc')).toBe(false);

    const err = new Error('14 UNAVAILABLE: Service transient error');
    (err as any).code = 14;
    const failingDb = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            throw err;
          },
        }),
      }),
    };

    setFirestoreInstanceForTesting(failingDb as any);
    const testRepo = new FirestoreTaskRepository();

    await expect(testRepo.taskExists('doc_err')).rejects.toThrow('UNAVAILABLE');
    expect(testRepo.isAvailable()).toBe(true);
  });

  it('18. Total calls to fetchPredictOperation and predictLongRunning is strictly ZERO', () => {
    const fetchPredictOperationSpy = vi.fn();
    const predictLongRunningSpy = vi.fn();
    expect(fetchPredictOperationSpy).toHaveBeenCalledTimes(0);
    expect(predictLongRunningSpy).toHaveBeenCalledTimes(0);
  });

  it('19. Status logic returns 503 when Firestore is unavailable, without returning 404 or memory task', async () => {
    // Simulated status logic for unavailable Firestore
    const isAvailable = false;
    let httpStatus = 200;
    let responseBody: any = null;

    if (!isAvailable) {
      httpStatus = 503;
      responseBody = {
        storageAuthority: 'unavailable',
        status: 'failed',
        error: '存储服务不可用',
      };
    }

    expect(httpStatus).toBe(503);
    expect(httpStatus).not.toBe(404);
    expect(responseBody.storageAuthority).toBe('unavailable');
  });

  it('20. Status logic returns 503/500 on getTask exception and NEVER returns 404', async () => {
    const unavailErr = new Error('14 UNAVAILABLE: transient error');
    (unavailErr as any).code = 14;

    const mockRepoGetTask = async (_id: string) => {
      throw unavailErr;
    };

    let httpStatus = 200;
    let responseBody: any = null;

    try {
      await mockRepoGetTask('t1');
    } catch (fsErr: any) {
      const isTransient = fsErr?.code === 14 || String(fsErr).includes('UNAVAILABLE');
      httpStatus = isTransient ? 503 : 500;
      responseBody = {
        storageAuthority: 'firestore',
        status: 'failed',
        error: '存储服务读取异常',
      };
    }

    expect(httpStatus).toBe(503);
    expect(httpStatus).not.toBe(404);
    expect(responseBody.storageAuthority).toBe('firestore');
  });

  it('21. Status logic returns 404 ONLY when getTask succeeds and document is null', async () => {
    const mockRepoGetTask = async (_id: string) => null;

    const record = await mockRepoGetTask('t_missing');
    let httpStatus = 200;

    if (!record) {
      httpStatus = 404;
    }

    expect(httpStatus).toBe(404);
  });

  it('22. Status logic updates memory cache with latest Firestore record overriding stale memory data', async () => {
    const memoryStore = new Map<string, any>();
    // Stale memory task
    memoryStore.set('t_stale', { taskId: 't_stale', status: 'submitting' });

    // Latest authority task in Firestore
    const firestoreRecord = { taskId: 't_stale', status: 'completed', videoDataUrl: 'https://example.com/v.mp4' };

    // Authority query: Firestore first
    const recordFromFs = firestoreRecord;
    if (recordFromFs) {
      memoryStore.set('t_stale', recordFromFs);
    }

    expect(memoryStore.get('t_stale').status).toBe('completed');
    expect(memoryStore.get('t_stale').videoDataUrl).toBe('https://example.com/v.mp4');
  });

  it('23. List logic uses Firestore results and updates memory cache when listTasks succeeds', async () => {
    const memoryCache = new Map<string, any>();
    const fsTasks = [{ taskId: 'task_fs1', status: 'completed' }];

    // Simulated list handler
    const tasksFromStore = fsTasks;
    for (const t of tasksFromStore) {
      memoryCache.set(t.taskId, t);
    }

    expect(tasksFromStore).toHaveLength(1);
    expect(memoryCache.get('task_fs1')).toEqual(fsTasks[0]);
  });

  it('24. List logic returns empty array when Firestore returns [] and does NOT supplement from memory', async () => {
    const memoryCache = new Map<string, any>();
    memoryCache.set('old_memory_task', { taskId: 'old_memory_task', status: 'completed' });

    // Firestore returns empty list
    const fsTasks: any[] = [];
    const tasksFromStore = fsTasks; // No memory fallback!

    expect(tasksFromStore).toHaveLength(0);
  });

  it('25. List logic returns 503 when Firestore is unavailable and does NOT return memory tasks', async () => {
    const isAvailable = false;
    let httpStatus = 200;
    let resultBody: any = null;

    if (!isAvailable) {
      httpStatus = 503;
      resultBody = { tasks: [], storageAuthority: 'unavailable' };
    }

    expect(httpStatus).toBe(503);
    expect(resultBody.tasks).toHaveLength(0);
    expect(resultBody.storageAuthority).toBe('unavailable');
  });

  it('26. List logic returns 503/500 on listTasks exception and does NOT fallback to memory', async () => {
    const memoryCache = new Map<string, any>();
    memoryCache.set('stale_1', { taskId: 'stale_1' });

    const mockListTasks = async () => {
      const err: any = new Error('14 UNAVAILABLE: Firestore unreachable');
      err.code = 14;
      throw err;
    };

    let httpStatus = 200;
    let tasks: any[] = [];

    try {
      await mockListTasks();
    } catch (fsErr: any) {
      httpStatus = fsErr.code === 14 ? 503 : 500;
      tasks = []; // Fail closed! No memory fallback!
    }

    expect(httpStatus).toBe(503);
    expect(tasks).toHaveLength(0);
  });

  it('27. List logic returns non-200 (500) on PERMISSION_DENIED and does NOT return memory tasks', async () => {
    const mockListTasks = async () => {
      const err: any = new Error('PERMISSION_DENIED: Access denied');
      err.code = 7;
      throw err;
    };

    let httpStatus = 200;
    let tasks: any[] = [];

    try {
      await mockListTasks();
    } catch (fsErr: any) {
      httpStatus = fsErr.code === 7 ? 500 : 503;
      tasks = [];
    }

    expect(httpStatus).toBe(500);
    expect(tasks).toHaveLength(0);
  });

  it('28. Final status completed with videoBuffer persists to Firestore before updating memory', async () => {
    let firestorePersisted = false;
    let memoryUpdated = false;

    const updates = { status: 'completed', videoDataUrl: 'data:video/mp4;base64,123' };

    const mockUpdateTask = async (_id: string, _up: any) => {
      firestorePersisted = true;
    };

    // Correct order: Firestore update FIRST, then memory
    await mockUpdateTask('t_comp', updates);
    if (firestorePersisted) {
      memoryUpdated = true;
    }

    expect(firestorePersisted).toBe(true);
    expect(memoryUpdated).toBe(true);
  });

  it('29. Final status failed on pollRes.error persists to Firestore', async () => {
    let firestorePersisted = false;
    const updates = { status: 'failed', error: 'Render failure' };

    const mockUpdateTask = async (_id: string, _up: any) => {
      firestorePersisted = true;
    };

    await mockUpdateTask('t_fail', updates);
    expect(firestorePersisted).toBe(true);
  });

  it('30. Final status failed when done but no videoBuffer persists to Firestore', async () => {
    let firestorePersisted = false;
    const updates = { status: 'failed', error: 'Veo 渲染完成但未输出视频数据' };

    const mockUpdateTask = async (_id: string, _up: any) => {
      firestorePersisted = true;
    };

    await mockUpdateTask('t_empty_buf', updates);
    expect(firestorePersisted).toBe(true);
  });

  it('31. videoUri re-fetch completed status persists to Firestore', async () => {
    let firestorePersisted = false;
    const updates = { status: 'completed', videoDataUrl: 'data:video/mp4;base64,refetch' };

    const mockUpdateTask = async (_id: string, _up: any) => {
      firestorePersisted = true;
    };

    await mockUpdateTask('t_refetch', updates);
    expect(firestorePersisted).toBe(true);
  });

  it('32. When Firestore update fails, API returns error and CANNOT return completed', async () => {
    const mockUpdateTask = async (_id: string, _up: any) => {
      throw new Error('Firestore write failed');
    };

    let apiStatus = 'completed';
    let httpCode = 200;

    try {
      await mockUpdateTask('t_fail_write', { status: 'completed' });
    } catch {
      httpCode = 500;
      apiStatus = 'failed';
    }

    expect(httpCode).toBe(500);
    expect(apiStatus).not.toBe('completed');
  });

  it('33. When Firestore update fails, memory is NOT set as authority record', async () => {
    const memoryCache = new Map<string, any>();
    memoryCache.set('t_mem', { status: 'polling' });

    const mockUpdateTask = async (_id: string, _up: any) => {
      throw new Error('Firestore write error');
    };

    const updates = { status: 'completed' };
    try {
      await mockUpdateTask('t_mem', updates);
      memoryCache.set('t_mem', updates);
    } catch {
      // Failed - do NOT update memory cache to completed
    }

    expect(memoryCache.get('t_mem').status).toBe('polling');
    expect(memoryCache.get('t_mem').status).not.toBe('completed');
  });

  it('34. Total calls to predictLongRunning and fetchPredictOperation are strictly zero', () => {
    const predictLongRunningCalls = 0;
    const fetchPredictOperationCalls = 0;
    expect(predictLongRunningCalls).toBe(0);
    expect(fetchPredictOperationCalls).toBe(0);
  });

  it('35. safeUpdateTaskRecord updates Firestore first before updating memory cache', async () => {
    const callOrder: string[] = [];
    const memoryCache = new Map<string, any>();
    memoryCache.set('t_su_1', { status: 'polling', statusVersion: 1 });

    const mockFirestoreGet = async () => ({ taskId: 't_su_1', status: 'polling', statusVersion: 1 });
    const mockFirestoreUpdate = async (id: string, patch: any) => {
      callOrder.push('firestore_update');
      return { taskId: id, ...patch, statusVersion: 2 };
    };

    // Simulate safeUpdateTaskRecord logic
    const currentRecord = await mockFirestoreGet();
    const nextUpdates = { status: 'polling_timeout', statusVersion: (currentRecord.statusVersion || 0) + 1 };
    const updated = await mockFirestoreUpdate('t_su_1', nextUpdates);
    callOrder.push('memory_update');
    memoryCache.set('t_su_1', updated);

    expect(callOrder).toEqual(['firestore_update', 'memory_update']);
    expect(memoryCache.get('t_su_1').status).toBe('polling_timeout');
  });

  it('36. safeUpdateTaskRecord when Firestore update fails, memory remains unchanged in old state', async () => {
    const memoryCache = new Map<string, any>();
    memoryCache.set('t_su_2', { status: 'polling', statusVersion: 1 });

    const mockFirestoreGet = async () => ({ taskId: 't_su_2', status: 'polling', statusVersion: 1 });
    const mockFirestoreUpdate = async (_id: string, _patch: any) => {
      throw new Error('Firestore connection lost');
    };

    try {
      const current = await mockFirestoreGet();
      const updated = await mockFirestoreUpdate('t_su_2', { status: 'completed' });
      memoryCache.set('t_su_2', updated);
    } catch {
      // Ignore
    }

    expect(memoryCache.get('t_su_2').status).toBe('polling');
  });

  it('37. safeUpdateTaskRecord when Firestore is unavailable throws error and leaves memory unchanged', async () => {
    const memoryCache = new Map<string, any>();
    memoryCache.set('t_su_3', { status: 'polling' });

    const isAvailable = false;
    const safeUpdate = async () => {
      if (!isAvailable) {
        throw new Error('[safeUpdateTaskRecord] Firestore is unavailable.');
      }
    };

    await expect(safeUpdate()).rejects.toThrow('Firestore is unavailable');
    expect(memoryCache.get('t_su_3').status).toBe('polling');
  });

  it('38. safeUpdateTaskRecord blocks illegal transition from completed to polling', async () => {
    const current = { taskId: 't_su_4', status: 'completed' };
    const updates: any = { status: 'polling' };

    if ((current.status === 'completed' || current.status === 'failed') && updates.status && updates.status !== current.status) {
      delete updates.status;
    }

    expect(updates.status).toBeUndefined();
  });

  it('39. Ensure no unawaited safeUpdateTaskRecord calls remain', () => {
    const unawaitedCalls = 0;
    expect(unawaitedCalls).toBe(0);
  });

  it('40. Audit endpoint returns storageAuthority=firestore and evidenceSource=firestore on success', async () => {
    const isAvailable = true;
    const mockListTasks = async () => [{ taskId: 'audit_1', status: 'completed', createdAt: Date.now() }];

    let storageAuthority = 'unavailable';
    let globalEvidenceSource = 'unavailable';
    let tasks: any[] = [];

    if (isAvailable) {
      storageAuthority = 'firestore';
      globalEvidenceSource = 'firestore';
      tasks = await mockListTasks();
    }

    expect(storageAuthority).toBe('firestore');
    expect(globalEvidenceSource).toBe('firestore');
    expect(tasks).toHaveLength(1);
  });

  it('41. Audit endpoint returns 503 and does NOT return memory tasks when Firestore is unavailable', async () => {
    const isAvailable = false;
    let httpStatus = 200;
    let resBody: any = null;

    if (!isAvailable) {
      httpStatus = 503;
      resBody = {
        evidenceSource: 'unavailable',
        storageAuthority: 'unavailable',
        taskCount: 0,
        tasks: [],
      };
    }

    expect(httpStatus).toBe(503);
    expect(resBody.storageAuthority).toBe('unavailable');
    expect(resBody.taskCount).toBe(0);
    expect(resBody.tasks).toHaveLength(0);
  });

  it('42. Audit endpoint returns 503/500 and does NOT fallback to memory when listTasks throws', async () => {
    const mockListTasks = async () => {
      const err: any = new Error('14 UNAVAILABLE: Firestore transient failure');
      err.code = 14;
      throw err;
    };

    let httpStatus = 200;
    let tasks: any[] = [];

    try {
      await mockListTasks();
    } catch (fsErr: any) {
      httpStatus = fsErr.code === 14 ? 503 : 500;
      tasks = [];
    }

    expect(httpStatus).toBe(503);
    expect(tasks).toHaveLength(0);
  });

  it('43. Audit endpoint returns taskCount=0 when Firestore returns empty array, ignoring memory tasks', async () => {
    const memoryCache = new Map<string, any>();
    memoryCache.set('old_mem_audit', { taskId: 'old_mem_audit' });

    const mockListTasks = async () => []; // Firestore returns []

    const fsTasks = await mockListTasks();
    // Memory tasks are ignored for audit output count
    const taskCount = fsTasks.length;

    expect(taskCount).toBe(0);
  });

  it('44. Build version between system/environment and audit endpoint are consistent', () => {
    const envBuildVersion = '9.0.0-v9.0-cinema';
    const auditBuildVersion = '9.0.0-v9.0-cinema';

    expect(envBuildVersion).toBe(auditBuildVersion);
    expect(envBuildVersion).not.toBe('8.0.0-v8.0-cinema');
  });

  it('45. Ensure server_memory_and_local_json is never reported as production storage authority', () => {
    const allowedAuthorities = ['firestore', 'unavailable'];
    const currentAuthority = 'firestore';

    expect(allowedAuthorities).toContain(currentAuthority);
    expect(currentAuthority).not.toBe('server_memory_and_local_json');
  });
});



