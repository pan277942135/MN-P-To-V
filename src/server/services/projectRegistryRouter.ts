import express from 'express';
import {
  firestoreDirectorProjectRepository,
  type DirectorProjectRegistryRecord,
} from '../repositories/firestoreDirectorProjectRepository';
import {
  directorAssetRepository,
  type DirectorAssetRepositoryLike,
} from '../repositories/directorAssetRepository';

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

export interface ProjectRegistrySourceLike {
  isAvailable(): boolean;
  listProjectRegistryRecords(): Promise<DirectorProjectRegistryRecord[]>;
  createProjectRegistryRecord(input: { title: string; format: string }): Promise<DirectorProjectRegistryRecord>;
}

export interface ProjectRegistryServiceLike {
  isAvailable(): boolean;
  listProjects(): Promise<Array<DirectorProjectRegistryRecord & { cover: string; assetCount: number }>>;
  createProject(input: { title: string; format: string }): Promise<DirectorProjectRegistryRecord & { cover: string; assetCount: number }>;
}

class ProjectRegistryService implements ProjectRegistryServiceLike {
  constructor(
    private readonly source: ProjectRegistrySourceLike = firestoreDirectorProjectRepository,
    private readonly assets: DirectorAssetRepositoryLike = directorAssetRepository,
  ) {}

  public isAvailable(): boolean {
    return this.source.isAvailable();
  }

  private async withAssetCount(record: DirectorProjectRegistryRecord) {
    let assetCount = 0;
    if (this.assets.isAvailable()) {
      try {
        const assets = await this.assets.listAssets({ projectId: record.projectId });
        assetCount = assets.filter((asset) => asset.status !== 'DELETED').length;
      } catch (error) {
        console.warn('[Project Registry] Asset count unavailable:', error instanceof Error ? error.message : String(error));
      }
    }
    return { ...record, cover: '', assetCount };
  }

  public async listProjects() {
    const records = await this.source.listProjectRegistryRecords();
    return Promise.all(records.map((record) => this.withAssetCount(record)));
  }

  public async createProject(input: { title: string; format: string }) {
    return this.withAssetCount(await this.source.createProjectRegistryRecord(input));
  }
}

export function createProjectRegistryRouter(
  service: ProjectRegistryServiceLike = new ProjectRegistryService(),
) {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));

  router.get('/projects', async (_req, res) => {
    if (!service.isAvailable()) {
      return res.status(503).json({
        ok: false,
        error: 'DIRECTOR_PROJECT_REGISTRY_UNAVAILABLE',
        message: 'Director Project Registry 当前不可用。',
      });
    }
    try {
      const projects = await service.listProjects();
      return res.status(200).json({ ok: true, projects });
    } catch (error: any) {
      return res.status(errorStatus(error)).json({
        ok: false,
        error: errorCode(error, 'DIRECTOR_PROJECT_LIST_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post('/projects', async (req, res) => {
    if (!service.isAvailable()) {
      return res.status(503).json({
        ok: false,
        error: 'DIRECTOR_PROJECT_REGISTRY_UNAVAILABLE',
        message: 'Director Project Registry 当前不可用。',
      });
    }
    const title = clean(req.body?.title || req.body?.projectTitle);
    const format = clean(req.body?.format || req.body?.defaultAspectRatio) || '16:9';
    if (!title) {
      return res.status(400).json({
        ok: false,
        error: 'DIRECTOR_PROJECT_TITLE_REQUIRED',
        message: 'title 不能为空。',
      });
    }
    if (!['16:9', '9:16', '1:1'].includes(format)) {
      return res.status(400).json({
        ok: false,
        error: 'DIRECTOR_PROJECT_FORMAT_INVALID',
        message: 'format 必须是 16:9、9:16 或 1:1。',
      });
    }

    try {
      const project = await service.createProject({ title, format });
      return res.status(201).json({ ok: true, projectId: project.projectId, project });
    } catch (error: any) {
      return res.status(errorStatus(error, 400)).json({
        ok: false,
        error: errorCode(error, 'DIRECTOR_PROJECT_CREATE_FAILED'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
