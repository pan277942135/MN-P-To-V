export interface ProjectBindingProject {
  projectId: string;
  seriesTitle: string;
  projectTitle: string;
  activeEpisodeId: string;
  createdAt?: number;
  updatedAt?: number;
}
export interface ProjectBindingEpisode {
  projectId: string;
  episodeId: string;
  seriesTitle: string;
  projectTitle: string;
  status: string;
  clientUpdatedAt?: number;
  updatedAt?: number;
}

export interface ProjectBindingRestoreResponse {
  ok: true;
  project: ProjectBindingProject;
  episode: ProjectBindingEpisode;
  shots: Array<Record<string, unknown>>;
  stages: Record<string, unknown>;
  assets: Array<Record<string, unknown>>;
  productionStatus: Record<string, unknown>;
  serverUpdatedAt: number;
}

export class ProjectBindingClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ProjectBindingClientError';
    this.code = code;
    this.status = status;
  }
}

async function readPayload(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    throw new ProjectBindingClientError(
      'PROJECT_BINDING_RESPONSE_INVALID',
      `Project Binding 服务返回了无法解析的响应（HTTP ${response.status}）。`,
      response.status,
    );
  }
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await readPayload(response);
  if (!response.ok || !payload?.ok) {
    throw new ProjectBindingClientError(
      String(payload?.error || 'PROJECT_BINDING_REQUEST_FAILED'),
      String(payload?.message || `Project Binding 请求失败（HTTP ${response.status}）。`),
      response.status,
    );
  }
  return payload as T;
}

export async function createProjectBinding(
  projectId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; bindingCode: string }> {
  return postJson('/api/director/project-binding/create', { projectId }, fetchImpl);
}

export async function restoreProjectByBinding(
  bindingCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectBindingRestoreResponse> {
  return postJson('/api/director/project-binding/restore', { bindingCode }, fetchImpl);
}
