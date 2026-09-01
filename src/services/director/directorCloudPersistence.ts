import {
  CURRENT_SERIES_TITLE,
  DIRECTOR_DRAFT_KEY,
  KEYFRAME_BLUEPRINT_APPROVAL_KEY,
  KEYFRAME_BLUEPRINT_KEY,
  STORYBOARD_APPROVAL_KEY,
  STORYBOARD_KEY,
} from './keyframeBlueprint';
import {
  KEYFRAME_ASSET_APPROVAL_KEY,
  KEYFRAME_ASSET_KEY,
  type KeyframeAssetManifest,
} from './keyframeAsset';
import { KEYFRAME_QA_APPROVAL_KEY, KEYFRAME_QA_KEY } from './keyframeQa';
import { VIDEO_BLUEPRINT_APPROVAL_KEY, VIDEO_BLUEPRINT_KEY } from './videoBlueprint';
import { keyframeAssetStore } from './keyframeAssetStore';
import {
  hasFormatPolicy,
  LEGACY_FORMAT_POLICY,
  normalizeFormatPolicy,
  type ProductionFormatPolicy,
} from '../formatPolicy/formatPolicy';
import type { AssetValidation } from '../formatPolicy/formatPolicy';

export const DIRECTOR_CLOUD_SCHEMA = 'zaojing.director.cloud.v1' as const;
export const DIRECTOR_CLOUD_INTENT = 'director-cloud-v0.4.0' as const;
export const DIRECTOR_CLOUD_PROJECT_ID_KEY = 'zaojing_director_cloud_project_id';
export const DIRECTOR_CLOUD_EPISODE_ID_KEY = 'zaojing_director_cloud_episode_id';
export const DIRECTOR_CLOUD_ASSET_MAP_KEY = 'zaojing_director_cloud_keyframe_assets';
export const DIRECTOR_CLOUD_SYNC_META_KEY = 'zaojing_director_cloud_sync_meta';

const STAGE_KEYS = [
  ['brief', DIRECTOR_DRAFT_KEY],
  ['storyboard', STORYBOARD_KEY],
  ['storyboardApproval', STORYBOARD_APPROVAL_KEY],
  ['keyframeBlueprint', KEYFRAME_BLUEPRINT_KEY],
  ['keyframeBlueprintApproval', KEYFRAME_BLUEPRINT_APPROVAL_KEY],
  ['keyframeAssets', KEYFRAME_ASSET_KEY],
  ['keyframeAssetApproval', KEYFRAME_ASSET_APPROVAL_KEY],
  ['keyframeQa', KEYFRAME_QA_KEY],
  ['keyframeQaApproval', KEYFRAME_QA_APPROVAL_KEY],
  ['videoBlueprint', VIDEO_BLUEPRINT_KEY],
  ['videoBlueprintApproval', VIDEO_BLUEPRINT_APPROVAL_KEY],
] as const;

export interface DirectorCloudAssetRef {
  shotUid: string;
  blobKey: string;
  bucket: string;
  objectPath: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
  generation: string;
  updatedAt: number;
  width?: number;
  height?: number;
  aspectRatio?: string;
}

export interface DirectorCloudSnapshot {
  schema: typeof DIRECTOR_CLOUD_SCHEMA;
  projectId: string;
  episodeId: string;
  seriesTitle: string;
  projectTitle: string;
  clientUpdatedAt: number;
  stages: Record<string, any>;
  formatPolicy?: ProductionFormatPolicy;
}

export interface DirectorCloudRecord {
  snapshot: DirectorCloudSnapshot;
  serverUpdatedAt: number;
  assetUploads?: Array<{
    assetId: string;
    shotUid: string;
    blobKey: string;
    validation: AssetValidation;
  }>;
}

function readJson<T = any>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  if (value === null || value === undefined) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, JSON.stringify(value));
}

