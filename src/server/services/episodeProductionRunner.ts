import crypto from 'node:crypto';
import type { EpisodeSpec, EpisodeStatus, ShotSpec } from '../../domain/episode/episodeTypes';
import type { ChatGptConversationFileRef } from '../../services/episode/shotIdentitySafeRunner';
import { firestoreEpisodeRepository } from '../repositories/firestoreEpisodeRepository';
import { firestoreShotRepository } from '../repositories/firestoreShotRepository';
import { hasCompleteDurableKeyframeAsset } from './keyframeInputResolver';
import {
  createDefaultShotProductionService,
  type ShotProductionRunResult,
  type ShotProductionServiceLike,
} from './shotProductionService';

const V0_SHOT_IDS = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06'] as const;
type V0ShotId = typeof V0_SHOT_IDS[number];

export interface EpisodeShotRuntimeInput {
  openaiFileRef?: ChatGptConversationFileRef;
  idempotencyKey?: string;
  prompt?: string;
}

export interface EpisodeProductionRunInput {
  episodeId: string;
  shots?: Partial<Record<V0ShotId, EpisodeShotRuntimeInput>>;
}

export interface EpisodeProductionProgress {
  totalShots: number;
  completed: number;
  running: number;
  failed: number;
  currentShotId: string | null;
  percent: number;
}

export interface EpisodeProductionRunResult {
  episodeId: string;
  episodeStatus: EpisodeStatus;
  progress: EpisodeProductionProgress;
  paused: boolean;
  reasonCode?: string;
  message?: string;
  lastShotResult?: ShotProductionRunResult;
}

export interface EpisodeProductionEpisodeRepository {
  isAvailable(): boolean;
  getEpisode(id: string): Promise<EpisodeSpec | null>;
  upsertEpisode(record: EpisodeSpec): Promise<EpisodeSpec>;
}

export interface EpisodeProductionShotRepository {
  isAvailable(): boolean;
  listShotsByEpisode(episodeId: string, limitCount?: number): Promise<ShotSpec[]>;
}

export class EpisodeProductionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'EpisodeProductionError';
  }
}

function isV0ShotId(value: string): value is V0ShotId {
  return (V0_SHOT_IDS as readonly string[]).includes(value);
}

