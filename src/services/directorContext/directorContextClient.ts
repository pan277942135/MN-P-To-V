import type {
  DirectorContext,
  DirectorShotContext,
} from './directorContextTypes';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function readContext<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.message || payload?.error || `Director Context 请求失败（HTTP ${response.status}）。`);
  }
  return payload as T;
}

export async function getProjectDirectorContext(
  projectId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectorContext> {
  const response = await fetchImpl(
    `/api/director/projects/${encodeURIComponent(clean(projectId))}/director-context`,
    { headers: { Accept: 'application/json' }, cache: 'no-store' },
  );
  return readContext<DirectorContext>(response);
}

export async function getEpisodeDirectorContext(
  projectId: string,
  episodeId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectorContext> {
  const response = await fetchImpl(
    `/api/director/projects/${encodeURIComponent(clean(projectId))}/episodes/${encodeURIComponent(clean(episodeId))}/director-context`,
    { headers: { Accept: 'application/json' }, cache: 'no-store' },
  );
  return readContext<DirectorContext>(response);
}

export async function getShotDirectorContext(
  shotUid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectorShotContext> {
  const response = await fetchImpl(
    `/api/director/shots/${encodeURIComponent(clean(shotUid))}/director-context`,
    { headers: { Accept: 'application/json' }, cache: 'no-store' },
  );
  return readContext<DirectorShotContext>(response);
}