function randomId(prefix: string) {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uuid}`;
}

function ensureIdentity() {
  let projectId = window.localStorage.getItem(DIRECTOR_CLOUD_PROJECT_ID_KEY) || '';
  let episodeId = window.localStorage.getItem(DIRECTOR_CLOUD_EPISODE_ID_KEY) || '';
  if (!projectId) {
    projectId = randomId('project');
    window.localStorage.setItem(DIRECTOR_CLOUD_PROJECT_ID_KEY, projectId);
  }
  if (!episodeId) {
    episodeId = randomId('episode');
    window.localStorage.setItem(DIRECTOR_CLOUD_EPISODE_ID_KEY, episodeId);
  }
  return { projectId, episodeId };
}

function scanTimestamp(value: unknown, seen = new Set<unknown>()): number {
  if (!value || typeof value !== 'object') return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  let max = 0;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (typeof nested === 'number' && /(savedAt|approvedAt|updatedAt|createdAt|reviewedAt)$/i.test(key)) {
      max = Math.max(max, nested);
    } else if (nested && typeof nested === 'object') {
      max = Math.max(max, scanTimestamp(nested, seen));
    }
  }
  return max;
}

export function hasLocalDirectorData(): boolean {
  return STAGE_KEYS.some(([, localKey]) => Boolean(window.localStorage.getItem(localKey)));
}

export function collectDirectorLocalSnapshot(): DirectorCloudSnapshot {
  const { projectId, episodeId } = ensureIdentity();
  const stages: Record<string, any> = {};
  for (const [stageKey, localKey] of STAGE_KEYS) {
    const value = readJson(localKey);
    if (value !== null) stages[stageKey] = value;
  }
  const cloudAssets = readJson<{ items?: DirectorCloudAssetRef[] }>(DIRECTOR_CLOUD_ASSET_MAP_KEY);
  if (cloudAssets?.items?.length) stages.keyframeCloudAssets = cloudAssets;

  const brief = stages.brief || {};
  const blueprint = stages.keyframeBlueprint || {};
  const timestamps = STAGE_KEYS.map(([stageKey]) => scanTimestamp(stages[stageKey]));
  const clientUpdatedAt = Math.max(0, ...timestamps);
  return {
    schema: DIRECTOR_CLOUD_SCHEMA,
    projectId,
    episodeId,
    seriesTitle: String(blueprint.seriesTitle || CURRENT_SERIES_TITLE),
    projectTitle: String(brief.title || blueprint.projectTitle || '未命名 Director 项目'),
    clientUpdatedAt,
    stages,
    ...(hasFormatPolicy(brief.formatPolicy)
      ? { formatPolicy: normalizeFormatPolicy(brief.formatPolicy, LEGACY_FORMAT_POLICY) }
      : {}),
  };
}

export function computeDirectorLocalFingerprint(): string {
  return STAGE_KEYS.map(([stageKey, localKey]) => `${stageKey}:${window.localStorage.getItem(localKey) || ''}`).join('|');
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
    };
    reader.onerror = () => reject(reader.error || new Error('读取关键帧 Blob 失败。'));
    reader.readAsDataURL(blob);
  });
}

function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => window.clearTimeout(timer));
}

async function getCloudRecord(url: string): Promise<DirectorCloudRecord | null> {
  const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (response.status === 404) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || `Cloud persistence read failed (${response.status})`);
  return payload?.record || null;
}

export async function readCurrentDirectorCloudRecord(projectId: string, episodeId: string) {
  return getCloudRecord(`/api/director/persistence/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}`);
}

export async function readLatestDirectorCloudRecord() {
  return getCloudRecord('/api/director/persistence/latest');
}

async function buildAssetUploads(snapshot: DirectorCloudSnapshot) {
  const manifest = snapshot.stages.keyframeAssets as KeyframeAssetManifest | undefined;
  const cloudMap = snapshot.stages.keyframeCloudAssets as { items?: DirectorCloudAssetRef[] } | undefined;
  const existing = new Map((cloudMap?.items || []).map((item) => [`${item.shotUid}:${item.blobKey}`, item]));
  const uploads: Array<{ shotUid: string; blobKey: string; mimeType: string; base64: string; validate: boolean }> = [];
  if (!manifest?.assets?.length) return uploads;

  for (const asset of manifest.assets) {
    if (!asset.blobKey || !asset.shotUid) continue;
    if (existing.has(`${asset.shotUid}:${asset.blobKey}`)) continue;
    const blob = await keyframeAssetStore.get(asset.blobKey);
    if (!blob) continue;
    uploads.push({
      shotUid: asset.shotUid,
      blobKey: asset.blobKey,
      mimeType: blob.type || asset.mimeType || 'image/png',
      base64: await blobToBase64(blob),
      validate: true,
    });
  }
  return uploads;
}

export async function syncDirectorCloud(): Promise<DirectorCloudRecord> {
  const snapshot = collectDirectorLocalSnapshot();
  const assetUploads = await buildAssetUploads(snapshot);
  const response = await fetchWithTimeout('/api/director/persistence/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Director-Persistence-Intent': DIRECTOR_CLOUD_INTENT,
    },
    body: JSON.stringify({ snapshot, assetUploads }),
  }, 30000);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || `Cloud persistence sync failed (${response.status})`);
  const record = payload.record as DirectorCloudRecord;
  if (!record?.snapshot) throw new Error('Cloud persistence response missing snapshot.');
  const uploadResults = Array.isArray(payload.uploads)
    ? payload.uploads
    : Array.isArray(record.assetUploads) ? record.assetUploads : [];
  if (uploadResults.length) {
    const manifest = readJson<KeyframeAssetManifest>(KEYFRAME_ASSET_KEY);
    if (manifest?.assets) {
      writeJson(KEYFRAME_ASSET_KEY, {
        ...manifest,
        assets: manifest.assets.map((asset) => {
          const result = uploadResults.find((item: any) => item?.shotUid === asset.shotUid && item?.blobKey === asset.blobKey);
          return result?.validation ? { ...asset, validation: result.validation } : asset;
        }),
      });
    }
  }
  const cloudAssets = record.snapshot.stages?.keyframeCloudAssets;
  if (cloudAssets) writeJson(DIRECTOR_CLOUD_ASSET_MAP_KEY, cloudAssets);
  writeJson(DIRECTOR_CLOUD_SYNC_META_KEY, {
    projectId: record.snapshot.projectId,
    episodeId: record.snapshot.episodeId,
    clientUpdatedAt: record.snapshot.clientUpdatedAt,
    serverUpdatedAt: record.serverUpdatedAt,
    syncedAt: Date.now(),
  });
  return record;
}

async function restoreCloudAssets(snapshot: DirectorCloudSnapshot) {
  const cloudItems: DirectorCloudAssetRef[] = snapshot.stages?.keyframeCloudAssets?.items || [];
  for (const asset of cloudItems) {
    if (!asset?.shotUid || !asset?.blobKey) continue;
    const existing = await keyframeAssetStore.get(asset.blobKey);
    if (existing) continue;
    const url = `/api/director/persistence/assets/${encodeURIComponent(snapshot.projectId)}/${encodeURIComponent(snapshot.episodeId)}/${encodeURIComponent(asset.shotUid)}?blobKey=${encodeURIComponent(asset.blobKey)}`;
    const response = await fetchWithTimeout(url, { headers: { Accept: asset.mimeType || 'image/*' } }, 20000);
    if (!response.ok) throw new Error(`恢复 ${asset.shotUid} 关键帧失败 (${response.status})`);
    const blob = await response.blob();
    await keyframeAssetStore.put(asset.blobKey, asset.shotUid, blob);
  }
}

export async function applyDirectorCloudSnapshot(snapshot: DirectorCloudSnapshot, options?: { restoreAssets?: boolean }) {
  if (!snapshot || snapshot.schema !== DIRECTOR_CLOUD_SCHEMA) throw new Error('Director cloud snapshot schema invalid.');
  window.localStorage.setItem(DIRECTOR_CLOUD_PROJECT_ID_KEY, snapshot.projectId);
  window.localStorage.setItem(DIRECTOR_CLOUD_EPISODE_ID_KEY, snapshot.episodeId);
  for (const [stageKey, localKey] of STAGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snapshot.stages || {}, stageKey)) writeJson(localKey, snapshot.stages[stageKey]);
    else window.localStorage.removeItem(localKey);
  }
  if (snapshot.stages?.keyframeCloudAssets) writeJson(DIRECTOR_CLOUD_ASSET_MAP_KEY, snapshot.stages.keyframeCloudAssets);
  if (options?.restoreAssets !== false) await restoreCloudAssets(snapshot);
}

export async function bootstrapDirectorCloud(): Promise<{ mode: 'migrated' | 'restored' | 'synced' | 'empty'; record: DirectorCloudRecord | null }> {
  const localExists = hasLocalDirectorData();
  if (localExists) {
    const local = collectDirectorLocalSnapshot();
    const cloud = await readCurrentDirectorCloudRecord(local.projectId, local.episodeId);
    if (cloud && Number(cloud.snapshot.clientUpdatedAt || 0) > Number(local.clientUpdatedAt || 0)) {
      await applyDirectorCloudSnapshot(cloud.snapshot);
      return { mode: 'restored', record: cloud };
    }
    const record = await syncDirectorCloud();
    return { mode: cloud ? 'synced' : 'migrated', record };
  }

  const latest = await readLatestDirectorCloudRecord();
  if (!latest) return { mode: 'empty', record: null };
  await applyDirectorCloudSnapshot(latest.snapshot);
  return { mode: 'restored', record: latest };
}