function stableShotIdempotencyKey(episodeId: string, shot: ShotSpec): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${episodeId}:${shot.shotId}:keyframe-v${shot.keyframe.version}`)
    .digest('hex')
    .slice(0, 32);
  return `ep_${digest}`;
}

function computeProgress(shots: ShotSpec[], currentShotId?: string | null): EpisodeProductionProgress {
  const completed = shots.filter((shot) => shot.status === 'COMPLETED' && shot.video.status === 'PASS').length;
  const running = shots.filter((shot) =>
    ['VIDEO_PENDING', 'VIDEO_GENERATING', 'VIDEO_QA'].includes(shot.status)
  ).length;
  const failed = shots.filter((shot) => shot.status === 'FAILED').length;
  const totalShots = shots.length;
  const firstIncomplete = shots.find((shot) => !(shot.status === 'COMPLETED' && shot.video.status === 'PASS'));
  return {
    totalShots,
    completed,
    running,
    failed,
    currentShotId: currentShotId || firstIncomplete?.shotId || null,
    percent: totalShots > 0 ? Math.round((completed / totalShots) * 100) : 0,
  };
}

function validateV0Shots(shots: ShotSpec[]): ShotSpec[] {
  const ordered = [...shots].sort((a, b) => a.order - b.order);
  const ids = ordered.map((shot) => shot.shotId);
  if (
    ordered.length !== V0_SHOT_IDS.length ||
    ids.some((id, index) => id !== V0_SHOT_IDS[index])
  ) {
    throw new EpisodeProductionError(
      'EPISODE_SHOT_SET_INVALID',
      'P0-6B 当前要求 Episode 必须严格包含有序的 S01-S06。',
      409,
    );
  }
  return ordered;
}

function episodeWithState(
  episode: EpisodeSpec,
  status: EpisodeStatus,
  currentShotId?: string,
): EpisodeSpec {
  return {
    ...episode,
    status,
    ...(currentShotId ? { currentShotId } : { currentShotId: undefined }),
    updatedAt: Date.now(),
  };
}

function reviewReason(shot: ShotSpec): string | null {
  if (shot.keyframe.status !== 'PASS') {
    if (shot.keyframe.status === 'REVIEW' || shot.status === 'KEYFRAME_REVIEW') {
      return 'KEYFRAME_REVIEW_REQUIRED';
    }
    return 'KEYFRAME_NOT_PASS';
  }
  if (shot.video.status === 'REVIEW' || shot.status === 'VIDEO_REVIEW') {
    return 'VIDEO_REVIEW_REQUIRED';
  }
  return null;
}

function hasDurableLocation(shot: ShotSpec): boolean {
  return Boolean(
    String(shot.keyframe.outputBucket || '').trim() ||
    String(shot.keyframe.outputObjectPath || '').trim(),
  );
}

export class EpisodeProductionRunner {
  constructor(
    private readonly episodeRepository: EpisodeProductionEpisodeRepository = firestoreEpisodeRepository,
    private readonly shotRepository: EpisodeProductionShotRepository = firestoreShotRepository,
    private readonly shotProductionService: ShotProductionServiceLike = createDefaultShotProductionService(),
  ) {}

  private async persistState(
    episode: EpisodeSpec,
    status: EpisodeStatus,
    currentShotId?: string,
  ): Promise<EpisodeSpec> {
    return this.episodeRepository.upsertEpisode(episodeWithState(episode, status, currentShotId));
  }

  private async currentShots(episodeId: string): Promise<ShotSpec[]> {
    return validateV0Shots(await this.shotRepository.listShotsByEpisode(episodeId, 20));
  }

  public async run(input: EpisodeProductionRunInput): Promise<EpisodeProductionRunResult> {
    const episodeId = String(input.episodeId || '').trim();
    if (!episodeId) {
      throw new EpisodeProductionError('EPISODE_ID_REQUIRED', 'episodeId 不能为空。', 400);
    }
    if (!this.episodeRepository.isAvailable() || !this.shotRepository.isAvailable()) {
      throw new EpisodeProductionError(
        'EPISODE_STORAGE_UNAVAILABLE',
        'Episode/Shot Firestore 当前不可用，未启动任何视频生成。',
        503,
      );
    }

    let episode = await this.episodeRepository.getEpisode(episodeId);
    if (!episode) {
      throw new EpisodeProductionError('EPISODE_NOT_FOUND', `找不到 Episode ${episodeId}。`, 404);
    }
    if (episode.status === 'CANCELLED') {
      throw new EpisodeProductionError('EPISODE_CANCELLED', 'Episode 已取消，禁止继续生产。', 409);
    }
    if (episode.status === 'COMPLETED') {
      const completedShots = await this.currentShots(episodeId);
      return {
        episodeId,
        episodeStatus: 'COMPLETED',
        progress: computeProgress(completedShots, null),
        paused: false,
        reasonCode: 'EPISODE_ALREADY_COMPLETED',
      };
    }

    let shots = await this.currentShots(episodeId);
    if (shots.every((shot) => shot.status === 'COMPLETED' && shot.video.status === 'PASS')) {
      episode = await this.persistState(episode, 'COMPOSING');
      return {
        episodeId,
        episodeStatus: episode.status,
        progress: computeProgress(shots, null),
        paused: false,
        reasonCode: 'ALL_SHOTS_COMPLETED',
      };
    }

    let lastShotResult: ShotProductionRunResult | undefined;

    for (const expectedShotId of V0_SHOT_IDS) {
      // Re-read durable shot state before every step so a restarted runner resumes from
      // Firestore rather than relying on process-local progress.
      shots = await this.currentShots(episodeId);
      const shot = shots.find((item) => item.shotId === expectedShotId);
      if (!shot) {
        throw new EpisodeProductionError('EPISODE_SHOT_MISSING', `${expectedShotId} 不存在。`, 409);
      }

      if (shot.status === 'COMPLETED' && shot.video.status === 'PASS') {
        continue;
      }

      if (shot.status === 'FAILED') {
        episode = await this.persistState(episode, 'FAILED', shot.shotId);
        return {
          episodeId,
          episodeStatus: episode.status,
          progress: computeProgress(shots, shot.shotId),
          paused: true,
          reasonCode: shot.video.failureCode || 'SHOT_FAILED',
          message: shot.video.failureMessage || `${shot.shotId} 已失败，Episode 已暂停。`,
          lastShotResult,
        };
      }

      const gateReason = reviewReason(shot);
      if (gateReason) {
        episode = await this.persistState(episode, 'REVIEW', shot.shotId);
        return {
          episodeId,
          episodeStatus: episode.status,
          progress: computeProgress(shots, shot.shotId),
          paused: true,
          reasonCode: gateReason,
          message: `${shot.shotId} 尚未满足自动生产门禁。`,
          lastShotResult,
        };
      }

      const runtimeInput = isV0ShotId(shot.shotId) ? input.shots?.[shot.shotId] : undefined;
      const durableReady = hasCompleteDurableKeyframeAsset(shot);
      if (hasDurableLocation(shot) && !durableReady) {
        episode = await this.persistState(episode, 'REVIEW', shot.shotId);
        return {
          episodeId,
          episodeStatus: episode.status,
          progress: computeProgress(shots, shot.shotId),
          paused: true,
          reasonCode: 'KEYFRAME_DURABLE_ASSET_INVALID',
          message: `${shot.shotId} durable GCS 关键帧元数据不完整，禁止降级绕过。`,
          lastShotResult,
        };
      }
      if (!durableReady && !runtimeInput?.openaiFileRef) {
        episode = await this.persistState(episode, 'REVIEW', shot.shotId);
        return {
          episodeId,
          episodeStatus: episode.status,
          progress: computeProgress(shots, shot.shotId),
          paused: true,
          reasonCode: 'OPENAI_FILE_REF_REQUIRED',
          message: `${shot.shotId} 没有 durable GCS 关键帧；legacy Shot 仍需要当前可用的 ChatGPT/OpenAI 文件引用。`,
          lastShotResult,
        };
      }

      // Existing durable intent always wins on recovery. This prevents a restarted
      // Episode runner from creating a second provider intent for an active Shot.
      const idempotencyKey =
        shot.video.idempotencyKey ||
        String(runtimeInput?.idempotencyKey || '').trim() ||
        stableShotIdempotencyKey(episodeId, shot);

      episode = await this.persistState(episode, 'PRODUCTION', shot.shotId);

      try {
        lastShotResult = await this.shotProductionService.run({
          episodeId,
          shotId: shot.shotId,
          openaiFileRef: runtimeInput?.openaiFileRef,
          idempotencyKey,
          prompt: runtimeInput?.prompt,
        });
      } catch (error: any) {
        const durableAfterError = await this.currentShots(episodeId);
        const failedShot = durableAfterError.find((item) => item.shotId === shot.shotId) || shot;
        if (failedShot.status === 'FAILED') {
          episode = await this.persistState(episode, 'FAILED', failedShot.shotId);
          return {
            episodeId,
            episodeStatus: episode.status,
            progress: computeProgress(durableAfterError, failedShot.shotId),
            paused: true,
            reasonCode: failedShot.video.failureCode || error?.code || 'SHOT_FAILED',
            message: failedShot.video.failureMessage || error?.message || String(error),
            lastShotResult,
          };
        }
        if (reviewReason(failedShot)) {
          episode = await this.persistState(episode, 'REVIEW', failedShot.shotId);
          return {
            episodeId,
            episodeStatus: episode.status,
            progress: computeProgress(durableAfterError, failedShot.shotId),
            paused: true,
            reasonCode: reviewReason(failedShot) || 'SHOT_REVIEW_REQUIRED',
            message: error?.message || String(error),
            lastShotResult,
          };
        }

        // Transport interruption / still-running provider task: keep PRODUCTION and
        // the durable idempotency key. A later call resumes this same Shot.
        episode = await this.persistState(episode, 'PRODUCTION', failedShot.shotId);
        return {
          episodeId,
          episodeStatus: episode.status,
          progress: computeProgress(durableAfterError, failedShot.shotId),
          paused: true,
          reasonCode: error?.code || 'SHOT_EXECUTION_INTERRUPTED',
          message: error?.message || String(error),
          lastShotResult,
        };
      }
    }

    shots = await this.currentShots(episodeId);
    if (!shots.every((shot) => shot.status === 'COMPLETED' && shot.video.status === 'PASS')) {
      const current = shots.find((shot) => shot.status !== 'COMPLETED');
      episode = await this.persistState(episode, 'REVIEW', current?.shotId);
      return {
        episodeId,
        episodeStatus: episode.status,
        progress: computeProgress(shots, current?.shotId),
        paused: true,
        reasonCode: 'EPISODE_INCOMPLETE_AFTER_RUN',
        lastShotResult,
      };
    }

    episode = await this.persistState(episode, 'COMPOSING');
    return {
      episodeId,
      episodeStatus: episode.status,
      progress: computeProgress(shots, null),
      paused: false,
      reasonCode: 'ALL_SHOTS_COMPLETED',
      lastShotResult,
    };
  }
}

export function createDefaultEpisodeProductionRunner(): EpisodeProductionRunner {
  return new EpisodeProductionRunner(
    firestoreEpisodeRepository,
    firestoreShotRepository,
    createDefaultShotProductionService(),
  );
}
