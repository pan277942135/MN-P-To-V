export type ChatGptConversationFileRef =
  | string
  | {
      id?: string;
      name?: string;
      mime_type?: string;
      download_link?: string;
    };

export type ShotDurationSeconds = 4 | 6 | 8;
export type SupportedKeyframeMime = 'image/jpeg' | 'image/png' | 'image/webp';

export type ApprovedKeyframeInput =
  | {
      source: 'conversation_file';
      openaiFileRef: ChatGptConversationFileRef;
      sourceFileId?: string;
      assetId?: string;
      contentSha256?: string;
      version: number;
    }
  | {
      source: 'durable_gcs_asset';
      buffer: Buffer;
      mimeType: SupportedKeyframeMime;
      fileName: string;
      assetId: string;
      contentSha256: string;
      version: number;
      outputBucket: string;
      outputObjectPath: string;
    };

export const SHOT_DEFAULT_PROMPT = [
  'Use the approved starting image as the exact identity and composition anchor for this shot.',
  'Keep motion natural and conservative unless the shot prompt explicitly requires otherwise.',
  'Keep face, hairstyle, outfit, body proportions, important props and scene layout stable for the entire clip.',
  'No face drift, no identity swap, no extra limbs, no object disappearance, no abrupt camera movement.',
].join(' ');

export interface ShotIdentitySafeRunnerConfig {
  gatewayBaseUrl: string;
  apiKey?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export interface ShotIdentitySafeRunInput {
  keyframeInput?: ApprovedKeyframeInput;
  // Legacy compatibility for callers that still invoke the runner directly.
  openaiFileRef?: ChatGptConversationFileRef;
  idempotencyKey: string;
  prompt?: string;
  durationSeconds: ShotDurationSeconds;
  episodeId: string;
  shotId: string;
}

export interface ShotIdentitySafeRunResult {
  episodeId: string;
  shotId: string;
  taskId: string;
  status: 'COMPLETED';
  videoUrl: string;
  downloadUrl: string;
  expiresAt?: string | null;
  providerAttempt: number;
  identityReport?: unknown;
  artifactPersisted: boolean;
  artifactVerified: boolean;
}

type FetchLike = typeof fetch;
type SleepLike = (ms: number) => Promise<void>;

export interface ShotRunnerDependencies {
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
  onTaskCreated?: (task: {
    taskId: string;
    providerAttempt: number;
  }) => Promise<void>;
}

interface GatewayTask {
  taskId?: string | null;
  status?: string | null;
  stage?: string | null;
  providerAttempt?: number;
  identityReport?: unknown;
  artifactPersisted?: boolean;
  artifactVerified?: boolean;
  videoReady?: boolean;
  error?: unknown;
  ok?: boolean;
  retryable?: boolean;
}

function normalizeBaseUrl(raw: string): string {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(value)) {
    throw new Error('SHOT_GATEWAY_URL_INVALID');
  }
  return value;
}

function terminalFailure(status: string | null | undefined): boolean {
  const normalized = String(status || '').trim().toUpperCase();
  return new Set([
    'FAILED',
    'CANCELLED',
    'CANCELED',
    'ARTIFACT_PERSIST_FAILED',
    'ARTIFACT_MISSING',
    'ARTIFACT_FETCH_FAILED',
  ]).has(normalized);
}

function requireIdempotencyKey(value: string): string {
  const key = String(value || '').trim();
  if (key.length < 16 || key.length > 200) {
    throw new Error('SHOT_IDEMPOTENCY_KEY_INVALID');
  }
  return key;
}

function requireDuration(value: number): ShotDurationSeconds {
  if (value !== 4 && value !== 6 && value !== 8) {
    throw new Error('SHOT_DURATION_INVALID');
  }
  return value;
}

function legacyKeyframeInput(fileRef: ChatGptConversationFileRef): ApprovedKeyframeInput {
  return {
    source: 'conversation_file',
    openaiFileRef: fileRef,
    sourceFileId: typeof fileRef === 'string' ? fileRef : fileRef.id,
    version: 1,
  };
}

export class ShotIdentitySafeRunner {
  private readonly gatewayBaseUrl: string;
  private readonly apiKey?: string;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: SleepLike;
  private readonly onTaskCreated?: ShotRunnerDependencies['onTaskCreated'];

