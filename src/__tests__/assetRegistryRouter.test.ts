import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createDirectorAssetRouter } from '../server/services/assetRegistry/assetRegistryRouter';
import type { DirectorAssetRecord } from '../services/assetRegistry/assetRegistryTypes';

function asset(overrides: Partial<DirectorAssetRecord> = {}): DirectorAssetRecord {
  return {
    assetId: 'asset-image-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    shotUid: 'shot-1',
    assetType: 'IMAGE',
    mediaType: 'KEYFRAME',
    status: 'ACTIVE',
    storage: { provider: 'GCS', bucket: 'bucket-1', path: 'director/shot-1/image.png', thumbnailPath: '', previewPath: '' },
    metadata: { width: 1080, height: 1920, aspectRatio: '9:16', durationSeconds: 0, fileSize: 10, mimeType: 'image/png' },
    source: { type: 'KEYFRAME_ASSET', sourceId: 'asset-image-1', createdAt: '2026-09-01T00:00:00.000Z', createdBy: 'system' },
    relations: { characters: [], scene: '教室', description: '掌机特写', shotPurpose: 'S03-01-A' },
    review: { status: 'PENDING', score: 0, notes: '' },
    updatedAt: 1,
    ...overrides,
  };
}

function app() {
  const assets = [
    asset(),
    asset({ assetId: 'asset-video-1', assetType: 'VIDEO', mediaType: 'GENERATED_VIDEO', storage: { provider: 'GCS', bucket: 'bucket-1', path: 'director/shot-1/video.mp4', thumbnailPath: '', previewPath: 'https://cdn.example.test/video.mp4' } }),
    asset({ assetId: 'asset-audio-1', assetType: 'AUDIO', mediaType: 'SFX' }),
  ];
  const repository = {
    isAvailable: () => true,
    createAsset: async (value: DirectorAssetRecord) => value,
    getAsset: async (assetId: string) => assets.find((value) => value.assetId === assetId) || null,
    listAssets: async (filters: any = {}) => assets.filter((value) => (
      (!filters.projectId || value.projectId === filters.projectId) &&
      (!filters.episodeId || value.episodeId === filters.episodeId) &&
      (!filters.shotUid || value.shotUid === filters.shotUid) &&
      (!filters.assetType || value.assetType === filters.assetType)
    )),
    listShotAssets: async () => assets,
    updateAsset: async (assetId: string, patch: any) => {
      const current = assets.find((value) => value.assetId === assetId);
      return current ? { ...current, ...patch, review: { ...current.review, ...(patch.review || {}) } } : null;
    },
    deleteAsset: async () => true,
  };
  const service = {
    isAvailable: () => true,
    registerAsset: async (value: DirectorAssetRecord) => value,
    syncToAssetRegistry: async (value: DirectorAssetRecord) => value,
    syncKeyframeAsset: async () => null,
    syncVideoAsset: async () => null,
    syncLegacySnapshotAssets: async () => [],
    syncProjectAssets: async () => [],
  };
  const binaryReader = {
    getAsset: async () => ({ buffer: Buffer.from('asset-bytes'), mimeType: 'image/png' }),
  };
  const server = express();
  server.use('/api/director', createDirectorAssetRouter(service as any, repository as any, binaryReader));
  return server;
}

describe('Director Asset Registry router', () => {
  it('lists project assets with query filters and keeps the response stable', async () => {
    const response = await request(app()).get('/api/director/projects/project-1/assets').query({ episodeId: 'episode-1', assetType: 'IMAGE' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 1 });
    expect(response.body.assets[0]).toMatchObject({ assetId: 'asset-image-1', shotUid: 'shot-1', mediaType: 'KEYFRAME' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('groups Shot assets into images, videos, and audio', async () => {
    const response = await request(app()).get('/api/director/shots/shot-1/assets').query({ projectId: 'project-1' });

    expect(response.status).toBe(200);
    expect(response.body.shotUid).toBe('shot-1');
    expect(response.body.images).toHaveLength(1);
    expect(response.body.videos).toHaveLength(1);
    expect(response.body.audio).toHaveLength(1);
  });

  it('registers and updates a review decision', async () => {
    const registered = await request(app()).post('/api/director/assets/register').send(asset({ assetId: 'asset-register-1' }));
    expect(registered.status).toBe(200);
    expect(registered.body.ok).toBe(true);
    expect(registered.body.asset.assetId).toBe('asset-register-1');

    const updated = await request(app()).patch('/api/director/assets/asset-image-1').send({ review: { status: 'APPROVED' } });
    expect(updated.status).toBe(200);
    expect(updated.body.asset.review.status).toBe('APPROVED');
  });

  it('redirects HTTP previews and streams GCS previews', async () => {
    const redirect = await request(app()).get('/api/director/assets/asset-video-1/preview');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('https://cdn.example.test/video.mp4');

    const image = await request(app()).get('/api/director/assets/asset-image-1/preview');
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toContain('image/png');
    expect(image.body.toString()).toBe('asset-bytes');
  });
});
