import { describe, expect, it } from 'vitest';
import type { DirectorCloudRestoreBundle } from '../server/repositories/firestoreDirectorProjectRepository';
import {
  DirectorContextError,
  DirectorContextService,
  type DirectorContextSourceLike,
} from '../server/services/directorContext/directorContextService';
import { normalizeDirectorAsset, type DirectorAssetRepositoryLike } from '../server/repositories/directorAssetRepository';
import type { DirectorAssetPatch, DirectorAssetRecord } from '../services/assetRegistry/assetRegistryTypes';

function bundle(): DirectorCloudRestoreBundle {
  return {
    project: {
      projectId: 'project-a',
      projectTitle: '风从那年教室吹过',
      activeEpisodeId: 'EP01',
    },
    episode: {
      projectId: 'project-a',
      episodeId: 'EP01',
      title: '她转学来的那天下午',
      summary: '午休掌机风波之后，新同学在下午进入教室。',
      status: 'REVIEW',
    },
    shots: [
      {
        shotUid: 'S03-01',
        order: 1,
        status: 'VIDEO_REVIEW',
        storyboard: {
          uid: 'S03-01',
          title: '吕子豪课本下偷偷玩掌机',
          action: '课本下的蓝色掌机露出一角。',
          camera: '中近景',
          dialogue: '嘘，小声点。',
          storyPurpose: '建立调皮角色',
        },
        keyframeBlueprint: {
          shotUid: 'S03-01',
          visualDescription: '课桌和掌机形成清晰遮挡关系。',
          composition: '中近景',
        },
      },
      {
        shotUid: 'S03-02',
        order: 2,
        status: 'KEYFRAME_REVIEW',
        storyboard: {
          uid: 'S03-02',
          title: '秦小满发现异常',
          action: '秦小满从相邻座位抬眼看向掌机。',
          camera: '固定机位',
          dialogue: '',
          notes: '保持午休的安静气氛。',
        },
      },
    ],
    stages: {
      brief: {
        title: '风从那年教室吹过',
        creativeBrief: '青春怀旧 AI 漫剧，核心是多年后才意识到的记住。',
        targetFormat: 'story_short',
        aspectRatio: '9:16',
      },
      storyboard: {
        summary: '从午休风波推进到下午新同学登场。',
      },
    },
    assets: [],
    productionStatus: { episodeStatus: 'REVIEW' },
    serverUpdatedAt: 123,
  };
}

function asset(overrides: Partial<DirectorAssetRecord> = {}): DirectorAssetRecord {
  return {
    assetId: 'asset-image-1',
    projectId: 'project-a',
    episodeId: 'EP01',
    shotUid: 'S03-01',
    assetType: 'IMAGE',
    mediaType: 'KEYFRAME',
    status: 'ACTIVE',
    storage: { provider: 'GCS', bucket: 'bucket-a', path: 'shots/S03-01/keyframe.png', thumbnailPath: '', previewPath: '' },
    metadata: { width: 1080, height: 1920, aspectRatio: '9:16', durationSeconds: 0, fileSize: 10, mimeType: 'image/png' },
    source: { type: 'KEYFRAME_ASSET', sourceId: 'asset-image-1', createdAt: '2026-09-01T00:00:00.000Z', createdBy: 'system' },
    relations: { characters: [], scene: '教室', description: '掌机关键帧', shotPurpose: '建立调皮角色' },
    review: { status: 'APPROVED', score: 92, notes: '' },
    ...overrides,
  };
}

class MemoryAssetRepository implements DirectorAssetRepositoryLike {
  constructor(private readonly values: DirectorAssetRecord[] = []) {}
  isAvailable(): boolean { return true; }
  async createAsset(value: DirectorAssetRecord): Promise<DirectorAssetRecord> { return value; }
  async getAsset(assetId: string): Promise<DirectorAssetRecord | null> { return this.values.find((value) => value.assetId === assetId) || null; }
  async listAssets(filters: Record<string, string> = {}): Promise<DirectorAssetRecord[]> {
    return this.values.filter((value) => (!filters.projectId || value.projectId === filters.projectId) && (!filters.episodeId || value.episodeId === filters.episodeId));
  }
  async listShotAssets(shotUid: string): Promise<DirectorAssetRecord[]> { return this.values.filter((value) => value.shotUid === shotUid); }
  async updateAsset(assetId: string, patch: DirectorAssetPatch): Promise<DirectorAssetRecord | null> {
    const current = await this.getAsset(assetId);
    return current ? normalizeDirectorAsset({ ...current, ...patch, assetId }) : null;
  }
  async deleteAsset(): Promise<boolean> { return true; }
}

class BrokenAssetRepository extends MemoryAssetRepository {
  async listAssets(): Promise<DirectorAssetRecord[]> {
    throw new Error('registry temporarily unavailable');
  }
}

