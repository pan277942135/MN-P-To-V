
import type { ShotSpec } from '../../domain/episode/episodeTypes';
import {
  S01_DEFAULT_PROMPT,
  S01IdentitySafeRunner,
  type ChatGptConversationFileRef,
  type S01IdentitySafeRunInput,
  type S01IdentitySafeRunResult,
  type RunnerDependencies,
} from '../../services/episode/s01IdentitySafeRunner';
import { firestoreShotRepository } from '../repositories/firestoreShotRepository';

export interface S01ProductionRunInput {
  episodeId: string;
  shotId: string;
  openaiFileRef: ChatGptConversationFileRef;
  idempotencyKey: string;
  prompt?: string;
}

export interface S01ProductionRunResult extends S01IdentitySafeRunResult {
  shotStatus: 'COMPLETED';
  replayed: boolean;
}

export interface S01ProductionShotRepository {
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

export interface S01IdentitySafeRunnerLike {
  run(input: S01IdentitySafeRunInput): Promise<S01IdentitySafeRunResult>;
}

export interface S01RunnerFactory {
  (dependencies: Pick<RunnerDependencies, 'onTaskCreated'>): S01IdentitySafeRunnerLike;
}

export interface S01ProductionServiceLike {
  run(input: S01ProductionRunInput): Promise<S01ProductionRunResult>;
}

export class S01ProductionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'S01ProductionError';
  }
}

function requireIdempotencyKey(value: string): string {
  const key = String(value || '').trim();
  if (key.length < 16 || key.length > 200) {
    throw new S01ProductionError('S01_IDEMPOTENCY_KEY_INVALID', 'S01 生产请求需要 16-200 字符的幂等键。', 400);
  }
  return key;
}

function fileRefId(fileRef: ChatGptConversationFileRef): string | undefined {
  if (typeof fileRef === 'string') return fileRef.trim() || undefined;
  return String(fileRef?.id || '').trim() || undefined;
}

function buildS01Prompt(shot: ShotSpec, override?: string): string {
  const requested = String(override || '').trim();
  if (requested) return requested;
  return [
    S01_DEFAULT_PROMPT,
    'Shot action: ' + shot.action,
    'Camera: ' + shot.camera,
    shot.emotion ? 'Emotion: ' + shot.emotion : '',
    shot.props.length > 0 ? 'Keep these props stable: ' + shot.props.join(', ') : '',
  ].filter(Boolean).join(' ');
}

