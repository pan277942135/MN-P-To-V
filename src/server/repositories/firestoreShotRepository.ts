import type { KeyframeProvider, KeyframeQaResult, ShotSpec } from '../../domain/episode/episodeTypes';
import { buildShotDocumentId } from '../../domain/episode/episodeTypes';
import { parseShotSpec } from '../../domain/episode/episodeSchema';
import { getFirestoreInstance, isFirestoreAvailable, markFirestoreUnavailable } from '../db/firestore';
import { sanitizeForFirestore } from './firestoreTaskRepository';

export class FirestoreShotRepository {
  private readonly collectionName = 'zaojing_shots';
  public isAvailable(): boolean { return isFirestoreAvailable(); }

  private handleError(err: any): void {
    const code = err?.code;
    const status = err?.status || err?.statusCode;
    const message = String(err?.message || err || '');
    if (
      code === 7 || code === 'PERMISSION_DENIED' || status === 403 ||
      code === 16 || code === 'UNAUTHENTICATED' || status === 401 ||
      code === 8 || code === 'RESOURCE_EXHAUSTED' || status === 429 ||
      code === 14 || code === 'UNAVAILABLE' ||
      message.includes('PERMISSION_DENIED') || message.includes('UNAUTHENTICATED') ||
      message.includes('RESOURCE_EXHAUSTED') || message.includes('UNAVAILABLE') ||
      message.includes('Could not load the default credentials')
    ) markFirestoreUnavailable(err);
  }

