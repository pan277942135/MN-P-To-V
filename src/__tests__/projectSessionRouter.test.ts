import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectSessionRouter,
  ProjectSessionService,
} from '../server/services/projectSessionRouter';
import type { DirectorContext } from '../services/directorContext/directorContextTypes';

function bundle() {
  return {
    project: {
      projectId: 'project-a',
      seriesTitle: 'Series',
      projectTitle: '风从那年教室吹过',
      activeEpisodeId: 'EP01',
    },
    episode: {
      projectId: 'project-a',
      episodeId: 'EP01',
      projectTitle: '风从那年教室吹过',
      status: 'DRAFT',
    },
    shots: [{ shotUid: 'S03-01', order: 1, storyboard: { title: '午休风波' } }],
    stages: { storyboard: { shots: [{ uid: 'S03-01', title: '午休风波' }] } },
    assets: [],
    productionStatus: { shotCount: 1 },
    serverUpdatedAt: 200,
  };
}

function context(): DirectorContext {
  return {
    schema: 'zaojing.director.context.v1',
    project: {
      projectId: 'project-a',
      title: '风从那年教室吹过',
      creativeBrief: '青春怀旧 AI 漫剧',
      targetFormat: 'story_short',
      aspectRatio: '16:9',
      formatPolicy: {
        defaultAspectRatio: '16:9',
        allowedAspectRatios: ['16:9'],
        allowShotOverride: true,
      },
    },
    episode: {
      episodeId: 'EP01',
      title: '她转学来的那天下午',
      summary: '午休风波。',
      status: 'DRAFT',
    },
    shots: [{
      shotUid: 'S03-01',
      order: 1,
      title: '午休风波',
      storyPurpose: '推进剧情',
      visualDescription: '课本下的掌机。',
      camera: '中近景',
      action: '偷偷玩掌机。',
      dialogue: '',
      status: 'DRAFT',
      assets: [],
    }],
    assetSummary: {
      total: 0,
      images: 0,
      videos: 0,
      audio: 0,
      preview: { total: 0, ready: 0, processing: 0, pending: 0, failed: 0 },
    },
  };
}

function app(service: any) {
  const server = express();
  server.use('/api/director/project-session', createProjectSessionRouter(service));
  return server;
}

describe('Project Session API', () => {
  it('returns one session shape with project, episode, shots, assets, and context', async () => {
    const service = {
      isAvailable: () => true,
      getProjectSession: vi.fn(async () => ({
        project: bundle().project,
        episode: bundle().episode,
        shots: bundle().shots,
        assets: [],
        context: context(),
      })),
    };
    const response = await request(app(service)).get('/api/director/project-session/project-a?episodeId=EP01');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      project: { projectId: 'project-a' },
      episode: { episodeId: 'EP01' },
      shots: [{ shotUid: 'S03-01' }],
      assets: [],
      context: { schema: 'zaojing.director.context.v1' },
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(service.getProjectSession).toHaveBeenCalledWith('project-a', 'EP01');
  });

  it('returns 404 when the project session does not exist', async () => {
    const service = {
      isAvailable: () => true,
      getProjectSession: async () => {
        throw Object.assign(new Error('找不到指定 Director 项目。'), {
          code: 'DIRECTOR_PROJECT_NOT_FOUND',
          statusCode: 404,
        });
      },
    };
    const response = await request(app(service)).get('/api/director/project-session/missing-project');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('DIRECTOR_PROJECT_NOT_FOUND');
  });

  it('keeps the session available when Registry reads fail', async () => {
    const sync = { isAvailable: () => true, syncProjectAssets: vi.fn(async () => []) };
    const repository = {
      isAvailable: () => true,
      listAssets: vi.fn(async () => { throw new Error('registry temporarily unavailable'); }),
    };
    const source = {
      isAvailable: () => true,
      getRestoreBundle: vi.fn(async () => bundle()),
    };
    const service = new ProjectSessionService(
      source as any,
      repository as any,
      sync as any,
      { getEpisodeContext: vi.fn(async () => context()) },
    );

    const result = await service.getProjectSession('project-a', 'EP01');
    expect(result.project.projectId).toBe('project-a');
    expect(result.shots).toHaveLength(1);
    expect(result.assets).toEqual([]);
    expect(sync.syncProjectAssets).toHaveBeenCalledWith('project-a', 'EP01');
  });
});
