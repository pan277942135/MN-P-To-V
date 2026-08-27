import type { ShotSpec } from '../../domain/episode/episodeTypes';
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
}

export const firestoreShotRepository = new FirestoreShotRepository();
