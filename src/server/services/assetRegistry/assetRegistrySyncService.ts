import crypto from 'node:crypto';
import type { ShotSpec } from '../../../domain/episode/episodeTypes';
import {
  DIRECTOR_ASSET_COLLECTION,
  assetSummary,
  type DirectorAssetRecord,
  type DirectorAssetReviewStatus,
} from '../../../services/assetRegistry/assetRegistryTypes';
import {
  directorAssetRepository,
  type DirectorAssetRepositoryLike,
} from '../../repositories/directorAssetRepository';
import {
  firestoreDirectorProjectRepository,
  type DirectorCloudSnapshot,
} from '../../repositories/firestoreDirectorProjectRepository';
import { getFirestoreInstance } from '../../db/firestore';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function createdAt(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
}

function aspectRatio(width: number, height: number): string {
  if (!width || !height) return '';
  let left = Math.round(width);
  let right = Math.round(height);
  while (right) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left > 0 ? `${Math.round(width) / left}:${Math.round(height) / left}` : '';
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function parseGsUri(value: unknown): { bucket: string; path: string } {
  const uri = clean(value);
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/i);
  return match ? { bucket: match[1], path: match[2] } : { bucket: '', path: '' };
}

function reviewStatus(value: unknown): DirectorAssetReviewStatus {
  return String(value || '').toUpperCase() === 'PASS' ? 'APPROVED' : 'PENDING';
}

function characterIds(...values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      result.push(...value.map(clean).filter(Boolean));
    } else if (clean(value)) {
      result.push(clean(value));
    }
  }
  return [...new Set(result)].slice(0, 100);
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function baseRelations(shot: Partial<ShotSpec> | Record<string, any>, extra: Record<string, any> = {}) {
  const scene = objectValue(shot.scene);
  return {
    characters: characterIds(
      extra.characters,
      extra.characterId,
      objectValue(shot.keyframe).characterId,
      objectValue(shot.video).characterId,
      (shot as any).characterId,
    ),
    scene: clean(extra.scene) || clean(scene.location),
    description: clean(extra.description) || clean(scene.description) || clean(shot.action),
    shotPurpose: clean(extra.shotPurpose) || clean(shot.title) || clean((shot as any).shotUid) || clean((shot as any).shotId),
  };
}

function canonicalKeyframeAsset(input: {
  projectId: string;
  shot: ShotSpec;
  sourceType?: string;
}): DirectorAssetRecord | null {
  const keyframe = input.shot.keyframe;
  const assetId = clean(keyframe.assetId);
  const bucket = clean(keyframe.outputBucket);
  const path = clean(keyframe.outputObjectPath);
  if (!assetId || !bucket || !path) return null;

  const width = numberOrZero(keyframe.width);
  const height = numberOrZero(keyframe.height);
  return {
    assetId,
    projectId: input.projectId,
    episodeId: clean(input.shot.episodeId),
    shotUid: clean(input.shot.shotId),
    assetType: 'IMAGE',
    mediaType: 'KEYFRAME',
    status: 'ACTIVE',
    storage: {
      provider: 'GCS',
      bucket,
      path,
      thumbnailPath: '',
      previewPath: '',
    },
    metadata: {
      width,
      height,
      aspectRatio: aspectRatio(width, height),
      durationSeconds: 0,
      fileSize: numberOrZero(keyframe.sizeBytes),
      mimeType: clean(keyframe.mimeType),
    },
    source: {
      type: clean(input.sourceType) || 'KEYFRAME_ASSET',
      sourceId: assetId,
      createdAt: createdAt(keyframe.persistedAt || input.shot.updatedAt),
      createdBy: 'system',
    },
    relations: baseRelations(input.shot),
    review: {
      status: reviewStatus(keyframe.status),
      score: 0,
      notes: '',
    },
  };
}

export interface VideoAssetRegistryInput {
  projectId?: string;
  shot: ShotSpec;
  sourceType?: string;
  artifact?: {
    assetId?: string;
    outputBucket?: string;
    outputObjectPath?: string;
    videoUrl?: string;
    downloadUrl?: string;
    sizeBytes?: number;
    mimeType?: string;
    durationSeconds?: number;
  };
}

