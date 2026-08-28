import express from 'express';
import {
  createDefaultDirectorCloudPersistenceService,
  type DirectorCloudPersistenceService,
} from './directorCloudPersistenceService';

export const DIRECTOR_CLOUD_PERSISTENCE_INTENT = 'director-cloud-v0.4.0';

export function createDirectorCloudPersistenceRouter(
  service: DirectorCloudPersistenceService = createDefaultDirectorCloudPersistenceService(),
) {
  const router = express.Router();
  router.use(express.json({ limit: '100mb' }));

  router.get('/latest', async (_req, res) => {
    if (!service.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_CLOUD_UNAVAILABLE', message: 'Director Firestore 当前不可用。' });
    }
    try {
      const record = await service.latest();
      if (!record) return res.status(404).json({ ok: false, error: 'DIRECTOR_PROJECT_NOT_FOUND', message: '云端暂无 Director 项目。' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, record });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: 'DIRECTOR_CLOUD_READ_FAILED', message: error?.message || String(error) });
    }
  });

  router.get('/projects/:projectId/episodes/:episodeId', async (req, res) => {
    if (!service.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_CLOUD_UNAVAILABLE', message: 'Director Firestore 当前不可用。' });
    }
    try {
      const record = await service.get(String(req.params.projectId || ''), String(req.params.episodeId || ''));
      if (!record) return res.status(404).json({ ok: false, error: 'DIRECTOR_PROJECT_NOT_FOUND', message: '找不到指定 Director 项目。' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, record });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: 'DIRECTOR_CLOUD_READ_FAILED', message: error?.message || String(error) });
    }
  });

  router.get('/assets/:projectId/:episodeId/:shotUid', async (req, res) => {
    if (!service.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_CLOUD_UNAVAILABLE', message: 'Director Firestore 当前不可用。' });
    }
    try {
      const result = await service.getKeyframeAsset(
        String(req.params.projectId || ''),
        String(req.params.episodeId || ''),
        String(req.params.shotUid || ''),
        String(req.query.blobKey || ''),
      );
      if (!result) return res.status(404).json({ ok: false, error: 'DIRECTOR_ASSET_NOT_FOUND', message: '找不到指定关键帧云端资产。' });
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('X-Director-GCS-Uri', result.ref.uri);
      return res.status(200).send(result.buffer);
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: 'DIRECTOR_ASSET_READ_FAILED', message: error?.message || String(error) });
    }
  });

  router.post('/sync', async (req, res) => {
    if (req.get('X-Director-Persistence-Intent') !== DIRECTOR_CLOUD_PERSISTENCE_INTENT) {
      return res.status(400).json({
        ok: false,
        error: 'DIRECTOR_PERSISTENCE_INTENT_REQUIRED',
        message: '缺少明确的 Director Cloud persistence 意图标记。',
      });
    }
    if (!service.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_CLOUD_UNAVAILABLE', message: 'Director Firestore 当前不可用。' });
    }
    try {
      const record = await service.sync(req.body?.snapshot, req.body?.assetUploads);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, record });
    } catch (error: any) {
      const message = error?.message || String(error);
      const badInput = /INVALID|REQUIRED|TOO_LARGE/.test(message);
      return res.status(badInput ? 400 : 500).json({
        ok: false,
        error: badInput ? 'DIRECTOR_CLOUD_INPUT_INVALID' : 'DIRECTOR_CLOUD_SYNC_FAILED',
        message,
      });
    }
  });

  return router;
}
