import type { ShotSpec } from '../../domain/episode/episodeTypes';
import { S01_DEFAULT_PROMPT } from '../../services/episode/s01IdentitySafeRunner';
import {
  SHOT_DEFAULT_PROMPT,
  ShotIdentitySafeRunner,
  type ChatGptConversationFileRef,
  type ShotIdentitySafeRunInput,
  type ShotIdentitySafeRunResult,
  type ShotRunnerDependencies,
} from '../../services/episode/shotIdentitySafeRunner';
import { firestoreShotRepository } from '../repositories/firestoreShotRepository';
import {
  KeyframeInputResolutionError,
  keyframeInputResolver,
  type KeyframeInputResolverLike,
} from './keyframeInputResolver';
import { syncVideoAssetToRegistry } from './assetRegistry/assetRegistrySyncService';

export interface ShotProductionRunInput {
  projectId?: string;
  episodeId: string;
  shotId: string;
  openaiFileRef?: ChatGptConversationFileRef;
  idempotencyKey: string;
  prompt?: string;
}

export interface ShotProductionRunResult extends ShotIdentitySafeRunResult {
  shotStatus: 'COMPLETED';
  replayed: boolean;
}

export interface ShotProductionShotRepository {
  isAvailable(): boolean;
  getShot(episodeId: string, shotId: string): Promise<ShotSpec | null>;
  prepareVideoExecution(params: {
    episodeId: string;
    shotId: string;
    idempotencyKey: string;
  }): Promise<ShotSpec>;
  markVideoGenerating(params: {
    episodeId: string;
    shotId: string;
    idempotencyKey: string;
    generationTaskId: string;
    providerAttempt?: number;
  }): Promise<ShotSpec>;
  completeVideo(params: {
    episodeId: string;
    shotId: string;
    idempotencyKey: string;
    taskId: string;
    videoUrl: string;
    downloadUrl: string;
    expiresAt?: string | null;
    providerAttempt?: number;
    artifactPersisted: boolean;
    artifactVerified: boolean;
  }): Promise<ShotSpec>;
  failVideo(params: {
    episodeId: string;
    shotId: string;
    idempotencyKey: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<ShotSpec>;
}

export interface ShotIdentitySafeRunnerLike {
  run(input: ShotIdentitySafeRunInput): Promise<ShotIdentitySafeRunResult>;
}

export interface ShotRunnerFactory {
  (dependencies: Pick<ShotRunnerDependencies, 'onTaskCreated'>): ShotIdentitySafeRunnerLike;
}

export interface ShotProductionServiceLike {
  run(input: ShotProductionRunInput): Promise<ShotProductionRunResult>;
}

export class ShotProductionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'ShotProductionError';
  }
}

function codeFor(shotId: string, suffix: string): string {
  return shotId === 'S01' ? `S01_${suffix}` : `SHOT_${suffix}`;
}

function requireIdempotencyKey(value: string, shotId: string): string {
  const key = String(value || '').trim();
  if (key.length < 16 || key.length > 200) {
    throw new ShotProductionError(
      codeFor(shotId, 'IDEMPOTENCY_KEY_INVALID'),
      `${shotId || 'Shot'} 生产请求需要 16-200 字符的幂等键。`,
      400,
    );
  }
  return key;
}

function requireSupportedShotId(shotId: string): void {
  if (!/^S0[1-6]$/.test(shotId)) {
    throw new ShotProductionError('SHOT_NOT_SUPPORTED', '当前 V0 生产入口只接受 S01-S06。', 404);
  }
}

function buildShotPrompt(shot: ShotSpec, override?: string): string {
  const requested = String(override || '').trim();
  if (requested) return requested;
  const basePrompt = shot.shotId === 'S01' ? S01_DEFAULT_PROMPT : SHOT_DEFAULT_PROMPT;
  return [
    basePrompt,
    `Shot: ${shot.shotId}.`,
    `Scene location: ${shot.scene.location}.`,
    shot.scene.time ? `Scene time: ${shot.scene.time}.` : '',
    shot.scene.description ? `Scene description: ${shot.scene.description}` : '',
    `Shot action: ${shot.action}`,
    `Camera: ${shot.camera}`,
    shot.emotion ? `Emotion: ${shot.emotion}` : '',
    shot.props.length > 0 ? `Keep these props stable: ${shot.props.join(', ')}` : '',
  ].filter(Boolean).join(' ');
}

