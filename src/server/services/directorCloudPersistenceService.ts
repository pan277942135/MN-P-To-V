import {
  DIRECTOR_CLOUD_SCHEMA,
  firestoreDirectorProjectRepository,
  type DirectorCloudProjectRecord,
  type DirectorCloudSnapshot,
} from '../repositories/firestoreDirectorProjectRepository';
import { directorGcsStore, type DirectorCloudAssetRef } from '../storage/directorGcsStore';
import {
  assetRegistrySyncService,
  type AssetRegistrySyncServiceLike,
} from './assetRegistry/assetRegistrySyncService';

export interface DirectorPersistenceRepositoryLike {
  isAvailable(): boolean;
  upsertSnapshot(snapshot: DirectorCloudSnapshot): Promise<DirectorCloudProjectRecord>;
  getSnapshot(projectId: string, episodeId?: string): Promise<DirectorCloudProjectRecord | null>;
  getLatestSnapshot(): Promise<DirectorCloudProjectRecord | null>;
}

export interface DirectorAssetStoreLike {
  putKeyframe(input: {
    projectId: string;
    episodeId: string;
    shotUid: string;
    blobKey: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<DirectorCloudAssetRef>;
  getAsset(ref: Pick<DirectorCloudAssetRef, 'bucket' | 'objectPath'>): Promise<{ buffer: Buffer; mimeType: string }>;
}

export interface DirectorAssetUploadInput {
  shotUid: string;
  blobKey: string;
  mimeType: string;
  base64: string;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function validSnapshot(input: any): DirectorCloudSnapshot {
  if (!input || input.schema !== DIRECTOR_CLOUD_SCHEMA) throw new Error('DIRECTOR_CLOUD_SCHEMA_INVALID');
  const projectId = clean(input.projectId);
  const episodeId = clean(input.episodeId);
  if (!projectId || !episodeId) throw new Error('DIRECTOR_PROJECT_EPISODE_ID_REQUIRED');
  return {
    schema: DIRECTOR_CLOUD_SCHEMA,
    projectId,
    episodeId,
    seriesTitle: clean(input.seriesTitle),
    projectTitle: clean(input.projectTitle),
    clientUpdatedAt: Number(input.clientUpdatedAt || 0),
    stages: input.stages && typeof input.stages === 'object' && !Array.isArray(input.stages)
      ? clone(input.stages)
      : {},
  };
}

function currentAssetKeys(snapshot: DirectorCloudSnapshot) {
  const manifest = snapshot.stages?.keyframeAssets as any;
  const items = Array.isArray(manifest?.assets) ? manifest.assets : [];
  return new Set(items
    .filter((item: any) => clean(item?.shotUid) && clean(item?.blobKey))
    .map((item: any) => `${clean(item.shotUid)}:${clean(item.blobKey)}`));
}

function cloudAssetItems(snapshot: DirectorCloudSnapshot): DirectorCloudAssetRef[] {
  const cloudStage = snapshot.stages?.keyframeCloudAssets as { items?: DirectorCloudAssetRef[] } | undefined;
  return Array.isArray(cloudStage?.items) ? cloudStage.items : [];
}

export class DirectorCloudPersistenceService {
  constructor(
    private readonly repository: DirectorPersistenceRepositoryLike = firestoreDirectorProjectRepository,
    private readonly assetStore: DirectorAssetStoreLike = directorGcsStore,
    private readonly assetRegistry: AssetRegistrySyncServiceLike = assetRegistrySyncService,
  ) {}

  isAvailable() {
    return this.repository.isAvailable();
  }

  async sync(snapshotInput: unknown, uploadsInput: unknown): Promise<DirectorCloudProjectRecord> {
    const snapshot = validSnapshot(snapshotInput);
    const existingCloud = cloudAssetItems(snapshot);
    const byKey = new Map(existingCloud.map((item) => [`${clean(item.shotUid)}:${clean(item.blobKey)}`, clone(item)]));
    const uploads = Array.isArray(uploadsInput) ? uploadsInput.slice(0, 30) : [];

    for (const raw of uploads) {
      const upload = raw as DirectorAssetUploadInput;
      const shotUid = clean(upload?.shotUid);
      const blobKey = clean(upload?.blobKey);
      const mimeType = clean(upload?.mimeType) || 'image/png';
      const base64 = clean(upload?.base64);
      if (!shotUid || !blobKey || !base64) continue;
      const buffer = Buffer.from(base64, 'base64');
      if (!buffer.length) continue;
      if (buffer.length > 15 * 1024 * 1024) throw new Error(`DIRECTOR_KEYFRAME_TOO_LARGE:${shotUid}`);
      const ref = await this.assetStore.putKeyframe({
        projectId: snapshot.projectId,
        episodeId: snapshot.episodeId,
        shotUid,
        blobKey,
        mimeType,
        buffer,
      });
      byKey.set(`${shotUid}:${blobKey}`, ref);
    }

    const allowed = currentAssetKeys(snapshot);
    const items = [...byKey.entries()]
      .filter(([key]) => allowed.has(key))
      .map(([, value]) => value)
      .sort((a, b) => a.shotUid.localeCompare(b.shotUid));
    snapshot.stages.keyframeCloudAssets = {
      version: 'director-keyframe-cloud-assets-v0.4.0',
      items,
      savedAt: Date.now(),
    };

    const record = await this.repository.upsertSnapshot(snapshot);
    // Director Cloud already owns the production snapshot. Asset Registry is a
    // projection used for cross-project discovery, so an indexing failure is
    // logged and deliberately does not fail the cloud persistence request.
    await this.assetRegistry.syncLegacySnapshotAssets({ snapshot }).catch((error) => {
      console.warn('[Asset Registry] Director Cloud snapshot indexing skipped:', error instanceof Error ? error.message : String(error));
    });
    return record;
  }

  get(projectId: string, episodeId?: string) {
    return this.repository.getSnapshot(projectId, episodeId);
  }

  latest() {
    return this.repository.getLatestSnapshot();
  }

  async getKeyframeAsset(projectId: string, episodeId: string, shotUid: string, blobKey?: string) {
    const record = await this.repository.getSnapshot(projectId, episodeId);
    if (!record) return null;
    const items = cloudAssetItems(record.snapshot);
    const ref = items.find((item) => item.shotUid === shotUid && (!blobKey || item.blobKey === blobKey));
    if (!ref) return null;
    const file = await this.assetStore.getAsset(ref);
    return { ...file, ref };
  }
}

export function createDefaultDirectorCloudPersistenceService() {
  return new DirectorCloudPersistenceService();
}
