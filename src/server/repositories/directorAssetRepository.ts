import {
  DIRECTOR_ASSET_COLLECTION,
  isDirectorAssetReviewStatus,
  isDirectorAssetStatus,
  isDirectorAssetType,
  type DirectorAssetListFilters,
  type DirectorAssetPatch,
  type DirectorAssetRecord,
  type DirectorAssetReview,
  type DirectorAssetRelations,
  type DirectorAssetSource,
  type DirectorAssetStorage,
  type DirectorAssetMetadata,
} from '../../services/assetRegistry/assetRegistryTypes';
import { getFirestoreInstance, isFirestoreAvailable, markFirestoreUnavailable } from '../db/firestore';
import { sanitizeForFirestore } from './firestoreTaskRepository';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function isoDate(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(clean).filter(Boolean).slice(0, 100);
}

function normalizeStorage(value: unknown): DirectorAssetStorage {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    provider: clean(raw.provider) || 'GCS',
    bucket: clean(raw.bucket),
    // objectPath is accepted as a compatibility alias for existing GCS records,
    // while `path` remains the canonical Asset Registry field.
    path: clean(raw.path) || clean(raw.objectPath),
    thumbnailPath: clean(raw.thumbnailPath),
    previewPath: clean(raw.previewPath),
  };
}

function normalizeMetadata(value: unknown): DirectorAssetMetadata {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    width: numberOrZero(raw.width),
    height: numberOrZero(raw.height),
    aspectRatio: clean(raw.aspectRatio),
    durationSeconds: numberOrZero(raw.durationSeconds),
    fileSize: numberOrZero(raw.fileSize ?? raw.sizeBytes),
    mimeType: clean(raw.mimeType),
  };
}

function normalizeSource(value: unknown): DirectorAssetSource {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    type: clean(raw.type) || 'UNKNOWN',
    sourceId: clean(raw.sourceId),
    createdAt: isoDate(raw.createdAt),
    createdBy: clean(raw.createdBy) || 'system',
  };
}

function normalizeRelations(value: unknown): DirectorAssetRelations {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    characters: stringArray(raw.characters),
    scene: clean(raw.scene),
    description: clean(raw.description),
    shotPurpose: clean(raw.shotPurpose),
  };
}

function normalizeReview(value: unknown): DirectorAssetReview {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const status = isDirectorAssetReviewStatus(raw.status) ? raw.status : 'PENDING';
  return {
    status,
    score: Math.min(100, numberOrZero(raw.score)),
    notes: clean(raw.notes),
  };
}

export function normalizeDirectorAsset(input: unknown, fallbackAssetId = ''): DirectorAssetRecord {
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, any>
    : {};
  const assetId = clean(raw.assetId) || clean(fallbackAssetId);
  const projectId = clean(raw.projectId);
  const episodeId = clean(raw.episodeId);
  const shotUid = clean(raw.shotUid);
  if (!assetId) throw new Error('DIRECTOR_ASSET_ID_REQUIRED');
  if (!projectId || !episodeId || !shotUid) {
    throw new Error('DIRECTOR_ASSET_SCOPE_REQUIRED');
  }
  if (!isDirectorAssetType(raw.assetType)) throw new Error('DIRECTOR_ASSET_TYPE_INVALID');

  const status = isDirectorAssetStatus(raw.status) ? raw.status : 'ACTIVE';
  const mediaType = clean(raw.mediaType);
  if (!mediaType) throw new Error('DIRECTOR_ASSET_MEDIA_TYPE_REQUIRED');

  return {
    assetId,
    projectId,
    episodeId,
    shotUid,
    assetType: raw.assetType,
    mediaType: mediaType as DirectorAssetRecord['mediaType'],
    status,
    storage: normalizeStorage(raw.storage),
    metadata: normalizeMetadata(raw.metadata),
    source: normalizeSource(raw.source),
    relations: normalizeRelations(raw.relations),
    review: normalizeReview(raw.review),
    updatedAt: numberOrZero(raw.updatedAt) || Date.now(),
  };
}

function mergeAsset(current: DirectorAssetRecord, patch: DirectorAssetPatch): DirectorAssetRecord {
  const rawPatch = patch as Record<string, any>;
  return normalizeDirectorAsset({
    ...current,
    ...rawPatch,
    assetId: current.assetId,
    storage: { ...current.storage, ...(rawPatch.storage || {}) },
    metadata: { ...current.metadata, ...(rawPatch.metadata || {}) },
    source: { ...current.source, ...(rawPatch.source || {}) },
    relations: { ...current.relations, ...(rawPatch.relations || {}) },
    review: { ...current.review, ...(rawPatch.review || {}) },
    updatedAt: Date.now(),
  });
}