function canonicalVideoAsset(input: VideoAssetRegistryInput, projectId: string): DirectorAssetRecord | null {
  const video = input.shot.video;
  const artifact = input.artifact || {};
  const videoUrl = clean(artifact.videoUrl) || clean(video.artifactUrl);
  const parsedUri = parseGsUri(videoUrl);
  const bucket = clean(video.outputBucket) || clean(artifact.outputBucket) || parsedUri.bucket;
  const path = clean(video.outputObjectPath) || clean(artifact.outputObjectPath) || parsedUri.path || videoUrl;
  const assetId = clean(video.assetId) || clean(artifact.assetId) || clean(video.generationTaskId);
  if (!assetId || !input.shot.episodeId || !input.shot.shotId) return null;

  return {
    assetId,
    projectId,
    episodeId: clean(input.shot.episodeId),
    shotUid: clean(input.shot.shotId),
    assetType: 'VIDEO',
    mediaType: 'GENERATED_VIDEO',
    status: 'ACTIVE',
    storage: {
      provider: 'GCS',
      bucket,
      path,
      thumbnailPath: '',
      previewPath: videoUrl || clean(artifact.downloadUrl),
    },
    metadata: {
      width: 0,
      height: 0,
      aspectRatio: '',
      durationSeconds: numberOrZero(artifact.durationSeconds) || numberOrZero(input.shot.durationSeconds),
      fileSize: numberOrZero(artifact.sizeBytes),
      mimeType: clean(artifact.mimeType) || 'video/mp4',
    },
    source: {
      type: clean(input.sourceType) || 'VEO_GENERATED',
      sourceId: assetId,
      createdAt: createdAt(input.shot.completedAt || input.shot.updatedAt),
      createdBy: 'system',
    },
    relations: baseRelations(input.shot),
    review: {
      status: reviewStatus(video.status),
      score: 0,
      notes: '',
    },
  };
}

export interface KeyframeAssetRegistryInput {
  projectId?: string;
  shot: ShotSpec;
  sourceType?: string;
}

export interface AssetRegistryProjectResolverLike {
  resolveProjectIdForEpisode(episodeId: string): Promise<string | null>;
}

class FirestoreAssetRegistryProjectResolver implements AssetRegistryProjectResolverLike {
  async resolveProjectIdForEpisode(episodeIdInput: string): Promise<string | null> {
    const episodeId = clean(episodeIdInput);
    const db = getFirestoreInstance();
    if (!episodeId || !db) return null;
    try {
      const result = await db.collection('director_projects')
        .where('activeEpisodeId', '==', episodeId)
        .limit(1)
        .get();
      return result.docs[0]?.id || null;
    } catch (error) {
      console.warn('[Asset Registry] project lookup skipped:', error instanceof Error ? error.message : String(error));
      return null;
    }
  }
}

export interface AssetRegistrySyncServiceLike {
  isAvailable(): boolean;
  registerAsset(asset: DirectorAssetRecord): Promise<DirectorAssetRecord>;
  syncToAssetRegistry(asset: DirectorAssetRecord): Promise<DirectorAssetRecord | null>;
  syncKeyframeAsset(input: KeyframeAssetRegistryInput): Promise<DirectorAssetRecord | null>;
  syncVideoAsset(input: VideoAssetRegistryInput): Promise<DirectorAssetRecord | null>;
  syncLegacySnapshotAssets(input: {
    snapshot: DirectorCloudSnapshot;
    cloudAssets?: Array<Record<string, any>>;
  }): Promise<DirectorAssetRecord[]>;
  syncProjectAssets(projectId: string, episodeId?: string): Promise<DirectorAssetRecord[]>;
}

export class AssetRegistrySyncService implements AssetRegistrySyncServiceLike {
  constructor(
    private readonly repository: DirectorAssetRepositoryLike = directorAssetRepository,
    private readonly projectResolver: AssetRegistryProjectResolverLike = new FirestoreAssetRegistryProjectResolver(),
  ) {}

  public isAvailable(): boolean {
    return this.repository.isAvailable();
  }

  public async registerAsset(asset: DirectorAssetRecord): Promise<DirectorAssetRecord> {
    if (!this.repository.isAvailable()) throw new Error('DIRECTOR_ASSET_FIRESTORE_UNAVAILABLE');
    const existing = await this.repository.getAsset(asset.assetId);
    if (!existing) return this.repository.createAsset(asset);
    const { assetId: _assetId, ...patch } = asset;
    const updated = await this.repository.updateAsset(asset.assetId, {
      ...patch,
      // A human review decision is authoritative and must survive re-sync.
      review: existing.review,
    });
    return updated || asset;
  }

