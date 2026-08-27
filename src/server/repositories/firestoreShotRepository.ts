import type { KeyframeProvider, ShotSpec } from '../../domain/episode/episodeTypes';
import { buildShotDocumentId } from '../../domain/episode/episodeTypes';
import { parseShotSpec } from '../../domain/episode/episodeSchema';
import { getFirestoreInstance, isFirestoreAvailable, markFirestoreUnavailable } from '../db/firestore';
import { sanitizeForFirestore } from './firestoreTaskRepository';

export class FirestoreShotRepository {
  private readonly collectionName = 'zaojing_shots';

  public isAvailable(): boolean {
    return isFirestoreAvailable();
  }

  private handleError(err: any): void {
    const code = err?.code;
    const status = err?.status || err?.statusCode;
    const message = String(err?.message || err || '');
    if (
      code === 7 || code === 'PERMISSION_DENIED' || status === 403 ||
      code === 16 || code === 'UNAUTHENTICATED' || status === 401 ||
      code === 8 || code === 'RESOURCE_EXHAUSTED' || status === 429 ||
      code === 14 || code === 'UNAVAILABLE' ||
      message.includes('PERMISSION_DENIED') ||
      message.includes('UNAUTHENTICATED') ||
      message.includes('RESOURCE_EXHAUSTED') ||
      message.includes('UNAVAILABLE') ||
      message.includes('Could not load the default credentials')
    ) {
      markFirestoreUnavailable(err);
    }
  }

  public async createShot(record: ShotSpec): Promise<ShotSpec> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const parsed = parseShotSpec(record);
    const docId = buildShotDocumentId(parsed.episodeId, parsed.shotId);

