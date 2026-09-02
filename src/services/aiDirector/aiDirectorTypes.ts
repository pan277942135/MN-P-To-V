import type {
  DirectorAssetMetadata,
  DirectorAssetPreviewStatus,
  DirectorAssetReview,
  DirectorAssetStatus,
  DirectorAssetType,
} from '../assetRegistry/assetRegistryTypes';
import type { ProductionFormatPolicy, ShotFormatPolicy } from '../formatPolicy/formatPolicy';

export const AI_DIRECTOR_CONTEXT_SCHEMA = 'zaojing.ai.context.v1' as const;

export const AI_DIRECTOR_SCOPES = ['context', 'preview', 'review_package'] as const;
export type AiDirectorScope = typeof AI_DIRECTOR_SCOPES[number];

export const AI_TOKEN_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type AiTokenStatus = typeof AI_TOKEN_STATUSES[number];

export interface DirectorAiTokenRecord {
  tokenId: string;
  projectId: string;
  tokenHash: string;
  name: string;
  scope: AiDirectorScope[];
  status: AiTokenStatus;
  createdAt: string;
  expiresAt: string;
}

export interface DirectorAiTokenPublic {
  tokenId: string;
  projectId: string;
  name: string;
  scope: AiDirectorScope[];
  status: AiTokenStatus;
  createdAt: string;
  expiresAt: string;
}

export interface AiAssetPreview {
  status: DirectorAssetPreviewStatus;
  expiresAt: string;
  thumbnailUrl: string;
  mediumUrl: string;
  videoUrl: string;
  /** Explicit aliases used by the AI Director Context contract. */
  videoPreviewUrl: string;
  frames: string[];
  frameUrls: string[];
  audioUrl: string;
}

export interface AiDirectorAsset {
  assetId: string;
  projectId: string;
  episodeId: string;
  shotUid: string;
  type: DirectorAssetType;
  mediaType: string;
  status: DirectorAssetStatus;
  metadata: DirectorAssetMetadata & { ratio: string };
  review: DirectorAssetReview;
  sourceType: string;
  relations: {
    characters: string[];
    scene: string;
    description: string;
    shotPurpose: string;
  };
  preview?: AiAssetPreview;
}

export interface AiDirectorEpisode {
  episodeId: string;
  title: string;
  summary: string;
  status: string;
}

export interface AiDirectorShot {
  projectId: string;
  episodeId: string;
  shotUid: string;
  order: number;
  title: string;
  storyPurpose: string;
  visualRequirement: string;
  camera: string;
  action: string;
  dialogue: string;
  status: string;
  storyboard?: Record<string, unknown>;
  formatPolicy?: ShotFormatPolicy;
  /** Existing production blueprint payload, exposed read-only to AI consumers. */
  blueprint: Record<string, unknown>;
  videoBlueprint?: Record<string, unknown>;
  assets: AiDirectorAsset[];
}

export interface AiDirectorProject {
  projectId: string;
  title: string;
  creativeBrief: string;
  targetFormat: string;
  aspectRatio: string;
  formatPolicy: ProductionFormatPolicy;
}

export interface AiDirectorAssetSummary {
  total: number;
  images: number;
  videos: number;
  audio: number;
}

export interface AiDirectorContext {
  schema: typeof AI_DIRECTOR_CONTEXT_SCHEMA;
  project: AiDirectorProject;
  episodes: AiDirectorEpisode[];
  shots: AiDirectorShot[];
  assets: AiDirectorAsset[];
  assetSummary: AiDirectorAssetSummary;
}

export interface AiAssetPreviewResponse {
  assetId: string;
  type: DirectorAssetType;
  preview: AiAssetPreview;
}

export interface AiReviewPackageFile {
  path: string;
  url: string;
  contentType: string;
}

export interface AiReviewPackageResponse {
  packageId: string;
  projectId: string;
  generatedAt: string;
  expiresAt: string;
  files: {
    project: AiReviewPackageFile;
    context: AiReviewPackageFile;
    assetManifest: AiReviewPackageFile;
    contactSheet: AiReviewPackageFile;
    imagePreviews: AiReviewPackageFile[];
    videoPreviews: AiReviewPackageFile[];
  };
  assetCount: number;
  previewCount: number;
}
