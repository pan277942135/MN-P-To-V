export interface DirectorProjectListItem {
  projectId: string;
  projectTitle: string;
  cover?: string;
  status: string;
  episodeCount: number;
  shotCount: number;
  assetCount: number;
  updatedAt: string;
}

export interface CreateDirectorProjectInput {
  projectTitle: string;
  description: string;
  defaultAspectRatio: string;
}

export class DirectorProjectClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'DirectorProjectClientError';
    this.code = code;
    this.status = status;
  }
}

async function readPayload(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    throw new DirectorProjectClientError(
      'DIRECTOR_PROJECT_RESPONSE_INVALID',
      '项目服务返回了无法解析的响应（HTTP ' + response.status + '）。',
      response.status,
    );
  }
}

function normalizeProject(item: any): DirectorProjectListItem {
  return {
    projectId: String(item?.projectId || ''),
    projectTitle: String(item?.projectTitle || item?.title || '未命名项目'),
    cover: typeof item?.cover === 'string' ? item.cover : undefined,
    status: String(item?.status || 'ACTIVE'),
    episodeCount: Number(item?.episodeCount || 0),
    shotCount: Number(item?.shotCount || 0),
    assetCount: Number(item?.assetCount || 0),
    updatedAt: String(item?.updatedAt || ''),
  };
}

export async function getDirectorProjects(fetchImpl: typeof fetch = fetch): Promise<DirectorProjectListItem[]> {
  const response = await fetchImpl('/api/director/projects', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  const payload = await readPayload(response);
  if (!response.ok || payload?.ok === false) {
    throw new DirectorProjectClientError(
      String(payload?.error || 'DIRECTOR_PROJECT_LIST_FAILED'),
      String(payload?.message || ('项目列表请求失败（HTTP ' + response.status + '）。')),
      response.status,
    );
  }
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.projects) ? payload.projects : Array.isArray(payload?.items) ? payload.items : [];
  return items.map(normalizeProject).filter((item) => item.projectId);
}

export async function createDirectorProject(
  input: CreateDirectorProjectInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectorProjectListItem> {
  const response = await fetchImpl('/api/director/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await readPayload(response);
  if (!response.ok || payload?.ok === false) {
    throw new DirectorProjectClientError(
      String(payload?.error || 'DIRECTOR_PROJECT_CREATE_FAILED'),
      String(payload?.message || ('项目创建失败（HTTP ' + response.status + '）。')),
      response.status,
    );
  }
  return normalizeProject(payload?.project || payload);
}
