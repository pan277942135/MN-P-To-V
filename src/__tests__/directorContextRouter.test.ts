import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createDirectorContextRouter } from '../server/services/directorContext/directorContextRouter';
import type { DirectorContext, DirectorShotContext } from '../services/directorContext/directorContextTypes';

function context(): DirectorContext {
  return {
    schema: 'zaojing.director.context.v1',
    project: {
      projectId: 'project-a',
      title: '风从那年教室吹过',
      creativeBrief: '青春怀旧 AI 漫剧',
      targetFormat: 'story_short',
      aspectRatio: '9:16',
    },
    episode: {
      episodeId: 'EP01',
      title: '她转学来的那天下午',
      summary: '午休掌机风波。',
      status: 'REVIEW',
    },
    shots: [{
      shotUid: 'S03-01',
      order: 1,
      title: '吕子豪课本下偷偷玩掌机',
      storyPurpose: '建立调皮角色',
      visualDescription: '课本下的掌机。',
      camera: '中近景',
      action: '偷偷玩掌机。',
      dialogue: '',
      status: 'VIDEO_REVIEW',
      assets: [],
    }],
    assetSummary: { total: 0, images: 0, videos: 0, audio: 0 },
  };
}

function app() {
  const projectContext = context();
  const shotContext: DirectorShotContext = {
    ...projectContext.shots[0],
    projectId: 'project-a',
    episodeId: 'EP01',
    purpose: '建立调皮角色',
  };
  const service = {
    isAvailable: () => true,
    getDirectorContext: async (projectId: string) => {
      if (projectId === 'missing-project') throw Object.assign(new Error('找不到项目。'), { code: 'DIRECTOR_PROJECT_NOT_FOUND', statusCode: 404 });
      return projectContext;
    },
    getEpisodeContext: async (_projectId: string, episodeId: string) => {
      if (episodeId === 'missing-episode') throw Object.assign(new Error('找不到 Episode。'), { code: 'DIRECTOR_PROJECT_NOT_FOUND', statusCode: 404 });
      return projectContext;
    },
    getShotContext: async (shotUid: string) => {
      if (shotUid === 'missing-shot') throw Object.assign(new Error('找不到 Shot。'), { code: 'DIRECTOR_SHOT_NOT_FOUND', statusCode: 404 });
      return shotContext;
    },
  };
  const server = express();
  server.use('/api/director', createDirectorContextRouter(service));
  return server;
}

describe('Director Context API', () => {
  it('returns project context with the stable schema', async () => {
    const response = await request(app()).get('/api/director/projects/project-a/director-context');

    expect(response.status).toBe(200);
    expect(response.body.schema).toBe('zaojing.director.context.v1');
    expect(response.body.project.title).toBe('风从那年教室吹过');
    expect(response.body.episode.episodeId).toBe('EP01');
    expect(response.body.shots).toHaveLength(1);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('returns episode context', async () => {
    const response = await request(app()).get('/api/director/projects/project-a/episodes/EP01/director-context');

    expect(response.status).toBe(200);
    expect(response.body.episode.title).toBe('她转学来的那天下午');
  });

  it('returns Shot Context', async () => {
    const response = await request(app()).get('/api/director/shots/S03-01/director-context');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ shotUid: 'S03-01', purpose: '建立调皮角色', projectId: 'project-a' });
    expect(response.body.assets).toEqual([]);
  });

  it('returns 404 for missing project, episode, and Shot', async () => {
    const project = await request(app()).get('/api/director/projects/missing-project/director-context');
    const episode = await request(app()).get('/api/director/projects/project-a/episodes/missing-episode/director-context');
    const shot = await request(app()).get('/api/director/shots/missing-shot/director-context');

    expect(project.status).toBe(404);
    expect(project.body.error).toBe('DIRECTOR_PROJECT_NOT_FOUND');
    expect(episode.status).toBe(404);
    expect(episode.body.error).toBe('DIRECTOR_PROJECT_NOT_FOUND');
    expect(shot.status).toBe(404);
    expect(shot.body.error).toBe('DIRECTOR_SHOT_NOT_FOUND');
  });
});
