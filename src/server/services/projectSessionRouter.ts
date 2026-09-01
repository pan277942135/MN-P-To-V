import express from 'express';
import type { DirectorAssetRecord } from '../../services/assetRegistry/assetRegistryTypes';
import type { DirectorContext } from '../../services/directorContext/directorContextTypes';
import {
  directorAssetRepository,
  type DirectorAssetRepositoryLike,
} from '../repositories/directorAssetRepository';
import {
  firestoreDirectorProjectRepository,
  type DirectorCloudRestoreBundle,
} from '../repositories/firestoreDirectorProjectRepository';
import {
  assetRegistrySyncService,
  type AssetRegistrySyncServiceLike,
} from './assetRegistry/assetRegistrySyncService';
import {
  directorContextService,
  type DirectorContextService,
} from './directorContext/directorContextService';

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

export class ProjectSessionError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'ProjectSessionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ProjectSessionSourceLike {
  isAvailable(): boolean;
  getRestoreBundle(projectId: string, episodeId?: string): Promise<DirectorCloudRestoreBundle | null>;
}

export interface ProjectSessionPayload {
  project: Record<string, unknown>;
  episode: Record<string, unknown>;
  shots: Array<Record<string, unknown>>;
  assets: DirectorAssetRecord[];
  context: DirectorContext;
}

export interface ProjectSessionServiceLike {
  isAvailable(): boolean;
  getProjectSession(projectId: string, episodeId?: string): Promise<ProjectSessionPayload>;
}

class FirestoreProjectSessionSource implements ProjectSessionSourceLike {
  public isAvailable(): boolean {
    return firestoreDirectorProjectRepository.isAvailable();
  }

  public getRestoreBundle(projectId: string, episodeId?: string) {
    return firestoreDirectorProjectRepository.getRestoreBundle(projectId, episodeId);
  }
}

export class ProjectSessionService implements ProjectSessionServiceLike {
  constructor(
    private readonly source: ProjectSessionSourceLike = new FirestoreProjectSessionSource(),
    private readonly assets: DirectorAssetRepositoryLike = directorAssetRepository,
    private readonly assetSync: AssetRegistrySyncServiceLike = assetRegistrySyncService,
    private readonly context: Pick<DirectorContextService, 'getEpisodeContext'> = directorContextService,
  ) {}

  public isAvailable(): boolean {
    return this.source.isAvailable();
  }

  public async getProjectSession(projectIdInput: string, episodeIdInput = ''): Promise<ProjectSessionPayload> {
    const projectId = clean(projectIdInput);
    const requestedEpisodeId = clean(episodeIdInput);
    if (!projectId) {
      throw new ProjectSessionError('DIRECTOR_PROJECT_ID_REQUIRED', 'projectId 不能为空。', 400);
    }
    if (!this.source.isAvailable()) {
      throw new ProjectSessionError(
        'DIRECTOR_PROJECT_SESSION_STORAGE_UNAVAILABLE',
        'Project Session Firestore 当前不可用。',
        503,
      );
    }

    const bundle = await this.source.getRestoreBundle(projectId, requestedEpisodeId || undefined);
    if (!bundle) {
      throw new ProjectSessionError('DIRECTOR_PROJECT_NOT_FOUND', '找不到指定 Director 项目或 Episode。', 404);
    }
    const episodeId = clean(bundle.episode?.episodeId) || requestedEpisodeId;
    if (!episodeId) {
      throw new ProjectSessionError('DIRECTOR_EPISODE_NOT_FOUND', '找不到当前项目的 Episode。', 404);
    }

    const assets = await this.loadAssets(projectId, episodeId);
    // Context is composed from the same Firestore bundle and Registry authority.
    // A missing Registry row therefore produces an empty asset list rather than
    // a second, divergent session shape.
    const context = await this.context.getEpisodeContext(projectId, episodeId);
    return {
      project: bundle.project,
      episode: bundle.episode,
      shots: bundle.shots,
      assets,
      context,
    };
  }

  private async loadAssets(projectId: string, episodeId: string): Promise<DirectorAssetRecord[]> {
    if (!this.assets.isAvailable()) return [];
    try {
      if (this.assetSync.isAvailable()) {
        await this.assetSync.syncProjectAssets(projectId, episodeId);
      }
    } catch (error) {
      console.warn('[Project Session] Asset Registry projection skipped:', error instanceof Error ? error.message : String(error));
    }
    try {
      return await this.assets.listAssets({ projectId, episodeId });
    } catch (error) {
      console.warn('[Project Session] Asset Registry read skipped:', error instanceof Error ? error.message : String(error));
      return [];
    }
  }
}

export function createProjectSessionRouter(
  service: ProjectSessionServiceLike = new ProjectSessionService(),
) {
  const router = express.Router();

  router.get('/:projectId', async (req, res) => {
    const projectId = clean(req.params.projectId);
    const episodeId = clean(req.query.episodeId);
    if (!projectId) {
      return res.status(400).json({
        ok: false,
        error: 'DIRECTOR_PROJECT_ID_REQUIRED',
        message: 'projectId 不能为空。',
      });
    }
    if (!service.isAvailable()) {
      return res.status(503).json({
        ok: false,
        error: 'DIRECTOR_PROJECT_SESSION_STORAGE_UNAVAILABLE',
        message: 'Project Session Firestore 当前不可用。',
      });
    }

    try {
      const session = await service.getProjectSession(projectId, episodeId || undefined);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, ...session });
    } catch (error) {
      return res.status(errorStatus(error)).json({
        ok: false,
        error: errorCode(error, 'DIRECTOR_PROJECT_SESSION_READ_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}

export const projectSessionService = new ProjectSessionService();
