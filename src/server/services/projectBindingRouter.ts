import express from 'express';
import {
  projectBindingService,
} from './projectBindingService';
import {
  firestoreDirectorProjectRepository,
  type DirectorCloudRestoreBundle,
} from '../repositories/firestoreDirectorProjectRepository';
import { createDefaultDirectorCloudPersistenceService } from './directorCloudPersistenceService';

export interface ProjectBindingServiceLike {
  createBinding(projectId: string): Promise<string>;
  resolveBinding(bindingCode: string): Promise<string | null>;
}

export interface ProjectBindingRestoreSourceLike {
  isAvailable(): boolean;
  getRestoreBundle(projectId: string): Promise<DirectorCloudRestoreBundle | null>;
  getKeyframeAsset?(projectId: string, episodeId: string, shotUid: string, blobKey?: string): Promise<{
    buffer: Buffer;
    mimeType: string;
    ref: { uri: string };
  } | null>;
}

const defaultRestoreSource: ProjectBindingRestoreSourceLike = {
  isAvailable: () => firestoreDirectorProjectRepository.isAvailable(),
  getRestoreBundle: (projectId) => firestoreDirectorProjectRepository.getRestoreBundle(projectId),
  getKeyframeAsset: (projectId, episodeId, shotUid, blobKey) => (
    createDefaultDirectorCloudPersistenceService().getKeyframeAsset(projectId, episodeId, shotUid, blobKey)
  ),
};

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorStatus(error: any): number {
  const status = Number(error?.statusCode);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function errorCode(error: any, fallback: string): string {
  return typeof error?.code === 'string' && error.code.trim() ? error.code.trim() : fallback;
}

function assetUrl(bindingCode: string, shotUid: string, blobKey: string): string {
  const params = new URLSearchParams({ bindingCode, blobKey });
  return `/api/director/project-binding/assets/${encodeURIComponent(shotUid)}?${params.toString()}`;
}

export function buildProjectBindingRestoreResponse(
  bundle: DirectorCloudRestoreBundle,
  bindingCode: string,
) {
  const assets = bundle.assets.map((asset: any) => {
    const shotUid = clean(asset?.shotUid);
    const cloudRef = asset?.cloudRef;
    const blobKey = clean(asset?.blobKey || cloudRef?.blobKey);
    return {
      ...asset,
      ...(shotUid && blobKey ? { assetUrl: assetUrl(bindingCode, shotUid, blobKey) } : { assetUrl: null }),
    };
  });

  return {
    project: bundle.project,
    episode: bundle.episode,
    shots: bundle.shots,
    stages: bundle.stages,
    assets,
    productionStatus: bundle.productionStatus,
    serverUpdatedAt: bundle.serverUpdatedAt,
  };
}

export function createProjectBindingRouter(
  bindingService: ProjectBindingServiceLike = projectBindingService,
  restoreSource: ProjectBindingRestoreSourceLike = defaultRestoreSource,
) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  router.post('/create', async (req, res) => {
    const projectId = clean(req.body?.projectId);
    if (!projectId) {
      return res.status(400).json({
        ok: false,
        error: 'PROJECT_ID_REQUIRED',
        message: 'projectId 不能为空。',
      });
    }

    try {
      const bindingCode = await bindingService.createBinding(projectId);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, bindingCode });
    } catch (error: any) {
      return res.status(errorStatus(error)).json({
        ok: false,
        error: errorCode(error, 'PROJECT_BINDING_CREATE_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post('/restore', async (req, res) => {
    const bindingCode = clean(req.body?.bindingCode);
    if (!bindingCode) {
      return res.status(400).json({
        ok: false,
        error: 'BINDING_CODE_REQUIRED',
        message: 'bindingCode 不能为空。',
      });
    }

    try {
      const projectId = await bindingService.resolveBinding(bindingCode);
      if (!projectId) {
        return res.status(404).json({
          ok: false,
          error: 'PROJECT_BINDING_NOT_FOUND',
          message: '绑定码不存在、已失效或已过期。',
        });
      }
      if (!restoreSource.isAvailable()) {
        return res.status(503).json({
          ok: false,
          error: 'DIRECTOR_CLOUD_UNAVAILABLE',
          message: 'Director Firestore 当前不可用。',
        });
      }

      const bundle = await restoreSource.getRestoreBundle(projectId);
      if (!bundle) {
        return res.status(404).json({
          ok: false,
          error: 'PROJECT_NOT_FOUND',
          message: '绑定码对应的 Director 项目不存在。',
        });
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        ok: true,
        ...buildProjectBindingRestoreResponse(bundle, bindingCode),
      });
    } catch (error: any) {
      return res.status(errorStatus(error)).json({
        ok: false,
        error: errorCode(error, 'PROJECT_BINDING_RESTORE_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get('/assets/:shotUid', async (req, res) => {
    const bindingCode = clean(req.query.bindingCode);
    const blobKey = clean(req.query.blobKey);
    if (!bindingCode) return res.status(400).json({ ok: false, error: 'BINDING_CODE_REQUIRED', message: 'bindingCode 不能为空。' });
    if (!restoreSource.getKeyframeAsset) return res.status(501).json({ ok: false, error: 'DIRECTOR_ASSET_PROXY_UNAVAILABLE', message: '关键帧资产代理不可用。' });

    try {
      const projectId = await bindingService.resolveBinding(bindingCode);
      if (!projectId) return res.status(404).json({ ok: false, error: 'PROJECT_BINDING_NOT_FOUND', message: '绑定码不存在、已失效或已过期。' });
      const bundle = await restoreSource.getRestoreBundle(projectId);
      const episodeId = clean(bundle?.episode?.episodeId);
      if (!bundle || !episodeId) return res.status(404).json({ ok: false, error: 'PROJECT_NOT_FOUND', message: '绑定码对应的 Director 项目不存在。' });
      const result = await restoreSource.getKeyframeAsset(projectId, episodeId, String(req.params.shotUid || ''), blobKey);
      if (!result) return res.status(404).json({ ok: false, error: 'DIRECTOR_ASSET_NOT_FOUND', message: '找不到指定关键帧云端资产。' });
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('X-Director-GCS-Uri', result.ref.uri);
      return res.status(200).send(result.buffer);
    } catch (error: any) {
      return res.status(errorStatus(error)).json({
        ok: false,
        error: errorCode(error, 'DIRECTOR_ASSET_READ_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