function resultFromCompletedShot(
  shot: ShotSpec,
  episodeId: string,
  shotId: string,
  replayed: boolean,
): S01ProductionRunResult {
  const taskId = String(shot.video.generationTaskId || '').trim();
  const videoUrl = String(shot.video.artifactUrl || '').trim();
  const downloadUrl = String(shot.video.downloadUrl || '').trim();
  if (!taskId || !videoUrl || !downloadUrl) {
    throw new S01ProductionError(
      'S01_COMPLETED_ARTIFACT_MISSING',
      'S01 已完成但持久化视频产物不完整，不能安全重放。',
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

function runnerFactoryFromEnvironment(): S01RunnerFactory {
  return (dependencies) => {
    const gatewayBaseUrl =
      process.env.S01_GATEWAY_BASE_URL ||
      process.env.CHATGPT_GATEWAY_BASE_URL ||
      process.env.ZAOJING_CHATGPT_GATEWAY_URL ||
      '';
    if (!gatewayBaseUrl.trim()) {
      throw new S01ProductionError(
        'S01_GATEWAY_NOT_CONFIGURED',
        'S01 生产网关未配置，请设置 S01_GATEWAY_BASE_URL。',
        503,
      );
    }
    return new S01IdentitySafeRunner(
      {
        gatewayBaseUrl,
        apiKey: process.env.S01_GATEWAY_API_KEY || process.env.CHATGPT_GATEWAY_API_KEY,
        pollIntervalMs: Number(process.env.S01_POLL_INTERVAL_MS || 10_000),
        maxPolls: Number(process.env.S01_MAX_POLLS || 72),
      },
      dependencies,
    );
  };
}

export function createDefaultS01ProductionService(
  repository: S01ProductionShotRepository = firestoreShotRepository,
): S01ProductionService {
  return new S01ProductionService(repository, runnerFactoryFromEnvironment());
}

export class S01ProductionService implements S01ProductionServiceLike {
  constructor(
    private readonly repository: S01ProductionShotRepository,
    private readonly runnerFactory: S01RunnerFactory,
  ) {}

  public async run(input: S01ProductionRunInput): Promise<S01ProductionRunResult> {
    const episodeId = String(input.episodeId || '').trim();
    const shotId = String(input.shotId || '').trim();
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    if (!episodeId || !shotId) {
      throw new S01ProductionError('S01_ROUTE_PARAMS_INVALID', 'episodeId 和 shotId 不能为空。', 400);
    }
    if (shotId !== 'S01') {
      throw new S01ProductionError('S01_ONLY', '当前生产入口只接受 S01。', 404);
    }
    if (!this.repository.isAvailable()) {
      throw new S01ProductionError('S01_FIRESTORE_UNAVAILABLE', 'S01 状态存储当前不可用，未启动视频生成。', 503);
    }

    const shot = await this.repository.getShot(episodeId, shotId);
    if (!shot) {
      throw new S01ProductionError('S01_SHOT_NOT_FOUND', '找不到指定的 S01 分镜。', 404);
    }
    if (shot.episodeId !== episodeId || shot.shotId !== shotId) {
      throw new S01ProductionError('S01_SHOT_IDENTITY_MISMATCH', '分镜与请求路径不一致。', 409);
    }

    if (shot.status === 'COMPLETED' && shot.video.status === 'PASS') {
      if (shot.video.idempotencyKey !== idempotencyKey) {
        throw new S01ProductionError('S01_ALREADY_COMPLETED', 'S01 已有完成产物；请使用原幂等键读取，禁止重复生成。', 409);
      }
      return resultFromCompletedShot(shot, episodeId, shotId, true);
    }

    if (
      shot.video.idempotencyKey &&
      shot.video.idempotencyKey !== idempotencyKey &&
      shot.status !== 'FAILED'
    ) {
      throw new S01ProductionError('S01_IDEMPOTENCY_CONFLICT', 'S01 已有另一个进行中的生产意图。', 409);
    }
    if (shot.durationSeconds !== 4) {
      throw new S01ProductionError('S01_DURATION_INVALID', '当前 S01 入口只支持 4 秒镜头。', 409);
    }
    if (shot.keyframe.status !== 'PASS') {
      throw new S01ProductionError('KEYFRAME_GATE_BLOCKED', '关键帧尚未通过 PASS，已阻止 Veo 调用。', 409);
    }
    const sourceId = fileRefId(input.openaiFileRef);
    if (shot.keyframe.sourceFileId && sourceId && shot.keyframe.sourceFileId !== sourceId) {
      throw new S01ProductionError('S01_KEYFRAME_SOURCE_MISMATCH', '上传图片不是当前 S01 已批准的关键帧来源。', 409);
    }

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
        openaiFileRef: input.openaiFileRef,
        idempotencyKey,
        prompt: buildS01Prompt(shot, input.prompt),
        durationSeconds: 4,
      });
      if (!result.artifactPersisted || !result.artifactVerified) {
        throw new S01ProductionError(
          'S01_ARTIFACT_NOT_VERIFIED',
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
        throw new S01ProductionError('S01_STATE_COMPLETION_FAILED', 'S01 视频已生成但状态未能进入 COMPLETED。', 503);
      }
      return { ...result, shotStatus: 'COMPLETED', replayed: false };
    } catch (error: unknown) {
      if (taskBound) {
        try {
          await this.repository.failVideo({
            episodeId,
            shotId,
            idempotencyKey,
            errorCode: error instanceof S01ProductionError ? error.code : 'S01_PRODUCTION_FAILED',
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
