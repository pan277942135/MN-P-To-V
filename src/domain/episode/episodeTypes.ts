export const EPISODE_SCHEMA_VERSION = 'episode-v0.1' as const;
export const SHOT_SCHEMA_VERSION = 'shot-v0.1' as const;

export type EpisodeStatus =
  | 'DRAFT'
  | 'PLANNED'
  | 'PRODUCTION'
  | 'REVIEW'
  | 'COMPOSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type ShotStatus =
  | 'DRAFT'
  | 'KEYFRAME_PENDING'
  | 'KEYFRAME_QA'
  | 'KEYFRAME_REVIEW'
  | 'VIDEO_PENDING'
  | 'VIDEO_GENERATING'
  | 'VIDEO_QA'
  | 'VIDEO_REVIEW'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type KeyframeProvider = 'CHATGPT_UPLOAD' | 'GEMINI_GENERATED' | 'MANUAL_IMPORT';
export type KeyframeStatus = 'NOT_REQUESTED' | 'READY' | 'QA_PENDING' | 'PASS' | 'REVIEW' | 'FAIL';
export type VideoStatus = 'NOT_REQUESTED' | 'PENDING' | 'GENERATING' | 'QA_PENDING' | 'PASS' | 'REVIEW' | 'FAIL';

export interface CharacterSnapshotRef {
  characterId: string;
  characterVersion: string;
  characterUpdatedAt?: number;
  identitySpecHash?: string;
  referenceImageIds: string[];
}

export interface EpisodeBudget {
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  currency: 'USD';
}

export interface EpisodeSpec {
  id: string;
  title: string;
  synopsis?: string;
  characterId: string;
  characterVersion: string;
  characterSnapshot: CharacterSnapshotRef;
  durationTargetSeconds: number;
  aspectRatio: '9:16';
  status: EpisodeStatus;
  budget?: EpisodeBudget;
  shotIds: string[];
  currentShotId?: string;
  schemaVersion: typeof EPISODE_SCHEMA_VERSION;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface ShotSceneSpec {
  location: string;
  time?: string;
  description?: string;
}

export interface ShotKeyframeSpec {
  provider: KeyframeProvider;
  status: KeyframeStatus;
  assetId?: string;
  sourceFileId?: string;
  outputBucket?: string;
  outputObjectPath?: string;
  contentSha256?: string;
  mimeType?: 'image/jpeg' | 'image/png' | 'image/webp';
  sizeBytes?: number;
  width?: number;
  height?: number;
  providerModel?: string;
  promptHash?: string;
  persistedAt?: number;
  version: number;
  generationAttempt: number;
  qaAttempt: number;
}

export interface ShotVideoSpec {
  provider: 'VEO';
  status: VideoStatus;
  generationTaskId?: string;
  assetId?: string;
  outputBucket?: string;
  outputObjectPath?: string;
  idempotencyKey?: string;
  artifactUrl?: string;
  downloadUrl?: string;
  artifactExpiresAt?: string;
  artifactPersisted?: boolean;
  artifactVerified?: boolean;
  failureCode?: string;
  failureMessage?: string;
  providerAttempt: number;
  qaAttempt: number;
}

export interface ShotBudget {
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  currency: 'USD';
}

export interface ShotSpec {
  episodeId: string;
  shotId: string;
  order: number;
  title?: string;
  durationSeconds: 4 | 6 | 8;
  status: ShotStatus;
  scene: ShotSceneSpec;
  action: string;
  camera: string;
  emotion?: string;
  props: string[];
  voiceover?: string;
  keyframe: ShotKeyframeSpec;
  video: ShotVideoSpec;
  budget?: ShotBudget;
  schemaVersion: typeof SHOT_SCHEMA_VERSION;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export function buildShotDocumentId(episodeId: string, shotId: string): string {
  const safeEpisodeId = String(episodeId || '').trim();
  const safeShotId = String(shotId || '').trim();
  if (!safeEpisodeId || !safeShotId) {
    throw new Error('episodeId and shotId are required');
  }
  if (safeEpisodeId.includes('/') || safeShotId.includes('/')) {
    throw new Error('episodeId and shotId must not contain slash characters');
  }
  return `${safeEpisodeId}__${safeShotId}`;
}
