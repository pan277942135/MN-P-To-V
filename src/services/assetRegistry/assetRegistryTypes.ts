export const DIRECTOR_ASSET_COLLECTION = 'director_assets' as const;

export type DirectorAssetType = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT' | 'MODEL';

export type DirectorAssetStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETED';

export type DirectorImageMediaType =
  | 'CHARACTER_MASTER'
  | 'SCENE_MASTER'
  | 'KEYFRAME'
  | 'REFERENCE';

export type DirectorVideoMediaType =
  | 'GENERATED_VIDEO'
  | 'RAW_VIDEO'
  | 'PREVIEW_VIDEO'
  | 'FINAL_RENDER';

export type DirectorAudioMediaType = 'VOICE' | 'BGM' | 'SFX' | 'AMBIENT';

export type DirectorMediaType =
  | DirectorImageMediaType
  | DirectorVideoMediaType
  | DirectorAudioMediaType
  | 'TEXT'
  | 'MODEL';

export type DirectorAssetReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface DirectorAssetStorage {
  provider: string;
  bucket: string;
  path: string;
  thumbnailPath: string;
  previewPath: string;
}

export interface DirectorAssetMetadata {
  width: number;
  height: number;
  aspectRatio: string;
  durationSeconds: number;
  fileSize: number;
  mimeType: string;
}

export interface DirectorAssetSource {
  type: string;
  sourceId: string;
  createdAt: string;
  createdBy: string;
}

export interface DirectorAssetRelations {
  characters: string[];
  scene: string;
  description: string;
  shotPurpose: string;
}

export interface DirectorAssetReview {
  status: DirectorAssetReviewStatus;
  score: number;
  notes: string;
}

/**
 * Canonical cross-production asset index record.
 *
 * The production Shot/Blueprint documents remain authoritative for execution.
 * This record is a query-friendly projection and must never replace them.
 */
export interface DirectorAssetRecord {
  assetId: string;
  projectId: string;
  episodeId: string;
  shotUid: string;
  assetType: DirectorAssetType;
  mediaType: DirectorMediaType;
  status: DirectorAssetStatus;
  storage: DirectorAssetStorage;
  metadata: DirectorAssetMetadata;
  source: DirectorAssetSource;
  relations: DirectorAssetRelations;
  review: DirectorAssetReview;
  updatedAt?: number;
}

export interface DirectorAssetListFilters {
  projectId?: string;
  episodeId?: string;
  shotUid?: string;
  assetType?: DirectorAssetType | string;
  mediaType?: DirectorMediaType | string;
  status?: DirectorAssetStatus | string;
}

export type DirectorAssetPatch = {
  projectId?: string;
  episodeId?: string;
  shotUid?: string;
  assetType?: DirectorAssetType;
  mediaType?: DirectorMediaType;
  status?: DirectorAssetStatus;
  review?: Partial<DirectorAssetReview>;
  storage?: Partial<DirectorAssetStorage>;
  metadata?: Partial<DirectorAssetMetadata>;
  source?: Partial<DirectorAssetSource>;
  relations?: Partial<DirectorAssetRelations>;
  updatedAt?: number;
};

export interface DirectorAssetSummary {
  total: number;
  images: number;
  videos: number;
  audio: number;
  text: number;
  models: number;
  shotsCovered: number;
}

export const DIRECTOR_ASSET_TYPES: readonly DirectorAssetType[] = [
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'TEXT',
  'MODEL',
];

export const DIRECTOR_ASSET_STATUSES: readonly DirectorAssetStatus[] = [
  'ACTIVE',
  'ARCHIVED',
  'DELETED',
];

export const DIRECTOR_ASSET_REVIEW_STATUSES: readonly DirectorAssetReviewStatus[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
];

export function isDirectorAssetType(value: unknown): value is DirectorAssetType {
  return typeof value === 'string' && DIRECTOR_ASSET_TYPES.includes(value as DirectorAssetType);
}

export function isDirectorAssetStatus(value: unknown): value is DirectorAssetStatus {
  return typeof value === 'string' && DIRECTOR_ASSET_STATUSES.includes(value as DirectorAssetStatus);
}

export function isDirectorAssetReviewStatus(value: unknown): value is DirectorAssetReviewStatus {
  return typeof value === 'string'
    && DIRECTOR_ASSET_REVIEW_STATUSES.includes(value as DirectorAssetReviewStatus);
}

export function assetSummary(assets: DirectorAssetRecord[]): DirectorAssetSummary {
  const active = assets.filter((asset) => asset.status !== 'DELETED');
  return {
    total: active.length,
    images: active.filter((asset) => asset.assetType === 'IMAGE').length,
    videos: active.filter((asset) => asset.assetType === 'VIDEO').length,
    audio: active.filter((asset) => asset.assetType === 'AUDIO').length,
    text: active.filter((asset) => asset.assetType === 'TEXT').length,
    models: active.filter((asset) => asset.assetType === 'MODEL').length,
    shotsCovered: new Set(active.map((asset) => asset.shotUid).filter(Boolean)).size,
  };
}