function source(overrides: Partial<DirectorContextSourceLike> = {}): DirectorContextSourceLike {
  return {
    isAvailable: () => true,
    getRestoreBundle: async (_projectId, episodeId) => episodeId && episodeId !== 'EP01' ? null : bundle(),
    findShotLocation: async (shotUid) => shotUid === 'S03-01' ? { projectId: 'project-a', episodeId: 'EP01' } : null,
    ...overrides,
  };
}

function assetSync() {
  return { syncProjectAssets: async () => [] };
}

describe('DirectorContextService', () => {
  it('composes project, episode, shots, blueprints, and registry assets into v1 context', async () => {
    const service = new DirectorContextService(
      source(),
      new MemoryAssetRepository([
        asset(),
        asset({ assetId: 'asset-video-1', assetType: 'VIDEO', mediaType: 'GENERATED_VIDEO', storage: { provider: 'GCS', bucket: 'bucket-a', path: 'shots/S03-01/video.mp4', thumbnailPath: '', previewPath: 'https://cdn.example.test/video.mp4' } }),
      ]),
      assetSync() as any,
    );

    const context = await service.getDirectorContext('project-a');

    expect(context.schema).toBe('zaojing.director.context.v1');
    expect(context.project).toMatchObject({
      projectId: 'project-a',
      title: '风从那年教室吹过',
      creativeBrief: '青春怀旧 AI 漫剧，核心是多年后才意识到的记住。',
      targetFormat: 'story_short',
      aspectRatio: '9:16',
    });
    expect(context.episode).toMatchObject({ episodeId: 'EP01', title: '她转学来的那天下午', status: 'REVIEW' });
    expect(context.shots[0]).toMatchObject({
      shotUid: 'S03-01',
      order: 1,
      title: '吕子豪课本下偷偷玩掌机',
      storyPurpose: '建立调皮角色',
      visualDescription: '课桌和掌机形成清晰遮挡关系。',
      camera: '中近景',
      action: '课本下的蓝色掌机露出一角。',
      dialogue: '嘘，小声点。',
      status: 'VIDEO_REVIEW',
    });
    expect(context.shots[0].assets).toHaveLength(2);
    expect(context.shots[0].assets[0]).toMatchObject({
      assetId: 'asset-image-1',
      type: 'IMAGE',
      reviewStatus: 'APPROVED',
      preview: '/api/director/assets/asset-image-1/preview',
    });
    expect(context.assetSummary).toEqual({ total: 2, images: 1, videos: 1, audio: 0 });
  });

  it('supports episode context and does not fail when the Asset Registry is missing', async () => {
    const service = new DirectorContextService(source(), new BrokenAssetRepository(), assetSync() as any);

    const context = await service.getEpisodeContext('project-a', 'EP01');

    expect(context.episode.episodeId).toBe('EP01');
    expect(context.shots).toHaveLength(2);
    expect(context.assetSummary).toEqual({ total: 0, images: 0, videos: 0, audio: 0 });
    expect(context.shots.every((shot) => shot.assets.length === 0)).toBe(true);
  });

  it('exposes the project Production Format Policy in the AI context contract', async () => {
    const base = bundle();
    const service = new DirectorContextService(
      source({
        getRestoreBundle: async () => ({
          ...base,
          project: {
            ...base.project,
            formatPolicy: {
              defaultAspectRatio: '16:9',
              allowedAspectRatios: ['16:9', '9:16', '1:1'],
              allowShotOverride: true,
            },
          },
        }),
      }),
      new MemoryAssetRepository(),
      assetSync() as any,
    );

    const context = await service.getDirectorContext('project-a');

    expect(context.project.aspectRatio).toBe('16:9');
    expect(context.project.formatPolicy).toEqual({
      defaultAspectRatio: '16:9',
      allowedAspectRatios: ['16:9', '9:16', '1:1'],
      allowShotOverride: true,
    });
  });

  it('resolves Shot Context with a purpose alias and validates missing shots', async () => {
    const service = new DirectorContextService(source(), new MemoryAssetRepository([asset()]), assetSync() as any);
    const context = await service.getShotContext('S03-01');

    expect(context).toMatchObject({ projectId: 'project-a', episodeId: 'EP01', shotUid: 'S03-01', purpose: '建立调皮角色' });
    expect(context.assets).toHaveLength(1);

    await expect(service.getShotContext('S99-99')).rejects.toMatchObject({
      code: 'DIRECTOR_SHOT_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('returns a not-found error for a missing project or episode', async () => {
    const service = new DirectorContextService(source({ getRestoreBundle: async () => null }), new MemoryAssetRepository(), assetSync() as any);

    await expect(service.getDirectorContext('missing-project')).rejects.toBeInstanceOf(DirectorContextError);
    await expect(service.getEpisodeContext('project-a', 'missing-episode')).rejects.toMatchObject({
      code: 'DIRECTOR_PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  });
});
