import type {
  DirectorAssetMetadata,
  DirectorAssetPreviewStatus,
  DirectorAssetPreviewSummary,
  DirectorAssetReviewStatus,
  DirectorAssetStatus,
  DirectorAssetType,
} from '../assetRegistry/assetRegistryTypes';
import type { ProductionFormatPolicy, ShotFormatPolicy } from '../formatPolicy/formatPolicy';

export const DIRECTOR_CONTEXT_SCHEMA = 'zaojing.director.context.v1' as const;

/**
 * The AI Director Context is a read-only composition contract. Production
 * Shot/Blueprint documents and the Asset Registry remain the source of truth.
 */
export interface DirectorContextAsset {
  assetId: string;
  type: DirectorAssetType;
  mediaType: string;
  thumbnail: string;
  /** Legacy direct URL alias retained for existing Context consumers. */
  previewUrl: string;
  /** AI-facing derived preview URLs. */
  preview: {
    status: DirectorAssetPreviewStatus;
    thumbnailUrl: string;
    mediumUrl: string;
    videoPreviewUrl: string;
    frameUrls: string[];
    audioUrl: string;
  };
  metadata: DirectorAssetMetadata;
  reviewStatus: DirectorAssetReviewStatus;
  shotUid: string;
  status: DirectorAssetStatus;
  sourceType: string;
  description: string;
}

export interface DirectorContextProject {
  projectId: string;
  title: string;
  creativeBrief: string;
  targetFormat: string;
  aspectRatio: string;
  formatPolicy: ProductionFormatPolicy;
}

export interface DirectorContextEpisode {
  episodeId: string;
  title: string;
  summary: string;
  status: string;
}

export interface DirectorContextShot {
  shotUid: string;
  order: number;
  title: string;
  storyPurpose: string;
  visualDescription: string;
  camera: string;
  action: string;
  dialogue: string;
  status: string;
  formatPolicy?: ShotFormatPolicy;
  assets: DirectorContextAsset[];
}

export interface DirectorContextAssetSummary {
  total: number;
  images: number;
  videos: number;
  audio: number;
  preview: DirectorAssetPreviewSummary;
}

export interface DirectorContext {
  schema: typeof DIRECTOR_CONTEXT_SCHEMA;
  project: DirectorContextProject;
  episode: DirectorContextEpisode;
  shots: DirectorContextShot[];
  assetSummary: DirectorContextAssetSummary;
}

export interface DirectorShotContext extends DirectorContextShot {
  projectId: string;
  episodeId: string;
  /** Compatibility alias for consumers that call the field `purpose`. */
  purpose: string;
}
