import type { ServerVideoTaskRecord } from '../../types';
import { getFirestoreInstance, isFirestoreAvailable, markFirestoreUnavailable } from '../db/firestore';

export function sanitizeForFirestore<T extends Record<string, any>>(obj: T): Record<string, any> {
  const cleanObj: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) {
      continue;
    }
    if (typeof val === 'string') {
      if (val.length > 150000 || (val.startsWith('data:') && val.length > 100000)) {
        console.warn(
          `[Firestore Sanitizer] Excluding oversized string/Base64 field '${key}' (${val.length} chars) from Firestore document to preserve 1MB limit.`
        );
        continue;
      }
      cleanObj[key] = val;
    } else if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      !(val instanceof Date)
    ) {
      cleanObj[key] = sanitizeForFirestore(val);
    } else {
      cleanObj[key] = val;
    }
  }
  return cleanObj;
}

function assertCompletedInvariant(task: Partial<ServerVideoTaskRecord>): void {
  if (task.status !== 'completed') return;

  const missing: string[] = [];
  if (task.artifactPersisted !== true) missing.push('artifactPersisted');
  if (!task.outputBucket) missing.push('outputBucket');
  if (!task.outputObjectPath) missing.push('outputObjectPath');
  if (!task.videoUri) missing.push('videoUri');

  if (missing.length > 0) {
    throw new Error(
      `[FirestoreTaskRepository] completed invariant violated; missing/invalid: ${missing.join(', ')}`
    );
  }
}

export class FirestoreTaskRepository {
  private collectionName = 'video_tasks';

  public firestoreReadCount = 0;
  public firestoreWriteCount = 0;
  public firestoreRetryCount = 0;

  public getDiagnostics() {
    return {
      firestoreReadCount: this.firestoreReadCount,
      firestoreWriteCount: this.firestoreWriteCount,
      firestoreRetryCount: this.firestoreRetryCount,
    };
  }

  public resetDiagnostics() {
    this.firestoreReadCount = 0;
    this.firestoreWriteCount = 0;
    this.firestoreRetryCount = 0;
  }

