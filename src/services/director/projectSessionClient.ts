import type { DirectorAssetRecord } from '../assetRegistry/assetRegistryTypes';
import type { DirectorContext } from '../directorContext/directorContextTypes';

export interface ProjectSessionResponse {
  ok: true;
  project: Record<string, unknown>;
  episode: Record<string, unknown>;
  shots: Array<Record<string, unknown>>;
  assets: DirectorAssetRecord[];
  context: DirectorContext;
}

export class ProjectSessionClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ProjectSessionClientError';
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
    throw new ProjectSessionClientError(
      'PROJECT_SESSION_RESPONSE_INVALID',
      'Project Session 服务返回了无法解析的响应（HTTP ' + response.status + '）。',
      response.status,
    );
  }
}

export async function getProjectSession(
  projectIdInput: string,
  episodeIdInput = '',
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectSessionResponse> {
  const projectId = clean(projectIdInput);
  const episodeId = clean(episodeIdInput);
  const query = episodeId ? '?episodeId=' + encodeURIComponent(episodeId) : '';
  const response = await fetchImpl(
    '/api/director/project-session/' + encodeURIComponent(projectId) + query,
    { headers: { Accept: 'application/json' }, cache: 'no-store' },
  );
  const payload = await readPayload(response);
  if (!response.ok || !payload?.ok) {
    throw new ProjectSessionClientError(
      String(payload?.error || 'PROJECT_SESSION_REQUEST_FAILED'),
      String(payload?.message || ('Project Session 请求失败（HTTP ' + response.status + '）。')),
      response.status,
    );
  }
  return payload as ProjectSessionResponse;
}
