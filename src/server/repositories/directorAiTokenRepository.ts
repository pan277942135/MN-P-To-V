import {
  AI_DIRECTOR_SCOPES,
  AI_TOKEN_STATUSES,
  type AiDirectorScope,
  type AiTokenStatus,
  type DirectorAiTokenRecord,
} from '../../services/aiDirector/aiDirectorTypes';
import { getFirestoreInstance, markFirestoreUnavailable } from '../db/firestore';
import { sanitizeForFirestore } from './firestoreTaskRepository';

export const DIRECTOR_AI_TOKEN_COLLECTION = 'director_ai_tokens' as const;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isoDate(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : '';
}

function scopes(value: unknown): AiDirectorScope[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => clean(item))
    .filter((item): item is AiDirectorScope => AI_DIRECTOR_SCOPES.includes(item as AiDirectorScope)))];
}

export function normalizeDirectorAiToken(input: unknown, fallbackTokenId = ''): DirectorAiTokenRecord {
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const tokenId = clean(raw.tokenId) || clean(fallbackTokenId);
  const projectId = clean(raw.projectId);
  const tokenHash = clean(raw.tokenHash);
  const name = clean(raw.name) || 'AI Director';
  if (!tokenId) throw new Error('DIRECTOR_AI_TOKEN_ID_REQUIRED');
  if (!projectId) throw new Error('DIRECTOR_AI_TOKEN_PROJECT_REQUIRED');
  if (!tokenHash) throw new Error('DIRECTOR_AI_TOKEN_HASH_REQUIRED');
  const scope = scopes(raw.scope);
  if (!scope.length) throw new Error('DIRECTOR_AI_TOKEN_SCOPE_REQUIRED');
  const status = AI_TOKEN_STATUSES.includes(raw.status as AiTokenStatus)
    ? raw.status as AiTokenStatus
    : 'ACTIVE';
  return {
    tokenId,
    projectId,
    tokenHash,
    name,
    scope,
    status,
    createdAt: isoDate(raw.createdAt) || new Date().toISOString(),
    expiresAt: isoDate(raw.expiresAt),
  };
}

export interface DirectorAiTokenRepositoryLike {
  isAvailable(): boolean;
  createToken(record: DirectorAiTokenRecord): Promise<DirectorAiTokenRecord>;
  getToken(tokenId: string): Promise<DirectorAiTokenRecord | null>;
  findByHash(tokenHash: string): Promise<DirectorAiTokenRecord | null>;
  listTokens(projectId: string): Promise<DirectorAiTokenRecord[]>;
  revokeToken(tokenId: string): Promise<boolean>;
}

export class DirectorAiTokenRepository implements DirectorAiTokenRepositoryLike {
  public readonly collectionName = DIRECTOR_AI_TOKEN_COLLECTION;

  public isAvailable(): boolean {
    return Boolean(getFirestoreInstance());
  }

  private handleError(error: unknown): void {
    markFirestoreUnavailable(error);
  }

  public async createToken(recordInput: DirectorAiTokenRecord): Promise<DirectorAiTokenRecord> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_AI_TOKEN_FIRESTORE_UNAVAILABLE');
    const record = normalizeDirectorAiToken(recordInput);
    try {
      const ref = db.collection(this.collectionName).doc(record.tokenId);
      if (typeof (ref as any).create === 'function') await (ref as any).create(sanitizeForFirestore(record));
      else await ref.set(sanitizeForFirestore(record), { merge: false });
      return record;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  public async getToken(tokenIdInput: string): Promise<DirectorAiTokenRecord | null> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_AI_TOKEN_FIRESTORE_UNAVAILABLE');
    const tokenId = clean(tokenIdInput);
    if (!tokenId) return null;
    try {
      const snapshot = await db.collection(this.collectionName).doc(tokenId).get();
      return snapshot.exists ? normalizeDirectorAiToken(snapshot.data(), tokenId) : null;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  public async findByHash(tokenHashInput: string): Promise<DirectorAiTokenRecord | null> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_AI_TOKEN_FIRESTORE_UNAVAILABLE');
    const tokenHash = clean(tokenHashInput);
    if (!tokenHash) return null;
    try {
      const snapshot = await db.collection(this.collectionName)
        .where('tokenHash', '==', tokenHash)
        .limit(1)
        .get();
      const document = snapshot.docs[0];
      return document ? normalizeDirectorAiToken(document.data(), document.id) : null;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  public async listTokens(projectIdInput: string): Promise<DirectorAiTokenRecord[]> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_AI_TOKEN_FIRESTORE_UNAVAILABLE');
    const projectId = clean(projectIdInput);
    if (!projectId) return [];
    try {
      const snapshot = await db.collection(this.collectionName)
        .where('projectId', '==', projectId)
        .get();
      return snapshot.docs
        .map((document) => normalizeDirectorAiToken(document.data(), document.id))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  public async revokeToken(tokenIdInput: string): Promise<boolean> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_AI_TOKEN_FIRESTORE_UNAVAILABLE');
    const tokenId = clean(tokenIdInput);
    if (!tokenId) return false;
    try {
      const ref = db.collection(this.collectionName).doc(tokenId);
      const snapshot = await ref.get();
      if (!snapshot.exists) return false;
      await ref.set({ status: 'REVOKED', updatedAt: new Date().toISOString() }, { merge: true });
      return true;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }
}

export const directorAiTokenRepository = new DirectorAiTokenRepository();
