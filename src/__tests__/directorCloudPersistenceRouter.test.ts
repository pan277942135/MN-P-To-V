import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createDirectorCloudPersistenceRouter, DIRECTOR_CLOUD_PERSISTENCE_INTENT } from '../server/services/directorCloudPersistenceRouter';

function record() {
  return {
    snapshot: {
      schema: 'zaojing.director.cloud.v1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      seriesTitle: '《风从那年教室吹过》系列',
      projectTitle: 'EP01',
      clientUpdatedAt: 100,
      stages: {
        keyframeCloudAssets: {
          items: [{
            shotUid: 'shot-a',
            blobKey: 'blob-a',
            bucket: 'bucket-1',
            objectPath: 'director/a.png',
            uri: 'gs://bucket-1/director/a.png',
            mimeType: 'image/png',
            sizeBytes: 3,
            generation: '1',
            updatedAt: 100,
          }],
        },
      },
    },
    serverUpdatedAt: 200,
  };
}

function app() {
  const mock = {
    isAvailable: () => true,
    latest: async () => record(),
    get: async () => record(),
    sync: async () => record(),
    getKeyframeAsset: async () => ({
      buffer: Buffer.from('png'),
      mimeType: 'image/png',
      ref: record().snapshot.stages.keyframeCloudAssets.items[0],
    }),
  };
  const app = express();
  app.use('/api/director/persistence', createDirectorCloudPersistenceRouter(mock as any));
  return app;
}

describe('Director cloud persistence router', () => {
  it('requires an explicit persistence intent on cloud writes', async () => {
    const blocked = await request(app()).post('/api/director/persistence/sync').send({});
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toBe('DIRECTOR_PERSISTENCE_INTENT_REQUIRED');

    const allowed = await request(app())
      .post('/api/director/persistence/sync')
      .set('X-Director-Persistence-Intent', DIRECTOR_CLOUD_PERSISTENCE_INTENT)
      .send({ snapshot: record().snapshot, assetUploads: [] });
    expect(allowed.status).toBe(200);
    expect(allowed.body.record.snapshot.projectId).toBe('project-1');
  });

  it('restores the latest cloud project and streams the durable keyframe asset', async () => {
    const latest = await request(app()).get('/api/director/persistence/latest');
    expect(latest.status).toBe(200);
    expect(latest.body.record.snapshot.episodeId).toBe('episode-1');

    const asset = await request(app()).get('/api/director/persistence/assets/project-1/episode-1/shot-a?blobKey=blob-a');
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toContain('image/png');
    expect(asset.headers['x-director-gcs-uri']).toBe('gs://bucket-1/director/a.png');
  });
});
