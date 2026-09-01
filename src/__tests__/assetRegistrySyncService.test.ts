import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShotSpec } from '../domain/episode/episodeTypes';
import { SHOT_SCHEMA_VERSION } from '../domain/episode/episodeTypes';
import {
  AssetRegistrySyncService,
  type AssetRegistrySyncServiceLike,
} from '../server/services/assetRegistry/assetRegistrySyncService';
import {
  normalizeDirectorAsset,
  type DirectorAssetRepositoryLike,
} from '../server/repositories/directorAssetRepository';
import type {
  DirectorAssetPatch,
  DirectorAssetRecord,
} from '../services/assetRegistry/assetRegistryTypes';

function shotFixture(overrides: Partial<ShotSpec> = {}): ShotSpec {
  return {
    episodeId: 'episode-01',
    shotId: 'S03-01-A',
    order: 0,
    durationSeconds: 4,
    status: 'COMPLETED',
    scene: { location: 'rental room', time: 'night', description: 'warm desk light' },
    action: '吕子豪偷偷玩掌机。',
    camera: 'locked medium close-up',
    emotion: 'playful',
    props: ['handheld game console'],
    keyframe: {
      provider: 'CHATGPT_UPLOAD',
      status: 'PASS',
      assetId: 'kf-s03-01-a',
      outputBucket: 'director-assets-bucket',
      outputObjectPath: 'episodes/episode-01/shots/S03-01-A/keyframes/v1.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      width: 1080,
      height: 1920,
      persistedAt: 1_800_000_000_000,
      version: 1,
      generationAttempt: 1,
      qaAttempt: 1,
    },
    video: {
      provider: 'VEO',
      status: 'PASS',
      assetId: 'veo-s03-01-a',
      generationTaskId: 'veo-s03-01-a',
      artifactUrl: 'https://storage.example.test/episode-01/S03-01-A.mp4',
      downloadUrl: 'https://storage.example.test/episode-01/S03-01-A-download.mp4',
      providerAttempt: 1,
      qaAttempt: 1,
    },
    schemaVersion: SHOT_SCHEMA_VERSION,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_010_000,
    completedAt: 1_800_000_010_000,
    ...overrides,
  };
}

class MemoryAssetRepository implements DirectorAssetRepositoryLike {
  public available = true;
  public assets = new Map<string, DirectorAssetRecord>();

  isAvailable(): boolean { return this.available; }

  async createAsset(asset: DirectorAssetRecord): Promise<DirectorAssetRecord> {
    this.assets.set(asset.assetId, asset);
    return asset;
  }

  async getAsset(assetId: string): Promise<DirectorAssetRecord | null> {
    return this.assets.get(assetId) || null;
  }

  async listAssets(filters: Record<string, string> = {}): Promise<DirectorAssetRecord[]> {
    return [...this.assets.values()].filter((asset) => (
      (!filters.projectId || asset.projectId === filters.projectId) &&
      (!filters.episodeId || asset.episodeId === filters.episodeId) &&
      (!filters.shotUid || asset.shotUid === filters.shotUid)
    ));
  }

  async listShotAssets(shotUid: string, projectId?: string): Promise<DirectorAssetRecord[]> {
    return this.listAssets({ shotUid, projectId });
  }

  async updateAsset(assetId: string, patch: DirectorAssetPatch): Promise<DirectorAssetRecord | null> {
    const current = this.assets.get(assetId);
    if (!current) return null;
    const updated = normalizeDirectorAsset({
      ...current,
      ...patch,
      assetId,
      storage: { ...current.storage, ...(patch.storage || {}) },
      metadata: { ...current.metadata, ...(patch.metadata || {}) },
      source: { ...current.source, ...(patch.source || {}) },
      relations: { ...current.relations, ...(patch.relations || {}) },
      review: { ...current.review, ...(patch.review || {}) },
    });
    this.assets.set(assetId, updated);
    return updated;
  }

  async deleteAsset(assetId: string): Promise<boolean> {
    return this.assets.delete(assetId);
  }
}

