import type {
  DirectorAssetPreviewResponse,
  DirectorAssetListFilters,
  DirectorAssetPatch,
  DirectorAssetRecord,
} from './assetRegistryTypes';

export interface DirectorAssetListResponse {
  total: number;
  assets: DirectorAssetRecord[];
}

export interface DirectorShotAssetResponse {
  shotUid: string;
  images: DirectorAssetRecord[];
  videos: DirectorAssetRecord[];
  audio: DirectorAssetRecord[];
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function queryString(filters: DirectorAssetListFilters = {}): string {
  const params = new URLSearchParams();
  const entries: Array<[string, unknown]> = [
    ['projectId', filters.projectId],
    ['episodeId', filters.episodeId],
    ['shotUid', filters.shotUid],
    ['assetType', filters.assetType],
    ['mediaType', filters.mediaType],
    ['status', filters.status],
  ];
  for (const [key, value] of entries) {
    const next = clean(value);
    if (next) params.set(key, next);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.message || payload?.error || `Asset Registry 请求失败（HTTP ${response.status}）。`);
  }
  return payload as T;
}

export async function listProjectAssets(
  projectId: string,
  filters: Omit<DirectorAssetListFilters, 'projectId'> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<DirectorAssetListResponse> {
  const response = await fetchImpl(
    `/api/director/projects/${encodeURIComponent(clean(projectId))}/assets${queryString(filters)}`,
    { headers: { Accept: 'application/json' }, cache: 'no-store' },
  );
  return readJson<DirectorAssetListResponse>(response);
}

export async function listShotAssets(
  shotUid: string,
  filters: Omit<DirectorAssetListFilters, 'shotUid'> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<DirectorShotAssetResponse> {
  const response = await fetchImpl(
    `/api/director/shots/${encodeURIComponent(clean(shotUid))}/assets${queryString(filters)}`,
    { headers: { Accept: 'application/json' }, cache: 'no-store' },
  );
  return readJson<DirectorShotAssetResponse>(response);
}

export async function updateDirectorAsset(
  assetId: string,
  patch: DirectorAssetPatch,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectorAssetRecord> {
  const response = await fetchImpl(`/api/director/assets/${encodeURIComponent(clean(assetId))}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(patch),
  });
  const payload = await readJson<{ asset: DirectorAssetRecord }>(response);
  return payload.asset;
}

export type AssetPreviewContentVariant = 'thumbnail' | 'medium' | 'video-preview' | 'frame' | 'original';

export function assetPreviewContentUrl(assetId: string, variant: AssetPreviewContentVariant, frameIndex?: number): string {
  const base = `/api/director/assets/${encodeURIComponent(clean(assetId))}/preview/content/${variant}`;
  return variant === 'frame' && frameIndex ? `${base}/${frameIndex}` : base;
}

export function assetPreviewUrl(asset: Pick<DirectorAssetRecord, 'assetId' | 'assetType'>): string {
  if (asset.assetType === 'IMAGE') return assetPreviewContentUrl(asset.assetId, 'thumbnail');
  if (asset.assetType === 'VIDEO') return assetPreviewContentUrl(asset.assetId, 'video-preview');
  return assetPreviewContentUrl(asset.assetId, 'original');
}

export async function getAssetPreview(
  assetId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectorAssetPreviewResponse> {
  const response = await fetchImpl(`/api/director/assets/${encodeURIComponent(clean(assetId))}/preview`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  return readJson<DirectorAssetPreviewResponse>(response);
}

export async function requestAssetPreview(
  assetId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ assetId: string; status: string }> {
  const response = await fetchImpl(`/api/director/assets/${encodeURIComponent(clean(assetId))}/preview/generate`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  return readJson<{ assetId: string; status: string }>(response);
}

export async function requestProjectPreviews(
  projectId: string,
  episodeId = '',
  fetchImpl: typeof fetch = fetch,
): Promise<{ total: number; queued: number }> {
  const query = episodeId ? `?episodeId=${encodeURIComponent(clean(episodeId))}` : '';
  const response = await fetchImpl(`/api/director/projects/${encodeURIComponent(clean(projectId))}/previews/generate${query}`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  return readJson<{ total: number; queued: number }>(response);
}