    try {
      await db.collection(this.collectionName).doc(docId).create(sanitizeForFirestore(parsed));
      return parsed;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async upsertShot(record: ShotSpec): Promise<ShotSpec> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const parsed = parseShotSpec(record);
    const docId = buildShotDocumentId(parsed.episodeId, parsed.shotId);

    try {
      await db.collection(this.collectionName).doc(docId).set(
        sanitizeForFirestore(parsed),
        { merge: false }
      );
      return parsed;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async getShot(episodeId: string, shotId: string): Promise<ShotSpec | null> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const docId = buildShotDocumentId(episodeId, shotId);

    try {
      const snap = await db.collection(this.collectionName).doc(docId).get();
      if (!snap.exists) return null;
      return parseShotSpec(snap.data());
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async listShotsByEpisode(episodeId: string, limitCount = 100): Promise<ShotSpec[]> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const safeEpisodeId = String(episodeId || '').trim();
    if (!safeEpisodeId) return [];

    try {
      const snapshot = await db
        .collection(this.collectionName)
        .where('episodeId', '==', safeEpisodeId)
        .limit(Math.max(1, Math.min(100, limitCount)))
        .get();
      const records: ShotSpec[] = [];
      snapshot.forEach((docSnap) => records.push(parseShotSpec(docSnap.data())));
      return records.sort((a, b) => a.order - b.order);
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async bindKeyframeAsset(params: {
    episodeId: string;
    shotId: string;
    provider: KeyframeProvider;
    expectedVersion: number;
    asset: {
      assetId: string;
      sourceFileId?: string;
      outputBucket: string;
      outputObjectPath: string;
      contentSha256: string;
      mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
      sizeBytes: number;
      width: number;
      height: number;
      providerModel?: string;
      promptHash?: string;
      persistedAt: number;
    };
  }): Promise<ShotSpec> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const docId = buildShotDocumentId(params.episodeId, params.shotId);

    try {
      const ref = db.collection(this.collectionName).doc(docId);
      let updated: ShotSpec | null = null;
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) throw new Error('[FirestoreShotRepository] Shot not found.');
        const current = parseShotSpec(snap.data());

        if (current.status === 'COMPLETED' || current.status === 'CANCELLED') {
          throw new Error(`[FirestoreShotRepository] KEYFRAME_SHOT_IMMUTABLE: ${current.status}`);
        }
        if (current.keyframe.provider !== params.provider) {
          throw new Error(
            `[FirestoreShotRepository] KEYFRAME_PROVIDER_MISMATCH: planned=${current.keyframe.provider}, received=${params.provider}`
          );
        }
        if (current.keyframe.version !== params.expectedVersion) {
          throw new Error(
            `[FirestoreShotRepository] KEYFRAME_VERSION_CONFLICT: expected=${params.expectedVersion}, current=${current.keyframe.version}`
          );
        }
        if (current.video.generationTaskId || current.video.status !== 'NOT_REQUESTED') {
          throw new Error('[FirestoreShotRepository] KEYFRAME_VIDEO_ALREADY_STARTED: cannot replace keyframe after video execution begins.');
        }

        const next = parseShotSpec({
          ...current,
          status: 'KEYFRAME_QA',
          keyframe: {
            ...current.keyframe,
            ...params.asset,
            provider: params.provider,
            status: 'QA_PENDING',
            generationAttempt: current.keyframe.generationAttempt + 1,
          },
          updatedAt: Date.now(),
        });
        transaction.set(ref, sanitizeForFirestore(next), { merge: false });
        updated = next;
      });
      if (!updated) throw new Error('[FirestoreShotRepository] Failed to bind keyframe asset.');
      return updated;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async linkGenerationTask(params: {
    episodeId: string;
    shotId: string;
    generationTaskId: string;
  }): Promise<ShotSpec> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const taskId = String(params.generationTaskId || '').trim();
    if (!taskId) throw new Error('[FirestoreShotRepository] generationTaskId is required.');
    const docId = buildShotDocumentId(params.episodeId, params.shotId);

    try {
      const ref = db.collection(this.collectionName).doc(docId);
      let updated: ShotSpec | null = null;
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) throw new Error('[FirestoreShotRepository] Shot not found.');
        const current = parseShotSpec(snap.data());
        if (current.keyframe.status !== 'PASS') {
          throw new Error('[FirestoreShotRepository] KEYFRAME_GATE_BLOCKED: video task cannot start before keyframe PASS.');
        }
        if (current.video.generationTaskId && current.video.generationTaskId !== taskId) {
          throw new Error('[FirestoreShotRepository] Shot is already linked to a different generation task.');
        }

        const next: ShotSpec = parseShotSpec({
          ...current,
          status: current.status === 'COMPLETED' ? current.status : 'VIDEO_PENDING',
          video: {
            ...current.video,
            generationTaskId: taskId,
            status: current.video.status === 'NOT_REQUESTED' ? 'PENDING' : current.video.status,
          },
          updatedAt: Date.now(),
        });
        transaction.set(ref, sanitizeForFirestore(next), { merge: false });
        updated = next;
      });
      if (!updated) throw new Error('[FirestoreShotRepository] Failed to link generation task.');
      return updated;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async prepareVideoExecution(params: {
    episodeId: string;
    shotId: string;
    idempotencyKey: string;
  }): Promise<ShotSpec> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const idempotencyKey = String(params.idempotencyKey || '').trim();
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      throw new Error('[FirestoreShotRepository] VIDEO_IDEMPOTENCY_KEY_INVALID');
    }
    const docId = buildShotDocumentId(params.episodeId, params.shotId);

    try {
      const ref = db.collection(this.collectionName).doc(docId);
      let updated: ShotSpec | null = null;
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) throw new Error('[FirestoreShotRepository] Shot not found.');
        const current = parseShotSpec(snap.data());

        if (current.keyframe.status !== 'PASS') {
          throw new Error('[FirestoreShotRepository] KEYFRAME_GATE_BLOCKED: video task cannot start before keyframe PASS.');
        }
        if (
          current.video.idempotencyKey &&
          current.video.idempotencyKey !== idempotencyKey &&
          current.status !== 'FAILED'
        ) {
          throw new Error('[FirestoreShotRepository] VIDEO_IDEMPOTENCY_CONFLICT: a different video intent is already active.');
        }
        if (current.video.status === 'PASS' && current.status === 'COMPLETED') {
          updated = current;
          return;
        }
        if (current.video.status === 'GENERATING' && current.video.generationTaskId) {
          updated = current;
          return;
        }

        const isRetryAfterFailure = current.status === 'FAILED';
        const next = parseShotSpec({
          ...current,
          status: 'VIDEO_PENDING',
          video: {
            ...current.video,
            ...(isRetryAfterFailure
              ? {
                  generationTaskId: undefined,
                  assetId: undefined,
                  outputBucket: undefined,
                  outputObjectPath: undefined,
                  artifactUrl: undefined,
                  downloadUrl: undefined,
                  artifactExpiresAt: undefined,
                  artifactPersisted: undefined,
                  artifactVerified: undefined,
                  failureCode: undefined,
                  failureMessage: undefined,
                }
              : {}),
            idempotencyKey,
            status: 'PENDING',
            providerAttempt: Math.max(1, current.video.providerAttempt + (isRetryAfterFailure ? 1 : 0)),
          },
          completedAt: undefined,
          updatedAt: Date.now(),
        });
        transaction.set(ref, sanitizeForFirestore(next), { merge: false });
        updated = next;
      });
      if (!updated) throw new Error('[FirestoreShotRepository] Failed to prepare video execution.');
      return updated;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async markVideoGenerating(params: {
    episodeId: string;
    shotId: string;
    idempotencyKey: string;
    generationTaskId: string;
    providerAttempt?: number;
  }): Promise<ShotSpec> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const taskId = String(params.generationTaskId || '').trim();
    const idempotencyKey = String(params.idempotencyKey || '').trim();
    if (!taskId) throw new Error('[FirestoreShotRepository] generationTaskId is required.');
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      throw new Error('[FirestoreShotRepository] VIDEO_IDEMPOTENCY_KEY_INVALID');
    }
    const docId = buildShotDocumentId(params.episodeId, params.shotId);

    try {
      const ref = db.collection(this.collectionName).doc(docId);
      let updated: ShotSpec | null = null;
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) throw new Error('[FirestoreShotRepository] Shot not found.');
        const current = parseShotSpec(snap.data());
        if (current.keyframe.status !== 'PASS') {
          throw new Error('[FirestoreShotRepository] KEYFRAME_GATE_BLOCKED: video task cannot start before keyframe PASS.');
        }
        if (current.video.idempotencyKey && current.video.idempotencyKey !== idempotencyKey) {
          throw new Error('[FirestoreShotRepository] VIDEO_IDEMPOTENCY_CONFLICT: idempotency key does not match the active video intent.');
        }
        if (current.video.generationTaskId && current.video.generationTaskId !== taskId) {
          throw new Error('[FirestoreShotRepository] VIDEO_TASK_CONFLICT: shot is already linked to a different generation task.');
        }
        if (current.status === 'COMPLETED' && current.video.status === 'PASS') {
          updated = current;
          return;
        }

        const next = parseShotSpec({
          ...current,
          status: 'VIDEO_GENERATING',
          video: {
            ...current.video,
            idempotencyKey,
            generationTaskId: taskId,
            status: 'GENERATING',
            providerAttempt: Math.max(1, params.providerAttempt || current.video.providerAttempt),
          },
          updatedAt: Date.now(),
        });
        transaction.set(ref, sanitizeForFirestore(next), { merge: false });
        updated = next;
      });
      if (!updated) throw new Error('[FirestoreShotRepository] Failed to mark video generating.');
      return updated;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async completeVideo(params: {
    episodeId: string;
    shotId: string;
    idempotencyKey: string;
    taskId: string;
    videoUrl: string;
    downloadUrl: string;
    expiresAt?: string | null;
    providerAttempt?: number;
    artifactPersisted: boolean;
    artifactVerified: boolean;
  }): Promise<ShotSpec> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const taskId = String(params.taskId || '').trim();
    const idempotencyKey = String(params.idempotencyKey || '').trim();
    const videoUrl = String(params.videoUrl || '').trim();
    const downloadUrl = String(params.downloadUrl || '').trim();
    if (!taskId || !videoUrl || !downloadUrl) {
      throw new Error('[FirestoreShotRepository] VIDEO_ARTIFACT_FIELDS_REQUIRED');
    }
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      throw new Error('[FirestoreShotRepository] VIDEO_IDEMPOTENCY_KEY_INVALID');
    }
    const docId = buildShotDocumentId(params.episodeId, params.shotId);

    try {
      const ref = db.collection(this.collectionName).doc(docId);
      let updated: ShotSpec | null = null;
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) throw new Error('[FirestoreShotRepository] Shot not found.');
        const current = parseShotSpec(snap.data());
        if (current.video.idempotencyKey && current.video.idempotencyKey !== idempotencyKey) {
          throw new Error('[FirestoreShotRepository] VIDEO_IDEMPOTENCY_CONFLICT: completion key does not match the active video intent.');
        }
        if (current.video.generationTaskId && current.video.generationTaskId !== taskId) {
          throw new Error('[FirestoreShotRepository] VIDEO_TASK_CONFLICT: completion task does not match the active task.');
        }

        const next = parseShotSpec({
          ...current,
          status: 'COMPLETED',
          video: {
            ...current.video,
            provider: 'VEO',
            status: 'PASS',
            generationTaskId: taskId,
            assetId: current.video.assetId || taskId,
            idempotencyKey,
            artifactUrl: videoUrl,
            downloadUrl,
            ...(params.expiresAt ? { artifactExpiresAt: params.expiresAt } : {}),
            artifactPersisted: params.artifactPersisted,
            artifactVerified: params.artifactVerified,
            providerAttempt: Math.max(1, params.providerAttempt || current.video.providerAttempt),
            qaAttempt: current.video.qaAttempt + 1,
            failureCode: undefined,
            failureMessage: undefined,
          },
          completedAt: Date.now(),
          updatedAt: Date.now(),
        });
        transaction.set(ref, sanitizeForFirestore(next), { merge: false });
        updated = next;
      });
      if (!updated) throw new Error('[FirestoreShotRepository] Failed to complete video.');
      return updated;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async failVideo(params: {
    episodeId: string;
    shotId: string;
    idempotencyKey: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<ShotSpec> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const idempotencyKey = String(params.idempotencyKey || '').trim();
    const docId = buildShotDocumentId(params.episodeId, params.shotId);

    try {
      const ref = db.collection(this.collectionName).doc(docId);
      let updated: ShotSpec | null = null;
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) throw new Error('[FirestoreShotRepository] Shot not found.');
        const current = parseShotSpec(snap.data());
        if (current.video.idempotencyKey && current.video.idempotencyKey !== idempotencyKey) {
          throw new Error('[FirestoreShotRepository] VIDEO_IDEMPOTENCY_CONFLICT: failure key does not match the active video intent.');
        }

        const hasTask = Boolean(current.video.generationTaskId);
        const next = parseShotSpec({
          ...current,
          status: 'FAILED',
          video: {
            ...current.video,
            idempotencyKey,
            status: hasTask ? 'FAIL' : 'NOT_REQUESTED',
            failureCode: String(params.errorCode || 'S01_PRODUCTION_FAILED').slice(0, 200),
            failureMessage: String(params.errorMessage || '').slice(0, 2000),
          },
          updatedAt: Date.now(),
        });
        transaction.set(ref, sanitizeForFirestore(next), { merge: false });
        updated = next;
      });
      if (!updated) throw new Error('[FirestoreShotRepository] Failed to record video failure.');
      return updated;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

}

export const firestoreShotRepository = new FirestoreShotRepository();