describe('AssetRegistrySyncService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adapts durable keyframe and video fields without changing the Shot model', async () => {
    const repository = new MemoryAssetRepository();
    const service = new AssetRegistrySyncService(repository, {
      resolveProjectIdForEpisode: async () => null,
    });
    const shot = shotFixture();

    const keyframe = await service.syncKeyframeAsset({ projectId: 'project-a', shot });
    const video = await service.syncVideoAsset({
      projectId: 'project-a',
      shot,
      artifact: { sizeBytes: 123456, mimeType: 'video/mp4' },
    });

    expect(keyframe).toMatchObject({
      assetId: 'kf-s03-01-a',
      projectId: 'project-a',
      episodeId: 'episode-01',
      shotUid: 'S03-01-A',
      assetType: 'IMAGE',
      mediaType: 'KEYFRAME',
      storage: { provider: 'GCS', bucket: 'director-assets-bucket' },
      metadata: { width: 1080, height: 1920, aspectRatio: '9:16' },
      review: { status: 'APPROVED' },
    });
    expect(video).toMatchObject({
      assetId: 'veo-s03-01-a',
      assetType: 'VIDEO',
      mediaType: 'GENERATED_VIDEO',
      metadata: { durationSeconds: 4, fileSize: 123456, mimeType: 'video/mp4' },
      relations: { description: 'warm desk light' },
    });
    expect(shot.keyframe.assetId).toBe('kf-s03-01-a');
    expect(shot.video.assetId).toBe('veo-s03-01-a');
  });

  it('keeps a human review decision when production metadata is re-synced', async () => {
    const repository = new MemoryAssetRepository();
    const service = new AssetRegistrySyncService(repository, {
      resolveProjectIdForEpisode: async () => null,
    });
    const shot = shotFixture();
    await service.syncKeyframeAsset({ projectId: 'project-a', shot });
    await repository.updateAsset('kf-s03-01-a', { review: { status: 'APPROVED', notes: '导演确认' } });

    const refreshed = await service.syncKeyframeAsset({
      projectId: 'project-a',
      shot: { ...shot, keyframe: { ...shot.keyframe, outputObjectPath: 'episodes/episode-01/shots/S03-01-A/keyframes/v2.png' } },
    });

    expect(refreshed?.storage.path).toContain('v2.png');
    expect(refreshed?.review).toEqual({ status: 'APPROVED', score: 0, notes: '导演确认' });
  });

  it('projects legacy Director Cloud keyframes with deterministic IDs', async () => {
    const repository = new MemoryAssetRepository();
    const service = new AssetRegistrySyncService(repository);
    const first = await service.syncLegacySnapshotAssets({
      snapshot: {
        schema: 'zaojing.director.cloud.v1',
        projectId: 'project-a',
        episodeId: 'episode-01',
        seriesTitle: 'Series',
        projectTitle: 'Project A',
        clientUpdatedAt: 1,
        stages: {
          storyboard: { shots: [{ uid: 'S03-01-A', title: '掌机特写', scene: { location: '教室' } }] },
          keyframeAssets: { assets: [{ shotUid: 'S03-01-A', blobKey: 'blob-1', status: 'PASS', width: 1080, height: 1920 }] },
        },
      },
      cloudAssets: [{ shotUid: 'S03-01-A', blobKey: 'blob-1', bucket: 'bucket-a', objectPath: 'director/a.png', mimeType: 'image/png' }],
    });
    const second = await service.syncLegacySnapshotAssets({
      snapshot: {
        schema: 'zaojing.director.cloud.v1',
        projectId: 'project-a',
        episodeId: 'episode-01',
        seriesTitle: 'Series',
        projectTitle: 'Project A',
        clientUpdatedAt: 2,
        stages: {},
      },
      cloudAssets: [{ shotUid: 'S03-01-A', blobKey: 'blob-1', bucket: 'bucket-a', objectPath: 'director/a.png', mimeType: 'image/png' }],
    });

    expect(first[0].assetId).toBe(second[0].assetId);
    expect(first[0]).toMatchObject({ mediaType: 'KEYFRAME', storage: { path: 'director/a.png' }, source: { type: 'DIRECTOR_CLOUD_KEYFRAME' } });
    expect(first[0].relations.shotPurpose).toBe('掌机特写');
  });

  it('returns null when best-effort registration fails', async () => {
    const repository = new MemoryAssetRepository();
    const create = vi.spyOn(repository, 'createAsset').mockRejectedValue(new Error('temporary Firestore failure'));
    const service: AssetRegistrySyncServiceLike = new AssetRegistrySyncService(repository, {
      resolveProjectIdForEpisode: async () => null,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await service.syncKeyframeAsset({ projectId: 'project-a', shot: shotFixture() });

    expect(result).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('queues a derived Preview job only after Registry registration succeeds', async () => {
    const repository = new MemoryAssetRepository();
    const enqueue = vi.fn(() => true);
    const service = new AssetRegistrySyncService(
      repository,
      { resolveProjectIdForEpisode: async () => null },
      {
        describeAssetPreview: () => ({}) as any,
        enqueueAssetPreview: enqueue,
        enqueueProjectPreviews: () => 0,
        generateAssetPreview: async () => ({ status: 'PENDING' }) as any,
      },
    );

    const result = await service.syncKeyframeAsset({ projectId: 'project-a', shot: shotFixture() });

    expect(result?.preview?.status).toBe('PENDING');
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'kf-s03-01-a' }));
  });
});
