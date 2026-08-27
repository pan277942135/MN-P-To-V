import type { EpisodeSpec, ShotSpec } from '../../domain/episode/episodeTypes';
import { buildShotDocumentId } from '../../domain/episode/episodeTypes';
import { parseEpisodeSpec, parseShotSpec } from '../../domain/episode/episodeSchema';
import { getFirestoreInstance, isFirestoreAvailable, markFirestoreUnavailable } from '../db/firestore';
import { sanitizeForFirestore } from './firestoreTaskRepository';

function createAlreadyExistsError(resource: string): Error & { code: string } {
  const err = new Error(`[FirestoreEpisodeRepository] ${resource} already exists`) as Error & { code: string };
  err.code = 'ALREADY_EXISTS';
  return err;
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export class FirestoreEpisodeRepository {
  private readonly collectionName = 'zaojing_episodes';
  private readonly shotCollectionName = 'zaojing_shots';

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

  public async createEpisode(record: EpisodeSpec): Promise<EpisodeSpec> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreEpisodeRepository] Firestore is unavailable.');
    const parsed = parseEpisodeSpec(record);

    try {
      const ref = db.collection(this.collectionName).doc(parsed.id);
      await ref.create(sanitizeForFirestore(parsed));
      return parsed;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async createEpisodeWithShots(record: EpisodeSpec, shots: ShotSpec[]): Promise<{
    episode: EpisodeSpec;
    shots: ShotSpec[];
  }> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreEpisodeRepository] Firestore is unavailable.');

    const episode = parseEpisodeSpec(record);
    const parsedShots = shots.map((shot) => parseShotSpec(shot)).sort((a, b) => a.order - b.order);
    const shotIds = parsedShots.map((shot) => shot.shotId);

    if (!sameStringSet(episode.shotIds, shotIds)) {
      throw new Error('[FirestoreEpisodeRepository] Episode shotIds must exactly match supplied shots.');
    }
    if (parsedShots.some((shot) => shot.episodeId !== episode.id)) {
      throw new Error('[FirestoreEpisodeRepository] Every shot must reference the parent episode id.');
    }
    if (new Set(shotIds).size !== shotIds.length) {
      throw new Error('[FirestoreEpisodeRepository] Duplicate shotId in episode creation request.');
    }
    if (new Set(parsedShots.map((shot) => shot.order)).size !== parsedShots.length) {
      throw new Error('[FirestoreEpisodeRepository] Duplicate shot order in episode creation request.');
    }

    try {
      const episodeRef = db.collection(this.collectionName).doc(episode.id);
      const shotRefs = parsedShots.map((shot) =>
        db.collection(this.shotCollectionName).doc(buildShotDocumentId(episode.id, shot.shotId))
      );

      await db.runTransaction(async (transaction) => {
        const episodeSnap = await transaction.get(episodeRef);
        if (episodeSnap.exists) throw createAlreadyExistsError(`Episode ${episode.id}`);

        const shotSnaps = [];
        for (const shotRef of shotRefs) {
          shotSnaps.push(await transaction.get(shotRef));
        }
        const existingShotIndex = shotSnaps.findIndex((snapshot) => snapshot.exists);
        if (existingShotIndex >= 0) {
          throw createAlreadyExistsError(`Shot ${parsedShots[existingShotIndex].shotId}`);
        }

        transaction.create(episodeRef, sanitizeForFirestore(episode));
        parsedShots.forEach((shot, index) => {
          transaction.create(shotRefs[index], sanitizeForFirestore(shot));
        });
      });

      return { episode, shots: parsedShots };
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async upsertEpisode(record: EpisodeSpec): Promise<EpisodeSpec> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreEpisodeRepository] Firestore is unavailable.');
    const parsed = parseEpisodeSpec(record);

    try {
      await db.collection(this.collectionName).doc(parsed.id).set(
        sanitizeForFirestore(parsed),
        { merge: false }
      );
      return parsed;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async getEpisode(id: string): Promise<EpisodeSpec | null> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreEpisodeRepository] Firestore is unavailable.');
    const safeId = String(id || '').trim();
    if (!safeId) return null;

    try {
      const snap = await db.collection(this.collectionName).doc(safeId).get();
      if (!snap.exists) return null;
      return parseEpisodeSpec({ ...(snap.data() as EpisodeSpec), id: safeId });
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async listEpisodes(limitCount = 50): Promise<EpisodeSpec[]> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreEpisodeRepository] Firestore is unavailable.');

    try {
      const snapshot = await db
        .collection(this.collectionName)
        .orderBy('updatedAt', 'desc')
        .limit(Math.max(1, Math.min(100, limitCount)))
        .get();
      const records: EpisodeSpec[] = [];
      snapshot.forEach((docSnap) => {
        records.push(parseEpisodeSpec({ ...(docSnap.data() as EpisodeSpec), id: docSnap.id }));
      });
      return records;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }
}

export const firestoreEpisodeRepository = new FirestoreEpisodeRepository();
