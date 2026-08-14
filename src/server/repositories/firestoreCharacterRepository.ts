import type { IdentitySpec } from '../../types';
import { getFirestoreInstance, isFirestoreAvailable, markFirestoreUnavailable } from '../db/firestore';
import { sanitizeForFirestore } from './firestoreTaskRepository';

export interface DurableCharacterReference {
  id: string;
  outputBucket: string;
  outputObjectPath: string;
  mimeType: string;
  width: number;
  height: number;
  angle?: string;
  sortOrder: number;
  sizeBytes?: number;
}

export interface DurableCharacterRecord {
  id: string;
  name: string;
  description: string;
  identitySpec: IdentitySpec;
  adultConfirmed: boolean;
  rightsConfirmed: boolean;
  status: 'ready';
  referenceImages: DurableCharacterReference[];
  createdAt: number;
  updatedAt: number;
  evidenceSource: 'firestore';
}

export class FirestoreCharacterRepository {
  private readonly collectionName = 'characters';

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

  public async upsertCharacter(record: DurableCharacterRecord): Promise<DurableCharacterRecord> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreCharacterRepository] Firestore is unavailable.');
    if (!record.id) throw new Error('[FirestoreCharacterRepository] Missing character id.');

    try {
      const docRef = db.collection(this.collectionName).doc(record.id);
      const payload = sanitizeForFirestore({
        ...record,
        id: record.id,
        evidenceSource: 'firestore',
        updatedAt: record.updatedAt || Date.now(),
        createdAt: record.createdAt || Date.now(),
      });
      await docRef.set(payload, { merge: false });
      return { ...record, evidenceSource: 'firestore' };
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async getCharacter(id: string): Promise<DurableCharacterRecord | null> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreCharacterRepository] Firestore is unavailable.');
    if (!id) return null;

    try {
      const snap = await db.collection(this.collectionName).doc(id).get();
      if (!snap.exists) return null;
      return {
        ...(snap.data() as DurableCharacterRecord),
        id,
        evidenceSource: 'firestore',
      };
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async listCharacters(limitCount = 100): Promise<DurableCharacterRecord[]> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreCharacterRepository] Firestore is unavailable.');

    try {
      const snapshot = await db
        .collection(this.collectionName)
        .orderBy('updatedAt', 'desc')
        .limit(Math.max(1, Math.min(100, limitCount)))
        .get();
      const records: DurableCharacterRecord[] = [];
      snapshot.forEach((docSnap) => {
        records.push({
          ...(docSnap.data() as DurableCharacterRecord),
          id: docSnap.id,
          evidenceSource: 'firestore',
        });
      });
      return records;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }

  public async deleteCharacter(id: string): Promise<boolean> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('[FirestoreCharacterRepository] Firestore is unavailable.');
    if (!id) return false;

    try {
      const ref = db.collection(this.collectionName).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return false;
      await ref.delete();
      return true;
    } catch (err) {
      this.handleError(err);
      throw err;
    }
  }
}

export const firestoreCharacterRepository = new FirestoreCharacterRepository();
