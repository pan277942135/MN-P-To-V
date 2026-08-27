import { z } from 'zod';
import {
  EPISODE_SCHEMA_VERSION,
  SHOT_SCHEMA_VERSION,
  type EpisodeSpec,
  type ShotSpec,
} from './episodeTypes';

const idSchema = z.string().trim().min(1).max(160).refine((value) => !value.includes('/'), {
  message: 'IDs must not contain slash characters',
});

const timestampSchema = z.number().int().nonnegative();
const moneySchema = z.number().finite().nonnegative();

export const CharacterSnapshotRefSchema = z.object({
  characterId: idSchema,
  characterVersion: z.string().trim().min(1).max(120),
  characterUpdatedAt: timestampSchema.optional(),
  identitySpecHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  referenceImageIds: z.array(z.string().trim().min(1).max(200)).max(16).default([]),
});

export const EpisodeBudgetSchema = z.object({
  limitUsd: moneySchema,
  spentUsd: moneySchema.default(0),
  reservedUsd: moneySchema.default(0),
  currency: z.literal('USD').default('USD'),
}).superRefine((budget, ctx) => {
  if (budget.spentUsd + budget.reservedUsd > budget.limitUsd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'spentUsd + reservedUsd must not exceed limitUsd',
      path: ['reservedUsd'],
    });
  }
});

export const EpisodeStatusSchema = z.enum([
  'DRAFT',
  'PLANNED',
  'PRODUCTION',
  'REVIEW',
  'COMPOSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export const EpisodeSpecSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(240),
  synopsis: z.string().trim().max(4000).optional(),
  characterId: idSchema,
  characterVersion: z.string().trim().min(1).max(120),
  characterSnapshot: CharacterSnapshotRefSchema,
  durationTargetSeconds: z.number().int().min(4).max(600),
  aspectRatio: z.literal('9:16'),
  status: EpisodeStatusSchema,
  budget: EpisodeBudgetSchema.optional(),
  shotIds: z.array(idSchema).max(100),
  currentShotId: idSchema.optional(),
  schemaVersion: z.literal(EPISODE_SCHEMA_VERSION),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
}).superRefine((episode, ctx) => {
  if (new Set(episode.shotIds).size !== episode.shotIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'shotIds must be unique',
      path: ['shotIds'],
    });
  }
  if (episode.characterSnapshot.characterId !== episode.characterId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'characterSnapshot.characterId must match characterId',
      path: ['characterSnapshot', 'characterId'],
    });
  }
  if (episode.characterSnapshot.characterVersion !== episode.characterVersion) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'characterSnapshot.characterVersion must match characterVersion',
      path: ['characterSnapshot', 'characterVersion'],
    });
  }
  if (episode.currentShotId && !episode.shotIds.includes(episode.currentShotId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'currentShotId must exist in shotIds',
      path: ['currentShotId'],
    });
  }
  if (episode.status === 'COMPLETED' && !episode.completedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'completedAt is required when status is COMPLETED',
      path: ['completedAt'],
    });
  }
});

export const ShotStatusSchema = z.enum([
  'DRAFT',
  'KEYFRAME_PENDING',
  'KEYFRAME_QA',
  'KEYFRAME_REVIEW',
  'VIDEO_PENDING',
  'VIDEO_GENERATING',
  'VIDEO_QA',
  'VIDEO_REVIEW',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export const ShotSceneSpecSchema = z.object({
  location: z.string().trim().min(1).max(300),
  time: z.string().trim().max(120).optional(),
  description: z.string().trim().max(2000).optional(),
});

export const ShotKeyframeSpecSchema = z.object({
  provider: z.enum(['CHATGPT_UPLOAD', 'GEMINI_GENERATED', 'MANUAL_IMPORT']),
  status: z.enum(['NOT_REQUESTED', 'READY', 'QA_PENDING', 'PASS', 'REVIEW', 'FAIL']),
  assetId: z.string().trim().min(1).max(240).optional(),
  sourceFileId: z.string().trim().min(1).max(500).optional(),
  outputBucket: z.string().trim().min(1).max(240).optional(),
  outputObjectPath: z.string().trim().min(1).max(1000).optional(),
  version: z.number().int().min(1).default(1),
  generationAttempt: z.number().int().nonnegative().default(0),
  qaAttempt: z.number().int().nonnegative().default(0),
}).superRefine((keyframe, ctx) => {
  const persistedStates = new Set(['PASS', 'REVIEW']);
  if (persistedStates.has(keyframe.status) && !keyframe.assetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assetId is required for PASS or REVIEW keyframes',
      path: ['assetId'],
    });
  }
});

export const ShotVideoSpecSchema = z.object({
  provider: z.literal('VEO'),
  status: z.enum(['NOT_REQUESTED', 'PENDING', 'GENERATING', 'QA_PENDING', 'PASS', 'REVIEW', 'FAIL']),
  generationTaskId: z.string().trim().min(1).max(240).optional(),
  assetId: z.string().trim().min(1).max(240).optional(),
  outputBucket: z.string().trim().min(1).max(240).optional(),
  outputObjectPath: z.string().trim().min(1).max(1000).optional(),
  providerAttempt: z.number().int().nonnegative().default(0),
  qaAttempt: z.number().int().nonnegative().default(0),
}).superRefine((video, ctx) => {
  const taskStates = new Set(['GENERATING', 'QA_PENDING', 'PASS', 'REVIEW', 'FAIL']);
  if (taskStates.has(video.status) && !video.generationTaskId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'generationTaskId is required once video execution has started',
      path: ['generationTaskId'],
    });
  }
  if (video.status === 'PASS' && !video.assetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assetId is required for PASS video',
      path: ['assetId'],
    });
  }
});

export const ShotBudgetSchema = EpisodeBudgetSchema;

export const ShotSpecSchema = z.object({
  episodeId: idSchema,
  shotId: idSchema,
  order: z.number().int().min(0).max(999),
  title: z.string().trim().min(1).max(240).optional(),
  durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]),
  status: ShotStatusSchema,
  scene: ShotSceneSpecSchema,
  action: z.string().trim().min(1).max(4000),
  camera: z.string().trim().min(1).max(1000),
  emotion: z.string().trim().max(500).optional(),
  props: z.array(z.string().trim().min(1).max(240)).max(50).default([]),
  voiceover: z.string().trim().max(4000).optional(),
  keyframe: ShotKeyframeSpecSchema,
  video: ShotVideoSpecSchema,
  budget: ShotBudgetSchema.optional(),
  schemaVersion: z.literal(SHOT_SCHEMA_VERSION),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
}).superRefine((shot, ctx) => {
  if (shot.status === 'COMPLETED') {
    if (shot.keyframe.status !== 'PASS') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completed shot requires keyframe PASS',
        path: ['keyframe', 'status'],
      });
    }
    if (shot.video.status !== 'PASS') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completed shot requires video PASS',
        path: ['video', 'status'],
      });
    }
    if (!shot.completedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completedAt is required when shot status is COMPLETED',
        path: ['completedAt'],
      });
    }
  }
});

export function parseEpisodeSpec(input: unknown): EpisodeSpec {
  return EpisodeSpecSchema.parse(input) as EpisodeSpec;
}

export function parseShotSpec(input: unknown): ShotSpec {
  return ShotSpecSchema.parse(input) as ShotSpec;
}