  constructor(config: ShotIdentitySafeRunnerConfig, deps: ShotRunnerDependencies = {}) {
    this.gatewayBaseUrl = normalizeBaseUrl(config.gatewayBaseUrl);
    this.apiKey = String(config.apiKey || '').trim() || undefined;
    this.pollIntervalMs = Math.max(0, Number(config.pollIntervalMs ?? 10_000));
    this.maxPolls = Math.max(1, Math.min(200, Number(config.maxPolls ?? 72)));
    this.fetchImpl = deps.fetchImpl || fetch;
    this.sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onTaskCreated = deps.onTaskCreated;
  }

  private headers(extra: Record<string, string> = {}, json = true): Record<string, string> {
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    };
  }

  private async parseResponse(response: Response): Promise<any> {
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`SHOT_GATEWAY_INVALID_JSON:${response.status}`);
    }
  }

  private async json(path: string, init: RequestInit = {}): Promise<{ response: Response; body: any }> {
    const response = await this.fetchImpl(`${this.gatewayBaseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers(),
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    });
    return { response, body: await this.parseResponse(response) };
  }

  private async preflight(fileRef: ChatGptConversationFileRef): Promise<void> {
    const { response, body } = await this.json('/v1/images/preflight', {
      method: 'POST',
      body: JSON.stringify({ openaiFileIdRefs: [fileRef] }),
    });
    if (!response.ok || body?.ok !== true || body?.status !== 'PREFLIGHT_OK') {
      throw new Error(`SHOT_PREFLIGHT_FAILED:${body?.error || body?.status || response.status}`);
    }
  }

  private async resolveIntent(idempotencyKey: string): Promise<GatewayTask | null> {
    const { response, body } = await this.json('/v1/videos/resolve', {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey }),
    });
    if (!response.ok || body?.ok === false || body?.status === 'RESOLVE_FAILED') {
      throw new Error(`SHOT_RESOLVE_FAILED:${body?.error || body?.status || response.status}`);
    }
    if (body?.status === 'INTENT_NOT_FOUND' || !body?.taskId) return null;
    return body as GatewayTask;
  }

  private async submitCreateRequest(input: {
    keyframeInput: ApprovedKeyframeInput;
    prompt: string;
    durationSeconds: ShotDurationSeconds;
    idempotencyKey: string;
  }): Promise<{ response: Response; body: any }> {
    if (input.keyframeInput.source === 'conversation_file') {
      return this.json('/v1/videos', {
        method: 'POST',
        body: JSON.stringify({
          prompt: input.prompt,
          durationSeconds: input.durationSeconds,
          idempotencyKey: input.idempotencyKey,
          openaiFileIdRefs: [input.keyframeInput.openaiFileRef],
        }),
      });
    }

    const form = new FormData();
    form.append(
      'image',
      new Blob([new Uint8Array(input.keyframeInput.buffer)], { type: input.keyframeInput.mimeType }),
      input.keyframeInput.fileName,
    );
    form.append('prompt', input.prompt);
    form.append('durationSeconds', String(input.durationSeconds));
    form.append('idempotencyKey', input.idempotencyKey);
    form.append('inputSource', 'durable_gcs_asset');
    form.append('assetId', input.keyframeInput.assetId);
    form.append('contentSha256', input.keyframeInput.contentSha256);
    form.append('keyframeVersion', String(input.keyframeInput.version));
    form.append('mimeType', input.keyframeInput.mimeType);
    form.append('outputBucket', input.keyframeInput.outputBucket);
    form.append('outputObjectPath', input.keyframeInput.outputObjectPath);

    const response = await this.fetchImpl(`${this.gatewayBaseUrl}/v1/videos/durable`, {
      method: 'POST',
      headers: this.headers({}, false),
      body: form,
    });
    return { response, body: await this.parseResponse(response) };
  }

  private async createVideo(input: {
    keyframeInput: ApprovedKeyframeInput;
    prompt: string;
    durationSeconds: ShotDurationSeconds;
    idempotencyKey: string;
  }): Promise<GatewayTask> {
    try {
      const { response, body } = await this.submitCreateRequest(input);

      if (
        body?.status === 'UPSTREAM_OUTCOME_UNKNOWN' ||
        body?.error === 'UPSTREAM_REQUEST_AND_LOOKUP_FAILED'
      ) {
        const recovered = await this.resolveIntent(input.idempotencyKey);
        if (recovered?.taskId) return recovered;
        throw new Error('SHOT_CREATE_OUTCOME_UNKNOWN');
      }

      if (!response.ok || body?.ok === false || !body?.taskId) {
        throw new Error(`SHOT_CREATE_FAILED:${body?.error || body?.status || response.status}`);
      }
      return body as GatewayTask;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SHOT_CREATE_FAILED:')) throw error;
      if (error instanceof Error && error.message === 'SHOT_CREATE_OUTCOME_UNKNOWN') throw error;

      const recovered = await this.resolveIntent(input.idempotencyKey);
      if (recovered?.taskId) return recovered;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`SHOT_CREATE_TRANSPORT_FAILED:${message}`);
    }
  }

  private async waitForCompletion(initial: GatewayTask): Promise<GatewayTask> {
    const taskId = String(initial.taskId || '').trim();
    if (!taskId) throw new Error('SHOT_TASK_ID_MISSING');
    if (String(initial.status || '').toUpperCase() === 'COMPLETED' && initial.videoReady !== false) {
      return initial;
    }

    for (let poll = 1; poll <= this.maxPolls; poll++) {
      if (poll > 1 || this.pollIntervalMs > 0) await this.sleep(this.pollIntervalMs);
      const { response, body } = await this.json(`/v1/videos/${encodeURIComponent(taskId)}`);
      if (!response.ok && response.status !== 202) {
        throw new Error(`SHOT_POLL_HTTP_FAILED:${response.status}`);
      }
      const task = body as GatewayTask;
      if (terminalFailure(task.status) || task.error) {
        throw new Error(`SHOT_VIDEO_FAILED:${task.status || 'UNKNOWN'}:${JSON.stringify(task.error || null)}`);
      }
      if (String(task.status || '').toUpperCase() === 'COMPLETED' && task.videoReady === true) {
        return task;
      }
    }
    throw new Error('SHOT_VIDEO_POLL_TIMEOUT');
  }

  private async artifact(taskId: string): Promise<any> {
    const { response, body } = await this.json(`/v1/videos/${encodeURIComponent(taskId)}/artifact`);
    if (!response.ok || !body?.videoUrl || !body?.downloadUrl) {
      throw new Error(`SHOT_ARTIFACT_NOT_READY:${body?.error || response.status}`);
    }
    return body;
  }

  public async run(input: ShotIdentitySafeRunInput): Promise<ShotIdentitySafeRunResult> {
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const durationSeconds = requireDuration(input.durationSeconds);
    const episodeId = String(input.episodeId || '').trim();
    const shotId = String(input.shotId || '').trim();
    if (!episodeId || !shotId) throw new Error('SHOT_IDENTITY_REQUIRED');
    const prompt = String(input.prompt || SHOT_DEFAULT_PROMPT).trim();
    if (!prompt) throw new Error('SHOT_PROMPT_REQUIRED');

    const keyframeInput = input.keyframeInput || (input.openaiFileRef ? legacyKeyframeInput(input.openaiFileRef) : null);
    if (!keyframeInput) throw new Error('SHOT_KEYFRAME_INPUT_REQUIRED');

    if (keyframeInput.source === 'conversation_file') {
      await this.preflight(keyframeInput.openaiFileRef);
    }

    const created = await this.createVideo({
      keyframeInput,
      prompt,
      durationSeconds,
      idempotencyKey,
    });
    if (created.taskId && this.onTaskCreated) {
      await this.onTaskCreated({
        taskId: String(created.taskId),
        providerAttempt: Number(created.providerAttempt || 1),
      });
    }
    const completed = await this.waitForCompletion(created);
    const artifact = await this.artifact(String(completed.taskId));

    return {
      episodeId,
      shotId,
      taskId: String(completed.taskId),
      status: 'COMPLETED',
      videoUrl: String(artifact.videoUrl),
      downloadUrl: String(artifact.downloadUrl),
      expiresAt: artifact.expiresAt ? String(artifact.expiresAt) : null,
      providerAttempt: Number(completed.providerAttempt || 1),
      identityReport: completed.identityReport,
      artifactPersisted: completed.artifactPersisted === true,
      artifactVerified: completed.artifactVerified === true,
    };
  }
}
