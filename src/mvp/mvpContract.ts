export const MVP_PROVIDER = 'vertex' as const;
export const MVP_VIDEO_MODEL = 'veo-3.1-fast-generate-001' as const;
export const MVP_ALLOWED_DURATIONS = [4, 6, 8] as const;

export type MvpTaskStatus =
  | 'PREPARING'
  | 'SUBMITTING'
  | 'GENERATING'
  | 'SAVING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SUBMISSION_OUTCOME_UNKNOWN';

export type MvpFailureStage =
  | 'input'
  | 'auth'
  | 'submit'
  | 'polling'
  | 'generation'
  | 'output_fetch'
  | 'artifact_persist'
  | 'internal';

export type MvpErrorCode =
  | 'INPUT_IMAGE_INVALID'
  | 'PROMPT_INVALID'
  | 'AUTH_FAILED'
  | 'REQUEST_REJECTED'
  | 'SAFETY_REJECTED'
  | 'RATE_LIMITED'
  | 'GENERATION_FAILED'
  | 'GENERATION_TIMEOUT'
  | 'OUTPUT_MISSING'
  | 'OUTPUT_DOWNLOAD_FAILED'
  | 'OUTPUT_INVALID'
  | 'OUTPUT_PERSIST_FAILED'
  | 'SUBMISSION_OUTCOME_UNKNOWN'
  | 'STORAGE_CONFIG_INVALID'
  | 'INTERNAL_ERROR';

export interface MvpStructuredError {
  code: MvpErrorCode;
  stage: MvpFailureStage;
  message: string;
  retryable: boolean;
  recommendedAction: string;
  providerHttpStatus?: number | null;
  providerStatus?: string | null;
  technicalMessage?: string | null;
}

export interface MvpVideoTask {
  taskId: string;
  idempotencyKeyHash?: string;
  status: MvpTaskStatus;
  stage: MvpFailureStage | 'ready';
  provider: typeof MVP_PROVIDER;
  model: typeof MVP_VIDEO_MODEL;
  projectId: string;
  region: string;
  prompt: string;
  durationSeconds: number;
  inputMimeType: string;
  inputSha256: string;
  inputSizeBytes: number;
  providerStorageUri: string;
  operationName?: string | null;
  pollAttempt: number;
  outputBucket?: string | null;
  outputObjectPath?: string | null;
  videoUri?: string | null;
  sizeBytes?: number | null;
  contentType?: string | null;
  artifactPersisted: boolean;
  artifactVerified: boolean;
  error?: MvpStructuredError | null;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
}

export function isArtifactOnlyCompletionSatisfied(task: Partial<MvpVideoTask>): boolean {
  return Boolean(
    task.artifactPersisted === true &&
    task.artifactVerified === true &&
    task.outputBucket &&
    task.outputObjectPath &&
    task.videoUri &&
    typeof task.sizeBytes === 'number' &&
    task.sizeBytes >= 1000 &&
    (task.contentType || '').toLowerCase().startsWith('video/')
  );
}

export function assertArtifactOnlyCompletion(task: Partial<MvpVideoTask>): void {
  if (!isArtifactOnlyCompletionSatisfied(task)) {
    throw new Error(
      'MVP_ARTIFACT_COMPLETION_INVARIANT: COMPLETED requires a verified persisted video artifact.'
    );
  }
}

export function normalizeProviderFailureReason(input: {
  failureReason?: string | null;
  message?: string | null;
  httpStatus?: number | null;
  providerStatus?: string | null;
}): MvpStructuredError {
  const failureReason = String(input.failureReason || '').toLowerCase();
  const message = String(input.message || 'Video generation failed.');
  const providerStatus = input.providerStatus || null;
  const httpStatus = input.httpStatus ?? null;

  if (failureReason === 'output_rai_filtered' || /safety|rai_media_filtered/i.test(message)) {
    return {
      code: 'SAFETY_REJECTED',
      stage: 'generation',
      message,
      retryable: false,
      recommendedAction: '调整输入图片或 Prompt 后创建新任务。',
      providerHttpStatus: httpStatus,
      providerStatus,
    };
  }

  if (failureReason === 'upstream_empty_response' || failureReason === 'artifact_missing') {
    return {
      code: 'OUTPUT_MISSING',
      stage: 'output_fetch',
      message,
      retryable: true,
      recommendedAction: '确认当前任务无可恢复产物后再创建新任务。',
      providerHttpStatus: httpStatus,
      providerStatus,
    };
  }

  if (failureReason === 'artifact_fetch_failed' || failureReason === 'network_fetch_failed') {
    return {
      code: 'OUTPUT_DOWNLOAD_FAILED',
      stage: 'output_fetch',
      message,
      retryable: true,
      recommendedAction: '先重试产物恢复；不要直接重复提交 Veo。',
      providerHttpStatus: httpStatus,
      providerStatus,
    };
  }

  if (failureReason === 'artifact_invalid' || failureReason === 'legacy_invalid_artifact') {
    return {
      code: 'OUTPUT_INVALID',
      stage: 'output_fetch',
      message,
      retryable: true,
      recommendedAction: '当前产物不是有效视频；确认无其他可恢复产物后重新生成。',
      providerHttpStatus: httpStatus,
      providerStatus,
    };
  }

  if (failureReason === 'quota_or_rate_limited' || httpStatus === 429 || providerStatus === 'RESOURCE_EXHAUSTED') {
    return {
      code: 'RATE_LIMITED',
      stage: 'submit',
      message,
      retryable: true,
      recommendedAction: '稍后创建新任务，或检查 Vertex AI 配额与容量。',
      providerHttpStatus: httpStatus,
      providerStatus,
    };
  }

  return {
    code: 'GENERATION_FAILED',
    stage: 'generation',
    message,
    retryable: true,
    recommendedAction: '查看技术错误；若 Provider 已明确失败，可创建新任务。',
    providerHttpStatus: httpStatus,
    providerStatus,
  };
}
