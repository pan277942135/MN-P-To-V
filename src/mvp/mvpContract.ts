import type { MvpIdentityQaReport } from './identitySafe';

export const MVP_PROVIDER = 'vertex' as const;
export const MVP_VIDEO_MODEL = 'veo-3.1-fast-generate-001' as const;
export const MVP_ALLOWED_DURATIONS = [4, 6, 8] as const;

export type MvpTaskStatus =
  | 'PREPARING'
  | 'SUBMITTING'
  | 'GENERATING'
  | 'SAVING'
  | 'QUALITY_CHECKING'
  | 'RETRYING'
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
  | 'identity_qa'
  | 'artifact_persist'
  | 'internal';

export type MvpErrorCode =
  | 'INPUT_IMAGE_INVALID'
  | 'PROMPT_INVALID'
  | 'IDENTITY_INPUT_UNSAFE'
  | 'AUTH_FAILED'
  | 'REQUEST_REJECTED'
  | 'SAFETY_REJECTED'
  | 'RATE_LIMITED'
  | 'GENERATION_FAILED'
  | 'GENERATION_TIMEOUT'
  | 'OUTPUT_MISSING'
  | 'OUTPUT_DOWNLOAD_FAILED'
  | 'OUTPUT_INVALID'
  | 'IDENTITY_QA_UNAVAILABLE'
  | 'IDENTITY_DRIFT'
  | 'IDENTITY_RETRY_FAILED'
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
  providerCode?: number | null;
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
  effectivePrompt?: string;
  identitySafeMode?: boolean;
  durationSeconds: number;
  inputMimeType: string;
  inputSha256: string;
  inputSizeBytes: number;
  inputBucket?: string | null;
  inputObjectPath?: string | null;
  providerStorageUri: string;
  providerAttempt?: number;
  identityRetryCount?: number;
  operationName?: string | null;
  pollAttempt: number;
  identityQaModel?: string | null;
  identityReport?: MvpIdentityQaReport | null;
  firstAttemptIdentityReport?: MvpIdentityQaReport | null;
  retryReason?: string | null;
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

export function isIdentitySafeCompletionSatisfied(task: Partial<MvpVideoTask>): boolean {
  if (!isArtifactOnlyCompletionSatisfied(task)) return false;
  if (task.identitySafeMode !== true) return true;
  return Boolean(task.identityReport?.pass === true && task.identityReport?.gateStatus === 'pass');
}

export function assertIdentitySafeCompletion(task: Partial<MvpVideoTask>): void {
  if (!isIdentitySafeCompletionSatisfied(task)) {
    throw new Error(
      'MVP_IDENTITY_COMPLETION_INVARIANT: Identity Safe COMPLETED requires verified video artifact and passing identity QA.'
    );
  }
}

function unwrapProviderMessage(input: unknown): string {
  let value = String(input || '').trim();
  if (!value) return 'Video generation failed.';

  for (let i = 0; i < 3; i++) {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) break;
    try {
      const parsed: any = JSON.parse(trimmed);
      const nested = parsed?.message ?? parsed?.error?.message;
      if (typeof nested !== 'string' || !nested.trim() || nested.trim() === value) break;
      value = nested.trim();
    } catch {
      break;
    }
  }
  return value;
}

export function normalizeProviderFailureReason(input: {
  failureReason?: string | null;
  message?: string | null;
  httpStatus?: number | null;
  providerStatus?: string | null;
}): MvpStructuredError {
  const failureReason = String(input.failureReason || '').toLowerCase();
  const originalMessage = String(input.message || 'Video generation failed.');
  const message = unwrapProviderMessage(originalMessage);
  const rawNumericCode = input.httpStatus ?? null;
  const providerCode = typeof rawNumericCode === 'number' && (rawNumericCode < 100 || rawNumericCode > 599)
    ? rawNumericCode
    : null;
  const httpStatus = typeof rawNumericCode === 'number' && rawNumericCode >= 100 && rawNumericCode <= 599
    ? rawNumericCode
    : null;
  const suppliedProviderStatus = input.providerStatus || null;
  const deadlineExceeded =
    failureReason === 'polling_timeout' ||
    suppliedProviderStatus === 'DEADLINE_EXCEEDED' ||
    /\bdeadline[_ ]exceeded\b|\brequest timed out\b|\bgeneration timed out\b|\boperation timed out\b/i.test(message);

  if (failureReason === 'output_rai_filtered' || /safety|rai_media_filtered/i.test(message)) {
    return {
      code: 'SAFETY_REJECTED',
      stage: 'generation',
      message,
      retryable: false,
      recommendedAction: '调整输入图片或 Prompt 后创建新任务。',
      providerHttpStatus: httpStatus,
      providerCode,
      providerStatus: suppliedProviderStatus,
      technicalMessage: originalMessage !== message ? originalMessage : null,
    };
  }

  if (deadlineExceeded) {
    return {
      code: 'GENERATION_TIMEOUT',
      stage: 'generation',
      message,
      retryable: true,
      recommendedAction: 'Vertex 已明确结束当前 Operation 且未产出视频。可直接重新生成创建新任务；不要继续轮询旧 Operation。',
      providerHttpStatus: httpStatus,
      providerCode,
      providerStatus: suppliedProviderStatus || 'DEADLINE_EXCEEDED',
      technicalMessage: originalMessage !== message ? originalMessage : null,
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
      providerCode,
      providerStatus: suppliedProviderStatus,
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
      providerCode,
      providerStatus: suppliedProviderStatus,
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
      providerCode,
      providerStatus: suppliedProviderStatus,
    };
  }

  if (failureReason === 'quota_or_rate_limited' || httpStatus === 429 || suppliedProviderStatus === 'RESOURCE_EXHAUSTED') {
    return {
      code: 'RATE_LIMITED',
      stage: 'submit',
      message,
      retryable: true,
      recommendedAction: '稍后创建新任务，或检查 Vertex AI 配额与容量。',
      providerHttpStatus: httpStatus,
      providerCode,
      providerStatus: suppliedProviderStatus,
    };
  }

  return {
    code: 'GENERATION_FAILED',
    stage: 'generation',
    message,
    retryable: true,
    recommendedAction: '查看技术错误；若 Provider 已明确失败，可创建新任务。',
    providerHttpStatus: httpStatus,
    providerCode,
    providerStatus: suppliedProviderStatus,
    technicalMessage: originalMessage !== message ? originalMessage : null,
  };
}