  public async createShot(record: ShotSpec): Promise<ShotSpec> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const parsed = parseShotSpec(record);
    try {
      await db.collection(this.collectionName).doc(buildShotDocumentId(parsed.episodeId, parsed.shotId)).create(sanitizeForFirestore(parsed));
      return parsed;
    } catch (err) { this.handleError(err); throw err; }
  }

  public async upsertShot(record: ShotSpec): Promise<ShotSpec> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const parsed = parseShotSpec(record);
    try {
      await db.collection(this.collectionName).doc(buildShotDocumentId(parsed.episodeId, parsed.shotId)).set(sanitizeForFirestore(parsed), { merge: false });
      return parsed;
    } catch (err) { this.handleError(err); throw err; }
  }

  public async getShot(episodeId: string, shotId: string): Promise<ShotSpec | null> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    try {
      const snap = await db.collection(this.collectionName).doc(buildShotDocumentId(episodeId, shotId)).get();
      if (!snap.exists) return null;
      return parseShotSpec(snap.data());
    } catch (err) { this.handleError(err); throw err; }
  }

  public async listShotsByEpisode(episodeId: string, limitCount = 100): Promise<ShotSpec[]> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreShotRepository] Firestore is unavailable.');
    const safeEpisodeId = String(episodeId || '').trim();
    if (!safeEpisodeId) return [];
    try {
      const snapshot = await db.collection(this.collectionName).where('episodeId', '==', safeEpisodeId).limit(Math.max(1, Math.min(100, limitCount))).get();
      const records: ShotSpec[] = [];
      snapshot.forEach((docSnap) => records.push(parseShotSpec(docSnap.data())));
      return records.sort((a, b) => a.order - b.order);
    } catch (err) { this.handleError(err); throw err; }
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
        if (current.status === 'COMPLETED' || current.status === 'CANCELLED') throw new Error(`[FirestoreShotRepository] KEYFRAME_SHOT_IMMUTABLE: ${current.status}`);
        if (current.keyframe.provider !== params.provider) throw new Error(`[FirestoreShotRepository] KEYFRAME_PROVIDER_MISMATCH: planned=${current.keyframe.provider}, received=${params.provider}`);
        const sameVersion = current.keyframe.version === params.expectedVersion;
        const validRetryVersion = current.keyframe.status === 'FAIL' && params.expectedVersion === current.keyframe.version + 1;
        if (!sameVersion && !validRetryVersion) throw new Error(`[FirestoreShotRepository] KEYFRAME_VERSION_CONFLICT: expected=${params.expectedVersion}, current=${current.keyframe.version}`);
        if (current.video.generationTaskId || current.video.status !== 'NOT_REQUESTED') throw new Error('[FirestoreShotRepository] KEYFRAME_VIDEO_ALREADY_STARTED: cannot replace keyframe after video execution begins.');

        const { qa: _previousQa, ...keyframeWithoutQa } = current.keyframe;
        const next = parseShotSpec({
          ...current,
          status: 'KEYFRAME_QA',
          keyframe: {
            ...keyframeWithoutQa,
            ...params.asset,
            provider: params.provider,
            status: 'QA_PENDING',
            version: params.expectedVersion,
            generationAttempt: current.keyframe.generationAttempt + 1,
          },
          updatedAt: Date.now(),
        });
        transaction.set(ref, sanitizeForFirestore(next), { merge: false });
        updated = next;
      });
      if (!updated) throw new Error('[FirestoreShotRepository] Failed to bind keyframe asset.');
      return updated;
    } catch (err) { this.handleError(err); throw err; }
  }

  public async applyKeyframeQaResult(params: {
    episodeId: string;
    shotId: string;
    expectedAssetId: string;
    expectedVersion: number;
    qa: KeyframeQaResult;
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
        if (current.keyframe.assetId !== params.expectedAssetId || current.keyframe.version !== params.expectedVersion) {
          throw new Error('[FirestoreShotRepository] KEYFRAME_QA_STALE_ASSET: asset/version changed during QA.');
        }
        if (current.keyframe.status !== 'QA_PENDING') {
          throw new Error(`[FirestoreShotRepository] KEYFRAME_QA_STATE_INVALID: ${current.keyframe.status}`);
        }

        const keyframeStatus = params.qa.gate === 'PASS' ? 'PASS' : params.qa.gate === 'REVIEW' ? 'REVIEW' : 'FAIL';
        const shotStatus = params.qa.gate === 'PASS'
          ? 'VIDEO_PENDING'
          : params.qa.gate === 'REVIEW' || params.qa.retryAction === 'HUMAN_REVIEW'
            ? 'KEYFRAME_REVIEW'
            : 'KEYFRAME_PENDING';
        const next = parseShotSpec({
          ...current,
          status: shotStatus,
          keyframe: {
            ...current.keyframe,
            status: keyframeStatus,
            qa: params.qa,
            qaAttempt: current.keyframe.qaAttempt + 1,
          },
          updatedAt: Date.now(),
        });
        transaction.set(ref, sanitizeForFirestore(next), { merge: false });
        updated = next;
      });
      if (!updated) throw new Error('[FirestoreShotRepository] Failed to apply keyframe QA result.');
      return updated;
    } catch (err) { this.handleError(err); throw err; }
  }

  public async linkGenerationTask(params: { episodeId: string; shotId: string; generationTaskId: string }): Promise<ShotSpec> {
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
        if (current.keyframe.status !== 'PASS') throw new Error('[FirestoreShotRepository] KEYFRAME_GATE_BLOCKED: video task cannot start before keyframe PASS.');
        if (current.video.generationTaskId && current.video.generationTaskId !== taskId) throw new Error('[FirestoreShotRepository] Shot is already linked to a different generation task.');
        const next: ShotSpec = parseShotSpec({
          ...current,
          status: current.status === 'COMPLETED' ? current.status : 'VIDEO_PENDING',
          video: { ...current.video, generationTaskId: taskId, status: current.video.status === 'NOT_REQUESTED' ? 'PENDING' : current.video.status },
          updatedAt: Date.now(),
        });
        transaction.set(ref, sanitizeForFirestore(next), { merge: false });
        updated = next;
      });
      if (!updated) throw new Error('[FirestoreShotRepository] Failed to link generation task.');
      return updated;
    } catch (err) { this.handleError(err); throw err; }
  }
}

export const firestoreShotRepository = new FirestoreShotRepository();
