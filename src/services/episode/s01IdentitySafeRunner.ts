export type ChatGptConversationFileRef =
  | string
  | {
      id?: string;
      name?: string;
      mime_type?: string;
      download_link?: string;
    };

export const S01_DEFAULT_PROMPT = [
  'EP001 S01. MeiNing is seated at a small rental-room work desk at night, organizing EVA foam, tape and an unfinished handmade fantasy staff.',
  'Keep the approved starting image identity and composition unchanged.',
  'Only subtle natural motion: gentle breathing, small careful hand movements while organizing materials, and a very slow cinematic push-in.',
  'Keep face, hairstyle, outfit, body proportions, desk props and room layout stable for the entire clip.',
  'No sudden pose change, no face drift, no identity swap, no extra limbs, no object disappearance.',
].join(' ');

export interface S01IdentitySafeRunnerConfig {
  gatewayBaseUrl: string;
  apiKey?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export interface S01IdentitySafeRunInput {
  openaiFileRef: ChatGptConversationFileRef;
  idempotencyKey: string;
  prompt?: string;
  durationSeconds?: 4;
  episodeId?: string;
  shotId?: string;
}

export interface S01IdentitySafeRunResult {
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

interface RunnerDependencies {
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
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
    throw new Error('S01_GATEWAY_URL_INVALID');
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
    throw new Error('S01_IDEMPOTENCY_KEY_INVALID');
  }
  return key;
}

export class S01IdentitySafeRunner {
  private readonly gatewayBaseUrl: string;
  private readonly apiKey?: string;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: SleepLike;

  constructor(config: S01IdentitySafeRunnerConfig, deps: RunnerDependencies = {}) {
    this.gatewayBaseUrl = normalizeBaseUrl(config.gatewayBaseUrl);
    this.apiKey = String(config.apiKey || '').trim() || undefined;
    this.pollIntervalMs = Math.max(0, Number(config.pollIntervalMs ?? 10_000));
    this.maxPolls = Math.max(1, Math.min(200, Number(config.maxPolls ?? 72)));
    this.fetchImpl = deps.fetchImpl || fetch;
    this.sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    };
  }

  private async json(path: string, init: RequestInit = {}): Promise<{ response: Response; body: any }> {
    const response = await this.fetchImpl(`${this.gatewayBaseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers(),
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    });
    const text = await response.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`S01_GATEWAY_INVALID_JSON:${response.status}`);
    }
    return { response, body };
  }

  private async preflight(fileRef: ChatGptConversationFileRef): Promise<void> {
    const { response, body } = await this.json('/v1/images/preflight', {
      method: 'POST',
      body: JSON.stringify({ openaiFileIdRefs: [fileRef] }),
    });
    if (!response.ok || body?.ok !== true || body?.status !== 'PREFLIGHT_OK') {
      throw new Error(`S01_PREFLIGHT_FAILED:${body?.error || body?.status || response.status}`);
    }
  }

  private async resolveIntent(idempotencyKey: string): Promise<GatewayTask | null> {
    const { response, body } = await this.json('/v1/videos/resolve', {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey }),
    });
    if (!response.ok || body?.ok === false || body?.status === 'RESOLVE_FAILED') {
      throw new Error(`S01_RESOLVE_FAILED:${body?.error || body?.status || response.status}`);
    }
    if (body?.status === 'INTENT_NOT_FOUND' || !body?.taskId) return null;
    return body as GatewayTask;
  }

  private async createVideo(input: {
    fileRef: ChatGptConversationFileRef;
    prompt: string;
    durationSeconds: 4;
    idempotencyKey: string;
  }): Promise<GatewayTask> {
    try {
      const { response, body } = await this.json('/v1/videos', {
        method: 'POST',
        body: JSON.stringify({
          prompt: input.prompt,
          durationSeconds: input.durationSeconds,
          idempotencyKey: input.idempotencyKey,
          openaiFileIdRefs: [input.fileRef],
        }),
      });

      if (
        body?.status === 'UPSTREAM_OUTCOME_UNKNOWN' ||
        body?.error === 'UPSTREAM_REQUEST_AND_LOOKUP_FAILED'
      ) {
        const recovered = await this.resolveIntent(input.idempotencyKey);
        if (recovered?.taskId) return recovered;
        throw new Error('S01_CREATE_OUTCOME_UNKNOWN');
      }

      if (!response.ok || body?.ok === false || !body?.taskId) {
        throw new Error(`S01_CREATE_FAILED:${body?.error || body?.status || response.status}`);
      }
      return body as GatewayTask;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('S01_CREATE_FAILED:')) throw error;
      if (error instanceof Error && error.message === 'S01_CREATE_OUTCOME_UNKNOWN') throw error;

      const recovered = await this.resolveIntent(input.idempotencyKey);
      if (recovered?.taskId) return recovered;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`S01_CREATE_TRANSPORT_FAILED:${message}`);
    }
  }

  private async waitForCompletion(initial: GatewayTask): Promise<GatewayTask> {
    const taskId = String(initial.taskId || '').trim();
    if (!taskId) throw new Error('S01_TASK_ID_MISSING');
    if (String(initial.status || '').toUpperCase() === 'COMPLETED' && initial.videoReady !== false) {
      return initial;
    }

    for (let poll = 1; poll <= this.maxPolls; poll++) {
      if (poll > 1 || this.pollIntervalMs > 0) await this.sleep(this.pollIntervalMs);
      const { response, body } = await this.json(`/v1/videos/${encodeURIComponent(taskId)}`);
      if (!response.ok && response.status !== 202) {
        throw new Error(`S01_POLL_HTTP_FAILED:${response.status}`);
      }
      const task = body as GatewayTask;
      if (terminalFailure(task.status) || task.error) {
        throw new Error(`S01_VIDEO_FAILED:${task.status || 'UNKNOWN'}:${JSON.stringify(task.error || null)}`);
      }
      if (String(task.status || '').toUpperCase() === 'COMPLETED' && task.videoReady === true) {
        return task;
      }
    }
    throw new Error('S01_VIDEO_POLL_TIMEOUT');
  }

  private async artifact(taskId: string): Promise<any> {
    const { response, body } = await this.json(`/v1/videos/${encodeURIComponent(taskId)}/artifact`);
    if (!response.ok || !body?.videoUrl || !body?.downloadUrl) {
      throw new Error(`S01_ARTIFACT_NOT_READY:${body?.error || response.status}`);
    }
    return body;
  }

  public async run(input: S01IdentitySafeRunInput): Promise<S01IdentitySafeRunResult> {
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const durationSeconds = input.durationSeconds ?? 4;
    if (durationSeconds !== 4) throw new Error('S01_DURATION_MUST_BE_4_SECONDS');
    const prompt = String(input.prompt || S01_DEFAULT_PROMPT).trim();
    if (!prompt) throw new Error('S01_PROMPT_REQUIRED');

    await this.preflight(input.openaiFileRef);
    const created = await this.createVideo({
      fileRef: input.openaiFileRef,
      prompt,
      durationSeconds,
      idempotencyKey,
    });
    const completed = await this.waitForCompletion(created);
    const artifact = await this.artifact(String(completed.taskId));

    return {
      episodeId: String(input.episodeId || 'MN-EP001'),
      shotId: String(input.shotId || 'S01'),
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