function resultFromCompletedShot(
  shot: ShotSpec,
  episodeId: string,
  shotId: string,
  replayed: boolean,
): ShotProductionRunResult {
  const taskId = String(shot.video.generationTaskId || '').trim();
  const videoUrl = String(shot.video.artifactUrl || '').trim();
  const downloadUrl = String(shot.video.downloadUrl || '').trim();
  if (!taskId || !videoUrl || !downloadUrl) {
    throw new ShotProductionError(
      codeFor(shotId, 'COMPLETED_ARTIFACT_MISSING'),
      `${shotId} 已完成但持久化视频产物不完整，不能安全重放。`,
      503,
    );
  }
  return {
    episodeId,
    shotId,
    taskId,
    status: 'COMPLETED',
    videoUrl,
    downloadUrl,
    expiresAt: shot.video.artifactExpiresAt || null,
    providerAttempt: Math.max(1, shot.video.providerAttempt),
    identityReport: undefined,
    artifactPersisted: shot.video.artifactPersisted === true,
    artifactVerified: shot.video.artifactVerified === true,
    shotStatus: 'COMPLETED',
    replayed,
  };
}

function runnerFactoryFromEnvironment(): ShotRunnerFactory {
  return (dependencies) => {
    const gatewayBaseUrl =
      process.env.SHOT_GATEWAY_BASE_URL ||
      process.env.S01_GATEWAY_BASE_URL ||
      process.env.CHATGPT_GATEWAY_BASE_URL ||
      process.env.ZAOJING_CHATGPT_GATEWAY_URL ||
      '';
    if (!gatewayBaseUrl.trim()) {
      throw new ShotProductionError(
        'SHOT_GATEWAY_NOT_CONFIGURED',
        'Shot 生产网关未配置，请设置 SHOT_GATEWAY_BASE_URL。',
        503,
      );
    }
    return new ShotIdentitySafeRunner(
      {
        gatewayBaseUrl,
        apiKey:
          process.env.SHOT_GATEWAY_API_KEY ||
          process.env.S01_GATEWAY_API_KEY ||
          process.env.CHATGPT_GATEWAY_API_KEY,
        pollIntervalMs: Number(
          process.env.SHOT_POLL_INTERVAL_MS || process.env.S01_POLL_INTERVAL_MS || 10_000,
        ),
        maxPolls: Number(process.env.SHOT_MAX_POLLS || process.env.S01_MAX_POLLS || 72),
      },
      dependencies,
    );
  };
}

export function createDefaultShotProductionService(
  repository: ShotProductionShotRepository = firestoreShotRepository,
): ShotProductionService {
  return new ShotProductionService(repository, runnerFactoryFromEnvironment(), keyframeInputResolver);
}

export class ShotProductionService implements ShotProductionServiceLike {
  constructor(
    private readonly repository: ShotProductionShotRepository,
    private readonly runnerFactory: ShotRunnerFactory,
    private readonly inputResolver: KeyframeInputResolverLike = keyframeInputResolver,
  ) {}

  public async run(input: ShotProductionRunInput): Promise<ShotProductionRunResult> {
    const episodeId = String(input.episodeId || '').trim();
    const shotId = String(input.shotId || '').trim();
    if (!episodeId || !shotId) {
      throw new ShotProductionError(
        codeFor(shotId, 'ROUTE_PARAMS_INVALID'),
        'episodeId 和 shotId 不能为空。',
        400,
      );
    }
    requireSupportedShotId(shotId);
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey, shotId);

    if (!this.repository.isAvailable()) {
      throw new ShotProductionError(
        codeFor(shotId, 'FIRESTORE_UNAVAILABLE'),
        `${shotId} 状态存储当前不可用，未启动视频生成。`,
        503,
      );
    }

    const shot = await this.repository.getShot(episodeId, shotId);
    if (!shot) {
      throw new ShotProductionError(
        codeFor(shotId, 'SHOT_NOT_FOUND'),
        `找不到指定的 ${shotId} 分镜。`,
        404,
      );
    }
    if (shot.episodeId !== episodeId || shot.shotId !== shotId) {
      throw new ShotProductionError(
        codeFor(shotId, 'SHOT_IDENTITY_MISMATCH'),
        '分镜与请求路径不一致。',
        409,
      );
    }