  /** Strict registration entry point used by the explicit internal API. */
  public async syncToAssetRegistry(asset: DirectorAssetRecord): Promise<DirectorAssetRecord | null> {
    try {
      return await this.registerAsset(asset);
    } catch (error) {
      console.warn(`[Asset Registry] best-effort registration skipped for ${asset.assetId}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private async projectIdFor(inputProjectId: unknown, episodeId: string): Promise<string> {
    const explicit = clean(inputProjectId);
    if (explicit) return explicit;
    return clean(await this.projectResolver.resolveProjectIdForEpisode(episodeId));
  }

  public async syncKeyframeAsset(input: KeyframeAssetRegistryInput): Promise<DirectorAssetRecord | null> {
    const projectId = await this.projectIdFor(input.projectId, input.shot.episodeId);
    if (!projectId) return null;
    const asset = canonicalKeyframeAsset({ ...input, projectId });
    return asset ? this.syncToAssetRegistry(asset) : null;
  }

  public async syncVideoAsset(input: VideoAssetRegistryInput): Promise<DirectorAssetRecord | null> {
    const projectId = await this.projectIdFor(input.projectId, input.shot.episodeId);
    if (!projectId) return null;
    const asset = canonicalVideoAsset(input, projectId);
    return asset ? this.syncToAssetRegistry(asset) : null;
  }

  public async syncLegacySnapshotAssets(input: {
    snapshot: DirectorCloudSnapshot;
    cloudAssets?: Array<Record<string, any>>;
  }): Promise<DirectorAssetRecord[]> {
    const snapshot = input.snapshot;
    const stages = objectValue(snapshot.stages);
    const manifest = objectValue(stages.keyframeAssets);
    const storyboard = objectValue(stages.storyboard);
    const manifestAssets = Array.isArray(manifest.assets) ? manifest.assets : [];
    const storyboardShots = Array.isArray(storyboard.shots) ? storyboard.shots : [];
    const cloudAssets = Array.isArray(input.cloudAssets)
      ? input.cloudAssets
      : Array.isArray(objectValue(stages.keyframeCloudAssets).items)
        ? objectValue(stages.keyframeCloudAssets).items
        : [];
    const results: DirectorAssetRecord[] = [];

    for (const raw of cloudAssets) {
      const cloud = objectValue(raw);
      const shotUid = clean(cloud.shotUid);
      const blobKey = clean(cloud.blobKey);
      const bucket = clean(cloud.bucket);
      const path = clean(cloud.objectPath) || clean(cloud.path);
      if (!shotUid || !blobKey || !bucket || !path) continue;

      const manifestAsset = manifestAssets.find((item: any) => (
        clean(item?.shotUid) === shotUid && clean(item?.blobKey) === blobKey
      )) || {};
      const storyboardShot = storyboardShots.find((item: any) => clean(item?.uid) === shotUid) || {};
      const width = numberOrZero(manifestAsset.width);
      const height = numberOrZero(manifestAsset.height);
      const asset: DirectorAssetRecord = {
        assetId: clean(cloud.assetId) || `legacy_kf_${digest(`${snapshot.projectId}|${snapshot.episodeId}|${shotUid}|${blobKey}`)}`,
        projectId: clean(snapshot.projectId),
        episodeId: clean(snapshot.episodeId),
        shotUid,
        assetType: 'IMAGE',
        mediaType: 'KEYFRAME',
        status: 'ACTIVE',
        storage: {
          provider: 'GCS',
          bucket,
          path,
          thumbnailPath: '',
          previewPath: '',
        },
        metadata: {
          width,
          height,
          aspectRatio: aspectRatio(width, height),
          durationSeconds: 0,
          fileSize: numberOrZero(cloud.sizeBytes) || numberOrZero(manifestAsset.sizeBytes),
          mimeType: clean(cloud.mimeType) || clean(manifestAsset.mimeType),
        },
        source: {
          type: 'DIRECTOR_CLOUD_KEYFRAME',
          sourceId: `${shotUid}:${blobKey}`,
          createdAt: createdAt(cloud.updatedAt || manifestAsset.createdAt || snapshot.clientUpdatedAt),
          createdBy: 'system',
        },
        relations: baseRelations(storyboardShot, {
          characterId: manifestAsset.characterId,
          description: manifestAsset.blueprintPrompt || storyboardShot.action,
          shotPurpose: storyboardShot.title || manifestAsset.shotLabel || shotUid,
        }),
        review: {
          status: reviewStatus(manifestAsset.status),
          score: 0,
          notes: clean(manifestAsset.qaNote),
        },
      };
      const synced = await this.syncToAssetRegistry(asset);
      if (synced) results.push(synced);
    }
    return results;
  }

  public async syncProjectAssets(projectIdInput: string, episodeIdInput?: string): Promise<DirectorAssetRecord[]> {
    const projectId = clean(projectIdInput);
    if (!projectId) return [];
    try {
      const bundle = await firestoreDirectorProjectRepository.getRestoreBundle(projectId, clean(episodeIdInput) || undefined);
      if (!bundle) return [];
      const snapshot: DirectorCloudSnapshot = {
        schema: 'zaojing.director.cloud.v1',
        projectId,
        episodeId: clean(bundle.episode?.episodeId),
        seriesTitle: clean(bundle.project?.seriesTitle),
        projectTitle: clean(bundle.project?.projectTitle),
        clientUpdatedAt: numberOrZero(bundle.episode?.clientUpdatedAt),
        stages: bundle.stages,
      };
      return this.syncLegacySnapshotAssets({ snapshot });
    } catch (error) {
      console.warn(`[Asset Registry] existing project sync skipped for ${projectId}:`, error instanceof Error ? error.message : String(error));
      return [];
    }
  }
}

export const assetRegistrySyncService = new AssetRegistrySyncService();

export const syncToAssetRegistry = (asset: DirectorAssetRecord) => assetRegistrySyncService.syncToAssetRegistry(asset);
export const syncKeyframeAssetToRegistry = (input: KeyframeAssetRegistryInput) => assetRegistrySyncService.syncKeyframeAsset(input);
export const syncVideoAssetToRegistry = (input: VideoAssetRegistryInput) => assetRegistrySyncService.syncVideoAsset(input);

export { DIRECTOR_ASSET_COLLECTION, assetSummary };