  private async withRetry<T>(opName: string, isWrite: boolean, fn: () => Promise<T>): Promise<T> {
    const maxRetries = 2;
    let attempt = 0;
    while (true) {
      try {
        if (isWrite) {
          this.firestoreWriteCount++;
        } else {
          this.firestoreReadCount++;
        }
        return await fn();
      } catch (err: any) {
        attempt++;
        const code = err?.code;
        const msg = String(err?.message || err);
        const isTransient =
          code === 8 ||
          code === 'RESOURCE_EXHAUSTED' ||
          code === 14 ||
          code === 'UNAVAILABLE' ||
          code === 4 ||
          code === 'DEADLINE_EXHAUSTED' ||
          msg.includes('RESOURCE_EXHAUSTED') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('Quota limit exceeded') ||
          msg.includes('Quota exceeded');

        if (isTransient && attempt <= maxRetries) {
          this.firestoreRetryCount++;
          const backoffMs = attempt * 250;
          console.warn(
            `[Firestore ${opName}] Transient error (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms:`,
            msg
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        this.handleFirestoreError(err);
        throw err;
      }
    }
  }

  private handleFirestoreError(err: any): void {
    if (!err) return;

    const code = err.code;
    const status = err.status || err.statusCode;
    const msg = String(err.message || err);

    const isPermissionDenied =
      code === 7 ||
      code === 'PERMISSION_DENIED' ||
      status === 403 ||
      msg.includes('PERMISSION_DENIED');

    const isUnauthenticated =
      code === 16 ||
      code === 'UNAUTHENTICATED' ||
      status === 401 ||
      msg.includes('UNAUTHENTICATED') ||
      msg.includes('Could not load the default credentials');

    const isQuotaExhausted =
      code === 8 ||
      code === 'RESOURCE_EXHAUSTED' ||
      status === 429 ||
      msg.includes('RESOURCE_EXHAUSTED') ||
      msg.includes('Quota limit exceeded') ||
      msg.includes('Quota exceeded');

    const isApiDisabledOrConfigError =
      msg.includes('has not been used in project') ||
      msg.includes('API disabled') ||
      msg.includes('is not enabled') ||
      msg.includes('DATABASE_NOT_FOUND') ||
      (msg.includes('NOT_FOUND') && msg.includes('database'));

    if (
      isPermissionDenied ||
      isUnauthenticated ||
      isQuotaExhausted ||
      isApiDisabledOrConfigError
    ) {
      markFirestoreUnavailable(err);
    }
  }

  public isAvailable(): boolean {
    return isFirestoreAvailable();
  }

  public async createTask(record: ServerVideoTaskRecord): Promise<void> {
    const db = getFirestoreInstance();
    if (!db) {
      throw new Error('[FirestoreTaskRepository] Firestore is unavailable. Cannot create task.');
    }

    const taskId = record.taskId || record.id;
    if (!taskId) {
      throw new Error('[FirestoreTaskRepository] Invalid record: missing taskId');
    }

    assertCompletedInvariant(record);

    return this.withRetry('createTask', true, async () => {
      const docRef = db.collection(this.collectionName).doc(taskId);
      const payload = sanitizeForFirestore({
        ...record,
        taskId,
        id: record.id || taskId,
        evidenceSource: 'firestore',
        stateVersion: record.stateVersion ?? record.statusVersion ?? 1,
        statusVersion: record.statusVersion ?? record.stateVersion ?? 1,
        updatedAt: record.updatedAt || Date.now(),
        createdAt: record.createdAt || Date.now(),
      });

      // create() is intentionally used instead of set(). Cross-instance duplicate starts
      // with the same durable taskId must not overwrite an existing task and then invoke
      // the provider a second time.
      await docRef.create(payload);
    });
  }

  public async getTask(taskId: string): Promise<ServerVideoTaskRecord | null> {
    const db = getFirestoreInstance();
    if (!db) {
      throw new Error('[FirestoreTaskRepository] Firestore is unavailable.');
    }

    if (!taskId) return null;

    return this.withRetry('getTask', false, async () => {
      const docRef = db.collection(this.collectionName).doc(taskId);
      const snap = await docRef.get();

      if (!snap.exists) {
        return null;
      }

      const data = snap.data() as ServerVideoTaskRecord;
      return {
        ...data,
        evidenceSource: 'firestore',
      };
    });
  }

  public async updateTask(
    taskId: string,
    patch: Partial<ServerVideoTaskRecord>
  ): Promise<ServerVideoTaskRecord | null> {
    const db = getFirestoreInstance();
    if (!db) {
      throw new Error('[FirestoreTaskRepository] Firestore is unavailable. Cannot update task.');
    }

    if (!taskId) return null;

    // Any update that creates or mutates a completed record is validated against the
    // fully merged authoritative document inside a Firestore transaction. This makes
    // the completed=>GCS contract impossible to bypass via a legacy direct updateTask()
    // call site.
    if (patch.status === 'completed') {
      return this.runTaskTransaction<ServerVideoTaskRecord | null>(taskId, (currentTask) => {
        if (!currentTask) {
          return { taskPatch: undefined, result: null };
        }

        const merged: ServerVideoTaskRecord = {
          ...currentTask,
          ...patch,
          updatedAt: patch.updatedAt || Date.now(),
        };
        assertCompletedInvariant(merged);

        return {
          taskPatch: patch,
          result: {
            ...merged,
            evidenceSource: 'firestore',
          },
        };
      });
    }

    return this.withRetry('updateTask', true, async () => {
      const docRef = db.collection(this.collectionName).doc(taskId);
      const cleanPatch = sanitizeForFirestore({
        ...patch,
        updatedAt: patch.updatedAt || Date.now(),
      });

      await docRef.update(cleanPatch);
      return await this.getTask(taskId);
    });
  }

  public async taskExists(taskId: string): Promise<boolean> {
    if (!taskId) return false;

    const db = getFirestoreInstance();
    if (!db) {
      throw new Error('[FirestoreTaskRepository] Firestore is unavailable.');
    }

    return this.withRetry('taskExists', false, async () => {
      const docRef = db.collection(this.collectionName).doc(taskId);
      const snap = await docRef.get();
      return snap.exists;
    });
  }

  public async listTasks(limitCount = 20): Promise<ServerVideoTaskRecord[]> {
    const db = getFirestoreInstance();
    if (!db) {
      throw new Error('[FirestoreTaskRepository] Firestore is unavailable.');
    }

    return this.withRetry('listTasks', false, async () => {
      const snapshot = await db
        .collection(this.collectionName)
        .orderBy('createdAt', 'desc')
        .limit(limitCount)
        .get();

      const tasks: ServerVideoTaskRecord[] = [];
      snapshot.forEach((docSnap) => {
        tasks.push({
          ...(docSnap.data() as ServerVideoTaskRecord),
          evidenceSource: 'firestore',
        });
      });

      return tasks;
    });
  }

  public async runTaskTransaction<T>(
    taskId: string,
    updateFn: (
      currentTask: ServerVideoTaskRecord | null
    ) => { taskPatch?: Partial<ServerVideoTaskRecord>; result: T }
  ): Promise<T> {
    const db = getFirestoreInstance();
    if (!db) {
      throw new Error('[FirestoreTaskRepository] Firestore is unavailable for transaction.');
    }

    return this.withRetry('runTaskTransaction', true, async () => {
      const docRef = db.collection(this.collectionName).doc(taskId);

      return await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(docRef);
        const currentTask = snap.exists
          ? ({
              ...(snap.data() as ServerVideoTaskRecord),
              evidenceSource: 'firestore',
            } as ServerVideoTaskRecord)
          : null;

        const { taskPatch, result } = updateFn(currentTask);

        if (taskPatch) {
          const merged = currentTask
            ? ({ ...currentTask, ...taskPatch } as ServerVideoTaskRecord)
            : (taskPatch as ServerVideoTaskRecord);
          assertCompletedInvariant(merged);

          const cleanPatch = sanitizeForFirestore({
            ...taskPatch,
            updatedAt: Date.now(),
          });
          if (snap.exists) {
            transaction.update(docRef, cleanPatch);
          } else {
            transaction.set(docRef, cleanPatch);
          }
        }

        return result;
      });
    });
  }
}

export const firestoreTaskRepository = new FirestoreTaskRepository();
