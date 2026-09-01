import express from 'express';
import {
  isDirectorAssetStatus,
  isDirectorAssetType,
  type DirectorAssetListFilters,
  type DirectorAssetPatch,
} from '../../../services/assetRegistry/assetRegistryTypes';
import {
  directorAssetRepository,
  normalizeDirectorAsset,
  type DirectorAssetRepositoryLike,
} from '../../repositories/directorAssetRepository';
import {
  assetRegistrySyncService,
  type AssetRegistrySyncServiceLike,
} from './assetRegistrySyncService';
import { directorGcsStore } from '../../storage/directorGcsStore';
import {
  assetPreviewService,
  type AssetPreviewGatewayLike,
} from '../assetPreview/assetPreviewService';
import type { DirectorAssetRecord } from '../../../services/assetRegistry/assetRegistryTypes';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorStatus(error: any, fallback = 500): number {
  const status = Number(error?.statusCode || error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback;
}

function errorCode(error: any, fallback: string): string {
  return typeof error?.code === 'string' && error.code.trim() ? error.code.trim() : fallback;
}

function filtersFromQuery(query: express.Request['query']): DirectorAssetListFilters {
  const assetType = clean(query.assetType);
  const status = clean(query.status);
  return {
    episodeId: clean(query.episodeId) || undefined,
    shotUid: clean(query.shotUid) || undefined,
    assetType: assetType && isDirectorAssetType(assetType) ? assetType : undefined,
    mediaType: clean(query.mediaType) || undefined,
    status: status && isDirectorAssetStatus(status) ? status : undefined,
  };
}

export interface DirectorAssetBinaryReaderLike {
  getAsset(ref: { bucket: string; objectPath: string }): Promise<{ buffer: Buffer; mimeType: string }>;
}

type PreviewContentVariant = 'thumbnail' | 'medium' | 'video-preview' | 'frame' | 'original';

const defaultBinaryReader: DirectorAssetBinaryReaderLike = {
  getAsset: ({ bucket, objectPath }) => directorGcsStore.getAsset({ bucket, objectPath }),
};

export function createDirectorAssetRouter(
  service: AssetRegistrySyncServiceLike = assetRegistrySyncService,
  repository: DirectorAssetRepositoryLike = directorAssetRepository,
  binaryReader: DirectorAssetBinaryReaderLike = defaultBinaryReader,
  previewGateway: AssetPreviewGatewayLike = assetPreviewService,
) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  router.get('/projects/:projectId/assets', async (req, res) => {
    const projectId = clean(req.params.projectId);
    if (!projectId) return res.status(400).json({ ok: false, error: 'PROJECT_ID_REQUIRED', message: 'projectId 不能为空。' });
    if (!repository.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_ASSET_STORAGE_UNAVAILABLE', message: 'Director Asset Registry 当前不可用。' });
    }

    try {
      // The first read also performs a best-effort projection of legacy Director
      // Cloud keyframes, so existing projects become visible without a destructive
      // migration or a second source of truth.
      await service.syncProjectAssets(projectId, clean(req.query.episodeId) || undefined);
      const assets = await repository.listAssets({ projectId, ...filtersFromQuery(req.query) });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ total: assets.length, assets });
    } catch (error: any) {
      return res.status(errorStatus(error)).json({
        ok: false,
        error: errorCode(error, 'DIRECTOR_ASSET_LIST_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get('/shots/:shotUid/assets', async (req, res) => {
    const shotUid = clean(req.params.shotUid);
    if (!shotUid) return res.status(400).json({ ok: false, error: 'SHOT_UID_REQUIRED', message: 'shotUid 不能为空。' });
    if (!repository.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_ASSET_STORAGE_UNAVAILABLE', message: 'Director Asset Registry 当前不可用。' });
    }

    try {
      const assets = await repository.listAssets({
        ...filtersFromQuery(req.query),
        shotUid,
        projectId: clean(req.query.projectId) || undefined,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        shotUid,
        images: assets.filter((asset) => asset.assetType === 'IMAGE'),
        videos: assets.filter((asset) => asset.assetType === 'VIDEO'),
        audio: assets.filter((asset) => asset.assetType === 'AUDIO'),
      });
    } catch (error: any) {
      return res.status(errorStatus(error)).json({
        ok: false,
        error: errorCode(error, 'DIRECTOR_SHOT_ASSET_LIST_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post('/assets/register', async (req, res) => {
    if (!repository.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_ASSET_STORAGE_UNAVAILABLE', message: 'Director Asset Registry 当前不可用。' });
    }
    try {
      const asset = normalizeDirectorAsset(req.body);
      const saved = await service.registerAsset(asset);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, asset: saved });
    } catch (error: any) {
      return res.status(errorStatus(error, 400)).json({
        ok: false,
        error: errorCode(error, 'DIRECTOR_ASSET_REGISTER_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.patch('/assets/:assetId', async (req, res) => {
    const assetId = clean(req.params.assetId);
    if (!assetId) return res.status(400).json({ ok: false, error: 'ASSET_ID_REQUIRED', message: 'assetId 不能为空。' });
    if (!repository.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_ASSET_STORAGE_UNAVAILABLE', message: 'Director Asset Registry 当前不可用。' });
    }

    try {
      const patch = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body as DirectorAssetPatch
        : {};
      if (patch.status !== undefined && !isDirectorAssetStatus(patch.status)) {
        return res.status(400).json({ ok: false, error: 'DIRECTOR_ASSET_STATUS_INVALID', message: '资产 status 无效。' });
      }
      if (patch.review?.status !== undefined && !['PENDING', 'APPROVED', 'REJECTED'].includes(String(patch.review.status))) {
        return res.status(400).json({ ok: false, error: 'DIRECTOR_ASSET_REVIEW_STATUS_INVALID', message: '资产审核状态无效。' });
      }
      const updated = await repository.updateAsset(assetId, patch);
      if (!updated) return res.status(404).json({ ok: false, error: 'DIRECTOR_ASSET_NOT_FOUND', message: '找不到指定资产。' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, asset: updated });
    } catch (error: any) {
      return res.status(errorStatus(error, 400)).json({
        ok: false,
        error: errorCode(error, 'DIRECTOR_ASSET_UPDATE_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const pathForVariant = (asset: DirectorAssetRecord, variant: PreviewContentVariant, frameIndex?: number): string => {
    if (variant === 'thumbnail') return clean(asset.preview?.thumbnailPath) || clean(asset.storage.thumbnailPath);
    if (variant === 'medium') return clean(asset.preview?.mediumPreviewPath) || clean(asset.preview?.previewPath);
    if (variant === 'video-preview') return clean(asset.preview?.videoPreviewPath) || clean(asset.preview?.previewPath);
    if (variant === 'frame') return clean(asset.preview?.framePaths?.[Math.max(0, Number(frameIndex || 1) - 1)]);
    return clean(asset.storage.previewPath) || clean(asset.storage.path);
  };

  const streamPreview = async (asset: DirectorAssetRecord, variant: PreviewContentVariant, frameIndex: number | undefined, res: express.Response) => {
    const configuredPath = pathForVariant(asset, variant, frameIndex);
    const fallbackPath = configuredPath || (variant === 'frame' ? '' : clean(asset.storage.previewPath) || clean(asset.storage.path));
    if (!fallbackPath) {
      return res.status(404).json({ ok: false, error: variant === 'frame' ? 'DIRECTOR_ASSET_FRAME_NOT_FOUND' : 'DIRECTOR_ASSET_PREVIEW_NOT_FOUND', message: '资产没有可用的预览位置。' });
    }
    if (/^https?:\/\//i.test(fallbackPath) || fallbackPath.startsWith('/')) {
      return res.redirect(302, fallbackPath);
    }
    const match = fallbackPath.match(/^gs:\/\/([^/]+)\/(.+)$/i);
    const bucket = match?.[1] || clean(asset.storage.bucket);
    const objectPath = match?.[2] || fallbackPath;
    if (!bucket || !objectPath) {
      return res.status(404).json({ ok: false, error: 'DIRECTOR_ASSET_PREVIEW_NOT_FOUND', message: '资产没有可读取的 GCS 预览位置。' });
    }
    const file = await binaryReader.getAsset({ bucket, objectPath });
    res.setHeader('Content-Type', file.mimeType || asset.metadata.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Length', String(file.buffer.length));
    return res.status(200).send(file.buffer);
  };

  // The public contract is JSON metadata. `?raw=true` remains as a narrow
  // compatibility escape hatch for older clients that used the route as a
  // direct binary source before Preview Gateway existed.
  router.get('/assets/:assetId/preview', async (req, res) => {
    const assetId = clean(req.params.assetId);
    if (!assetId) return res.status(400).json({ ok: false, error: 'ASSET_ID_REQUIRED', message: 'assetId 不能为空。' });
    if (!repository.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_ASSET_STORAGE_UNAVAILABLE', message: 'Director Asset Registry 当前不可用。' });
    }

    try {
      const asset = await repository.getAsset(assetId);
      if (!asset || asset.status === 'DELETED') {
        return res.status(404).json({ ok: false, error: 'DIRECTOR_ASSET_NOT_FOUND', message: '找不到指定资产。' });
      }
      if (String(req.query.raw || '').toLowerCase() === 'true' || String(req.query.format || '').toLowerCase() === 'binary') {
        const variant: PreviewContentVariant = asset.assetType === 'IMAGE'
          ? 'thumbnail'
          : asset.assetType === 'VIDEO' ? 'video-preview' : 'original';
        return streamPreview(asset, variant, undefined, res);
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, ...previewGateway.describeAssetPreview(asset) });
    } catch (error: any) {
      return res.status(errorStatus(error)).json({
        ok: false,
        error: errorCode(error, 'DIRECTOR_ASSET_PREVIEW_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get('/assets/:assetId/preview/content/:variant/:frameIndex?', async (req, res) => {
    const assetId = clean(req.params.assetId);
    const variant = clean(req.params.variant) as PreviewContentVariant;
    const validVariants: PreviewContentVariant[] = ['thumbnail', 'medium', 'video-preview', 'frame', 'original'];
    if (!assetId) return res.status(400).json({ ok: false, error: 'ASSET_ID_REQUIRED', message: 'assetId 不能为空。' });
    if (!validVariants.includes(variant)) return res.status(400).json({ ok: false, error: 'DIRECTOR_PREVIEW_VARIANT_INVALID', message: '预览类型无效。' });
    const frameIndex = req.params.frameIndex ? Number(req.params.frameIndex) : undefined;
    if (variant === 'frame' && (!Number.isInteger(frameIndex) || Number(frameIndex) < 1 || Number(frameIndex) > 5)) {
      return res.status(400).json({ ok: false, error: 'DIRECTOR_PREVIEW_FRAME_INVALID', message: '帧序号必须是 1 到 5。' });
    }
    if (!repository.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_ASSET_STORAGE_UNAVAILABLE', message: 'Director Asset Registry 当前不可用。' });
    }
    try {
      const asset = await repository.getAsset(assetId);
      if (!asset || asset.status === 'DELETED') {
        return res.status(404).json({ ok: false, error: 'DIRECTOR_ASSET_NOT_FOUND', message: '找不到指定资产。' });
      }
      return streamPreview(asset, variant, frameIndex, res);
    } catch (error: any) {
      return res.status(errorStatus(error)).json({
        ok: false,
        error: errorCode(error, 'DIRECTOR_ASSET_PREVIEW_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post('/assets/:assetId/preview/generate', async (req, res) => {
    const assetId = clean(req.params.assetId);
    if (!assetId) return res.status(400).json({ ok: false, error: 'ASSET_ID_REQUIRED', message: 'assetId 不能为空。' });
    if (!repository.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_ASSET_STORAGE_UNAVAILABLE', message: 'Director Asset Registry 当前不可用。' });
    }
    try {
      const asset = await repository.getAsset(assetId);
      if (!asset || asset.status === 'DELETED') {
        return res.status(404).json({ ok: false, error: 'DIRECTOR_ASSET_NOT_FOUND', message: '找不到指定资产。' });
      }
      previewGateway.enqueueAssetPreview(asset);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(202).json({ ok: true, assetId, status: 'PROCESSING' });
    } catch (error: any) {
      return res.status(errorStatus(error)).json({
        ok: false,
        error: errorCode(error, 'DIRECTOR_ASSET_PREVIEW_GENERATE_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post('/projects/:projectId/previews/generate', async (req, res) => {
    const projectId = clean(req.params.projectId);
    const episodeId = clean(req.query.episodeId);
    if (!projectId) return res.status(400).json({ ok: false, error: 'PROJECT_ID_REQUIRED', message: 'projectId 不能为空。' });
    if (!repository.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_ASSET_STORAGE_UNAVAILABLE', message: 'Director Asset Registry 当前不可用。' });
    }
    try {
      await service.syncProjectAssets(projectId, episodeId || undefined).catch((error) => {
        console.warn(`[Asset Preview] legacy project projection skipped for ${projectId}:`, error instanceof Error ? error.message : String(error));
      });
      const assets = await repository.listAssets({ projectId, episodeId: episodeId || undefined });
      const queued = previewGateway.enqueueProjectPreviews(assets);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(202).json({ ok: true, total: assets.filter((asset) => asset.status !== 'DELETED').length, queued });
    } catch (error: any) {
      return res.status(errorStatus(error)).json({
        ok: false,
        error: errorCode(error, 'DIRECTOR_PROJECT_PREVIEW_GENERATE_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
