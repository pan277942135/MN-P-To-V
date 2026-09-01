import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createProjectBindingRouter } from '../server/services/projectBindingRouter';

function bundle() {
  return {
    project: {
      projectId: 'project-a',
      seriesTitle: 'Series',
      projectTitle: 'Project A',
      activeEpisodeId: 'episode-01',
    },
    episode: {
      projectId: 'project-a',
      episodeId: 'episode-01',
      seriesTitle: 'Series',
      projectTitle: 'Project A',
      status: 'DRAFT',
    },
    shots: [{ shotUid: 'shot-01', order: 1, storyboard: { title: 'Shot 01' } }],
    stages: {
      storyboard: { shots: [{ uid: 'shot-01', title: 'Shot 01' }] },
      keyframeBlueprint: { blueprints: [{ shotUid: 'shot-01' }] },
      videoBlueprint: { items: [{ shotUid: 'shot-01', status: 'DRAFT' }] },
    },
    assets: [{ shotUid: 'shot-01', blobKey: 'blob-01', cloudRef: { blobKey: 'blob-01' } }],
    productionStatus: { episodeStatus: 'DRAFT', shotCount: 1 },
    serverUpdatedAt: 200,
  };
}

function app() {
  const service = {
    createBinding: async () => 'ZJ-Ab7K-x2M8',
    resolveBinding: async () => 'project-a',
  };
  const source = {
    isAvailable: () => true,
    getRestoreBundle: async () => bundle(),
    getKeyframeAsset: async () => ({
      buffer: Buffer.from('image'),
      mimeType: 'image/png',
      ref: { uri: 'gs://bucket/director/shot-01/blob-01.png' },
    }),
  };
  const server = express();
  server.use('/api/director/project-binding', createProjectBindingRouter(service, source));
  return server;
}

describe('Project Binding API', () => {
  it('creates a binding code for the current project', async () => {
    const response = await request(app())
      .post('/api/director/project-binding/create')
      .send({ projectId: 'project-a' });

    expect(response.status).toBe(200);
    expect(response.body.bindingCode).toBe('ZJ-Ab7K-x2M8');
  });

  it('restores project, episode, shots, stages, assets, and status', async () => {
    const response = await request(app())
      .post('/api/director/project-binding/restore')
      .send({ bindingCode: 'ZJ-Ab7K-x2M8' });

    expect(response.status).toBe(200);
    expect(response.body.project.projectTitle).toBe('Project A');
    expect(response.body.episode.episodeId).toBe('episode-01');
    expect(response.body.shots).toHaveLength(1);
    expect(response.body.stages.storyboard).toBeTruthy();
    expect(response.body.assets[0].assetUrl).toContain('/api/director/project-binding/assets/shot-01');
    expect(response.body.productionStatus.shotCount).toBe(1);
  });

  it('streams an asset through the binding code without exposing a project id in the asset URL', async () => {
    const response = await request(app())
      .get('/api/director/project-binding/assets/shot-01')
      .query({ bindingCode: 'ZJ-Ab7K-x2M8', blobKey: 'blob-01' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['x-director-gcs-uri']).toContain('gs://');
    expect(response.request.url).not.toContain('project-a');
  });

  it('validates required input before calling the service', async () => {
    const response = await request(app())
      .post('/api/director/project-binding/restore')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('BINDING_CODE_REQUIRED');
  });
});