    if (shot.status === 'COMPLETED' && shot.video.status === 'PASS') {
      if (shot.video.idempotencyKey !== idempotencyKey) {
        throw new ShotProductionError(
          codeFor(shotId, 'ALREADY_COMPLETED'),
          `${shotId} 已有完成产物；请使用原幂等键读取，禁止重复生成。`,
          409,
        );
      }
      const replayed = resultFromCompletedShot(shot, episodeId, shotId, true);
      await syncVideoAssetToRegistry({
        projectId: input.projectId,
        shot,
        artifact: {
          assetId: replayed.taskId,
          videoUrl: replayed.videoUrl,
          downloadUrl: replayed.downloadUrl,
          durationSeconds: shot.durationSeconds,
        },
        sourceType: 'VEO_GENERATED_REPLAY',
      }).catch((error) => {
        console.warn('[Asset Registry] completed video replay sync skipped:', error instanceof Error ? error.message : String(error));
        return null;
      });
      return replayed;
    }

    if (
      shot.video.idempotencyKey &&
      shot.video.idempotencyKey !== idempotencyKey &&
      shot.status !== 'FAILED'
    ) {
      throw new ShotProductionError(
        codeFor(shotId, 'IDEMPOTENCY_CONFLICT'),
        `${shotId} 已有另一个进行中的生产意图。`,
        409,
      );
    }
    if (![4, 6, 8].includes(shot.durationSeconds)) {
      throw new ShotProductionError(
        codeFor(shotId, 'DURATION_INVALID'),
        `${shotId} 时长必须为 4、6 或 8 秒。`,
        409,
      );
    }
    if (shot.keyframe.status !== 'PASS') {
      throw new ShotProductionError(
        'KEYFRAME_GATE_BLOCKED',
        '关键帧尚未通过 PASS，已阻止 Veo 调用。',
        409,
      );
    }

    let keyframeInput;
    try {
      keyframeInput = await this.inputResolver.resolve({
        shot,
        openaiFileRef: input.openaiFileRef,
      });
    } catch (error) {
      if (error instanceof KeyframeInputResolutionError) {
        throw new ShotProductionError(error.code, error.message, error.statusCode);
      }
      throw error;
    }

    // Input resolution and integrity checks must finish before the durable provider intent
    // reservation. This keeps corrupt/missing keyframes strictly pre-provider.
    await this.repository.prepareVideoExecution({ episodeId, shotId, idempotencyKey });
    let taskBound = false;

    try {
      const runner = this.runnerFactory({
        onTaskCreated: async ({ taskId, providerAttempt }) => {
          await this.repository.markVideoGenerating({
            episodeId,
            shotId,
            idempotencyKey,
            generationTaskId: taskId,
            providerAttempt,
          });
          taskBound = true;
        },
      });
      const result = await runner.run({
        episodeId,
        shotId,
        keyframeInput,
        idempotencyKey,
        prompt: buildShotPrompt(shot, input.prompt),
        durationSeconds: shot.durationSeconds,
      });
      if (!result.artifactPersisted || !result.artifactVerified) {
        throw new ShotProductionError(
          codeFor(shotId, 'ARTIFACT_NOT_VERIFIED'),
          '视频任务完成但产物尚未通过持久化校验，未写入 COMPLETED。',
          503,
        );
      }
      const completed = await this.repository.completeVideo({
        episodeId,
        shotId,
        idempotencyKey,
        taskId: result.taskId,
        videoUrl: result.videoUrl,
        downloadUrl: result.downloadUrl,
        expiresAt: result.expiresAt,
        providerAttempt: result.providerAttempt,
        artifactPersisted: result.artifactPersisted,
        artifactVerified: result.artifactVerified,
      });
      if (completed.status !== 'COMPLETED') {
        throw new ShotProductionError(
          codeFor(shotId, 'STATE_COMPLETION_FAILED'),
          `${shotId} 视频已生成但状态未能进入 COMPLETED。`,
          503,
        );
      }
      await syncVideoAssetToRegistry({
        projectId: input.projectId,
        shot: completed,
        artifact: {
          assetId: result.taskId,
          videoUrl: result.videoUrl,
          downloadUrl: result.downloadUrl,
          durationSeconds: completed.durationSeconds,
        },
        sourceType: 'VEO_GENERATED',
      }).catch((error) => {
        console.warn('[Asset Registry] video sync skipped:', error instanceof Error ? error.message : String(error));
        return null;
      });
      return { ...result, shotStatus: 'COMPLETED', replayed: false };
    } catch (error: unknown) {
      if (taskBound) {
        try {
          await this.repository.failVideo({
            episodeId,
            shotId,
            idempotencyKey,
            errorCode:
              error instanceof ShotProductionError
                ? error.code
                : codeFor(shotId, 'PRODUCTION_FAILED'),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Preserve the original provider/state error; failure persistence is best effort.
        }
      }
      throw error;
    }
  }
}
