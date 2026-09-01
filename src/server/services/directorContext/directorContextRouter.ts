import express from 'express';
import {
  directorContextService,
  type DirectorContextService,
} from './directorContextService';

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

function errorResponse(res: express.Response, error: any, fallback: string) {
  return res.status(errorStatus(error)).json({
    ok: false,
    error: errorCode(error, fallback),
    message: error instanceof Error ? error.message : String(error),
  });
}

export function createDirectorContextRouter(
  service: Pick<DirectorContextService, 'isAvailable' | 'getDirectorContext' | 'getEpisodeContext' | 'getShotContext'> = directorContextService,
) {
  const router = express.Router();

  router.get('/projects/:projectId/director-context', async (req, res) => {
    const projectId = clean(req.params.projectId);
    if (!projectId) return res.status(400).json({ ok: false, error: 'DIRECTOR_PROJECT_ID_REQUIRED', message: 'projectId 不能为空。' });
    if (!service.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_CONTEXT_STORAGE_UNAVAILABLE', message: 'Director Context Firestore 当前不可用。' });
    }

    try {
      const context = await service.getDirectorContext(projectId);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, ...context });
    } catch (error) {
      return errorResponse(res, error, 'DIRECTOR_CONTEXT_READ_FAILED');
    }
  });

  router.get('/projects/:projectId/episodes/:episodeId/director-context', async (req, res) => {
    const projectId = clean(req.params.projectId);
    const episodeId = clean(req.params.episodeId);
    if (!projectId) return res.status(400).json({ ok: false, error: 'DIRECTOR_PROJECT_ID_REQUIRED', message: 'projectId 不能为空。' });
    if (!episodeId) return res.status(400).json({ ok: false, error: 'DIRECTOR_EPISODE_ID_REQUIRED', message: 'episodeId 不能为空。' });
    if (!service.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_CONTEXT_STORAGE_UNAVAILABLE', message: 'Director Context Firestore 当前不可用。' });
    }

    try {
      const context = await service.getEpisodeContext(projectId, episodeId);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, ...context });
    } catch (error) {
      return errorResponse(res, error, 'DIRECTOR_EPISODE_CONTEXT_READ_FAILED');
    }
  });

  router.get('/shots/:shotUid/director-context', async (req, res) => {
    const shotUid = clean(req.params.shotUid);
    if (!shotUid) return res.status(400).json({ ok: false, error: 'DIRECTOR_SHOT_UID_REQUIRED', message: 'shotUid 不能为空。' });
    if (!service.isAvailable()) {
      return res.status(503).json({ ok: false, error: 'DIRECTOR_CONTEXT_STORAGE_UNAVAILABLE', message: 'Director Context Firestore 当前不可用。' });
    }

    try {
      const context = await service.getShotContext(shotUid);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, ...context });
    } catch (error) {
      return errorResponse(res, error, 'DIRECTOR_SHOT_CONTEXT_READ_FAILED');
    }
  });

  return router;
}
