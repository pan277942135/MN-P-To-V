import {
  DIRECTOR_CLOUD_SCHEMA,
  firestoreDirectorProjectRepository,
  type DirectorCloudProjectRecord,
  type DirectorCloudSnapshot,
} from '../repositories/firestoreDirectorProjectRepository';
import { directorGcsStore, type DirectorCloudAssetRef } from '../storage/directorGcsStore';
import sharp from 'sharp';
import {
  assetRegistrySyncService,
  type AssetRegistrySyncServiceLike,
} from './assetRegistry/assetRegistrySyncService';
import type { DirectorAssetRecord } from '../../services/assetRegistry/assetRegistryTypes';
import {
  calculateAspectRatio,
  hasFormatPolicy,
  normalizeFormatPolicy,
  validateAssetMetadata,
  type AssetValidation,
} from '../../services/formatPolicy/formatPolicy';

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
  width?: number;
  height?: number;
  /** New clients opt into strict INVALID rejection while old clients remain compatible. */
  validate?: boolean;
}

export interface DirectorAssetUploadValidationResult {
  assetId: string;
  shotUid: string;
  blobKey: string;
  validation: AssetValidation;
}

export type DirectorCloudSyncResult = DirectorCloudProjectRecord & {
  assetUploads: DirectorAssetUploadValidationResult[];
};

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
  const formatPolicy = input.formatPolicy || input.stages?.brief?.formatPolicy;
  return {
    schema: DIRECTOR_CLOUD_SCHEMA,
    projectId,
    episodeId,
    seriesTitle: clean(input.seriesTitle),
    projectTitle: clean(input.projectTitle),
    clientUpdatedAt: Number(input.clientUpdatedAt || 0),
    ...(hasFormatPolicy(formatPolicy)
      ? { formatPolicy: normalizeFormatPolicy(formatPolicy) }
      : {}),
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

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

async function imageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  try {
    const metadata = await sharp(buffer).metadata();
    return {
      width: Number(metadata.width || 0),
      height: Number(metadata.height || 0),
    };
  } catch {
    return { width: 0, height: 0 };
  }
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

  async sync(snapshotInput: unknown, uploadsInput: unknown): Promise<DirectorCloudSyncResult> {
    const snapshot = validSnapshot(snapshotInput);
    const existingCloud = cloudAssetItems(snapshot);
    const byKey = new Map(existingCloud.map((item) => [`${clean(item.shotUid)}:${clean(item.blobKey)}`, clone(item)]));
    const uploads = Array.isArray(uploadsInput) ? uploadsInput.slice(0, 30) : [];
    const brief = objectValue(snapshot.stages?.brief);
    const storyboard = objectValue(snapshot.stages?.storyboard);
    const episodePolicyStage = objectValue(snapshot.stages?.episodeFormatPolicy);
    const episodePolicy = episodePolicyStage.formatPolicy
      || (hasFormatPolicy(episodePolicyStage) ? episodePolicyStage : objectValue(snapshot.stages?.episode).formatPolicy);
    const projectPolicy = snapshot.formatPolicy || brief.formatPolicy;
    const uploadValidations = new Map<string, AssetValidation>();

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
      // Always inspect the uploaded bytes. Client-supplied dimensions are kept
      // as an input compatibility field, but cannot turn a corrupt payload into
      // a VALID media asset.
      const detected = await imageDimensions(buffer);
      const storyboardShot = Array.isArray(storyboard.shots)
        ? storyboard.shots.find((item: any) => clean(item?.uid) === shotUid)
        : undefined;
      const validation = validateAssetMetadata({
        width: detected.width,
        height: detected.height,
        mimeType,
        assetType: 'IMAGE',
        projectPolicy,
        episodePolicy,
        shotOverride: storyboardShot?.formatPolicy,
      });
      uploadValidations.set(`${shotUid}:${blobKey}`, validation);
      // The browser's new upload path opts into this guard. Legacy clients that
      // do not send `validate` retain their existing persistence behavior.
      if (upload.validate === true && validation.status === 'INVALID') continue;
      const ref = await this.assetStore.putKeyframe({
        projectId: snapshot.projectId,
        episodeId: snapshot.episodeId,
        shotUid,
        blobKey,
        mimeType,
        buffer,
      });
      byKey.set(`${shotUid}:${blobKey}`, {
        ...ref,
        width: detected.width || ref.width,
        height: detected.height || ref.height,
        aspectRatio: validation.actualAspectRatio || ref.aspectRatio || calculateAspectRatio(detected.width, detected.height),
      });
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
    let registeredAssets: DirectorAssetRecord[] = [];
    await this.assetRegistry.syncLegacySnapshotAssets({ snapshot }).then((assets) => {
      registeredAssets = assets;
    }).catch((error) => {
      console.warn('[Asset Registry] Director Cloud snapshot indexing skipped:', error instanceof Error ? error.message : String(error));
    });
    const registeredBySource = new Map(registeredAssets.map((asset) => [asset.source.sourceId, asset]));
    const uploadResults: DirectorAssetUploadValidationResult[] = uploads
      .map((raw) => raw as DirectorAssetUploadInput)
      .map((upload) => {
        const shotUid = clean(upload?.shotUid);
        const blobKey = clean(upload?.blobKey);
        const sourceId = `${shotUid}:${blobKey}`;
        const validation = uploadValidations.get(sourceId) || validateAssetMetadata({
          width: upload?.width,
          height: upload?.height,
          mimeType: upload?.mimeType,
          assetType: 'IMAGE',
          projectPolicy,
          episodePolicy,
        });
        return {
          assetId: registeredBySource.get(sourceId)?.assetId || '',
          shotUid,
          blobKey,
          validation,
        };
      })
      .filter((item) => item.shotUid && item.blobKey);
    return { ...record, assetUploads: uploadResults };
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
