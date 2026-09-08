import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createProjectRegistryRouter } from '../server/services/projectRegistryRouter';

function service(overrides: Record<string, unknown> = {}) {
  return {
    isAvailable: () => true,
    listProjects: vi.fn(async () => []),
    createProject: vi.fn(async () => ({
      projectId: 'project-new',
      title: '测试项目',
      status: 'ACTIVE',
      episodeCount: 0,
      shotCount: 0,
      assetCount: 0,
      cover: '',
      updatedAt: Date.now(),
    })),
    ...overrides,
  };
}

function app(mock: any) {
  const server = express();
  server.use('/api/director', createProjectRegistryRouter(mock));
  return server;
}

describe('Project Registry API', () => {
  it('returns an empty project array with HTTP 200', async () => {
    const response = await request(app(service())).get('/api/director/projects');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, projects: [] });
  });

  it('returns project cards with registry counts', async () => {
    const mock = service({
      listProjects: vi.fn(async () => [{
        projectId: 'project-a',
        title: '风从那年教室吹过',
        status: 'ACTIVE',
        episodeCount: 1,
        shotCount: 10,
        assetCount: 8,
        cover: '',
        updatedAt: 100,
      }]),
    });
    const response = await request(app(mock)).get('/api/director/projects');
    expect(response.status).toBe(200);
    expect(response.body.projects[0]).toMatchObject({
      projectId: 'project-a',
      title: '风从那年教室吹过',
      episodeCount: 1,
      shotCount: 10,
      assetCount: 8,
    });
  });

  it('creates a project and returns its projectId', async () => {
    const mock = service();
    const response = await request(app(mock))
      .post('/api/director/projects')
      .send({ title: '测试项目', format: '16:9' });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ ok: true, projectId: 'project-new' });
    expect(mock.createProject).toHaveBeenCalledWith({ title: '测试项目', format: '16:9' });
  });

  it('rejects missing title', async () => {
    const response = await request(app(service())).post('/api/director/projects').send({ format: '16:9' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('DIRECTOR_PROJECT_TITLE_REQUIRED');
  });
});
