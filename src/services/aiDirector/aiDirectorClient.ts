import type {
  AiDirectorScope,
  DirectorAiTokenPublic,
} from './aiDirectorTypes';

export interface AiTokenListResponse {
  ok: true;
  projectId: string;
  tokens: DirectorAiTokenPublic[];
}

export interface AiTokenCreateResponse extends DirectorAiTokenPublic {
  ok: true;
  token: string;
}

export class AiDirectorClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'AiDirectorClientError';
    this.code = code;
    this.status = status;
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function readPayload(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    throw new AiDirectorClientError(
      'AI_DIRECTOR_RESPONSE_INVALID',
      `AI Director Gateway 返回了无法解析的响应（HTTP ${response.status}）。`,
      response.status,
    );
  }
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(input, init);
  const payload = await readPayload(response);
  if (!response.ok || !payload?.ok) {
    throw new AiDirectorClientError(
      String(payload?.error || 'AI_DIRECTOR_REQUEST_FAILED'),
      String(payload?.message || `AI Director Gateway 请求失败（HTTP ${response.status}）。`),
      response.status,
    );
  }
  return payload as T;
}

function managementHeaders(bindingCode: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Director-Binding-Code': clean(bindingCode),
  };
}

export async function createAiToken(
  input: {
    projectId: string;
    name: string;
    scope: AiDirectorScope[];
    expiresAt?: string;
  },
  bindingCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AiTokenCreateResponse> {
  return requestJson<AiTokenCreateResponse>('/api/ai/tokens', {
    method: 'POST',
    headers: managementHeaders(bindingCode),
    body: JSON.stringify({
      projectId: clean(input.projectId),
      name: clean(input.name),
      scope: input.scope,
      ...(clean(input.expiresAt) ? { expiresAt: clean(input.expiresAt) } : {}),
    }),
  }, fetchImpl);
}

export async function listAiTokens(
  projectId: string,
  bindingCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AiTokenListResponse> {
  const query = `?projectId=${encodeURIComponent(clean(projectId))}`;
  return requestJson<AiTokenListResponse>(`/api/ai/tokens${query}`, {
    method: 'GET',
    headers: managementHeaders(bindingCode),
    cache: 'no-store',
  }, fetchImpl);
}

export async function revokeAiToken(
  tokenId: string,
  bindingCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; tokenId: string; status: 'REVOKED' }> {
  return requestJson<{ ok: true; tokenId: string; status: 'REVOKED' }>(
    `/api/ai/tokens/${encodeURIComponent(clean(tokenId))}`,
    {
      method: 'DELETE',
      headers: managementHeaders(bindingCode),
    },
    fetchImpl,
  );
}