export interface DirectorAssetRepositoryLike {
  isAvailable(): boolean;
  createAsset(asset: DirectorAssetRecord): Promise<DirectorAssetRecord>;
  getAsset(assetId: string): Promise<DirectorAssetRecord | null>;
  listAssets(filters?: DirectorAssetListFilters): Promise<DirectorAssetRecord[]>;
  listShotAssets(shotUid: string, projectId?: string): Promise<DirectorAssetRecord[]>;
  updateAsset(assetId: string, patch: DirectorAssetPatch): Promise<DirectorAssetRecord | null>;
  deleteAsset(assetId: string): Promise<boolean>;
}

export class DirectorAssetRepository implements DirectorAssetRepositoryLike {
  public readonly collectionName = DIRECTOR_ASSET_COLLECTION;

  public isAvailable(): boolean {
    return isFirestoreAvailable();
  }

  private handleError(error: any): void {
    const code = error?.code;
    const status = error?.status || error?.statusCode;
    const message = String(error?.message || error || '');
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
      markFirestoreUnavailable(error);
    }
  }

  public async createAsset(assetInput: DirectorAssetRecord): Promise<DirectorAssetRecord> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_ASSET_FIRESTORE_UNAVAILABLE');
    const asset = normalizeDirectorAsset(assetInput);
    try {
      const ref = db.collection(this.collectionName).doc(asset.assetId);
      const payload = sanitizeForFirestore(asset);
      if (typeof (ref as any).create === 'function') await (ref as any).create(payload);
      else await ref.set(payload, { merge: false });
      return asset;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  public async getAsset(assetIdInput: string): Promise<DirectorAssetRecord | null> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_ASSET_FIRESTORE_UNAVAILABLE');
    const assetId = clean(assetIdInput);
    if (!assetId) return null;
    try {
      const snap = await db.collection(this.collectionName).doc(assetId).get();
      return snap.exists ? normalizeDirectorAsset(snap.data(), assetId) : null;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  public async listAssets(filters: DirectorAssetListFilters = {}): Promise<DirectorAssetRecord[]> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_ASSET_FIRESTORE_UNAVAILABLE');
    try {
      let query: any = db.collection(this.collectionName);
      // Keep optional filtering in application memory after one project/shot query.
      // This avoids requiring a new composite Firestore index for every UI filter.
      if (clean(filters.projectId)) query = query.where('projectId', '==', clean(filters.projectId));
      if (clean(filters.shotUid)) query = query.where('shotUid', '==', clean(filters.shotUid));
      const snapshot = await query.get();
      const assets = snapshot.docs
        .map((doc: any) => normalizeDirectorAsset(doc.data(), doc.id))
        .filter((asset: DirectorAssetRecord) => (
          (!filters.episodeId || asset.episodeId === filters.episodeId) &&
          (!filters.assetType || asset.assetType === filters.assetType) &&
          (!filters.mediaType || asset.mediaType === filters.mediaType) &&
          (!filters.status || asset.status === filters.status)
        ));
      return assets.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  public async listShotAssets(shotUidInput: string, projectId?: string): Promise<DirectorAssetRecord[]> {
    const shotUid = clean(shotUidInput);
    if (!shotUid) return [];
    return this.listAssets({ shotUid, projectId: clean(projectId) || undefined });
  }

  public async updateAsset(assetIdInput: string, patch: DirectorAssetPatch): Promise<DirectorAssetRecord | null> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_ASSET_FIRESTORE_UNAVAILABLE');
    const assetId = clean(assetIdInput);
    if (!assetId) return null;
    try {
      const ref = db.collection(this.collectionName).doc(assetId);
      const currentSnap = await ref.get();
      if (!currentSnap.exists) return null;
      const current = normalizeDirectorAsset(currentSnap.data(), assetId);
      const next = mergeAsset(current, patch);
      await ref.set(sanitizeForFirestore(next), { merge: false });
      return next;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  public async deleteAsset(assetIdInput: string): Promise<boolean> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_ASSET_FIRESTORE_UNAVAILABLE');
    const assetId = clean(assetIdInput);
    if (!assetId) return false;
    try {
      const ref = db.collection(this.collectionName).doc(assetId);
      const current = await ref.get();
      if (!current.exists) return false;
      await ref.delete();
      return true;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }
}

export const directorAssetRepository = new DirectorAssetRepository();
