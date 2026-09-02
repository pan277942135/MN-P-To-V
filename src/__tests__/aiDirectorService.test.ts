import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { DirectorAssetPatch, DirectorAssetRecord } from '../services/assetRegistry/assetRegistryTypes';
import type { DirectorContext, DirectorShotContext } from '../services/directorContext/directorContextTypes';
import { resolveAiObjectRef, type AiDirectorStorageLike, type AiObjectRef, type AiStoredObject } from '../server/storage/aiDirectorStorage';
import { AiDirectorService } from '../server/services/aiDirector/aiDirectorService';
import type { DirectorAssetRepositoryLike } from '../server/repositories/directorAssetRepository';

function asset(overrides: Partial<DirectorAssetRecord> = {}): DirectorAssetRecord {
  return {
    assetId: 'asset-image-1',
    projectId: 'project-a',
    episodeId: 'EP01',
    shotUid: 'S03-01',
    assetType: 'IMAGE',
    mediaType: 'KEYFRAME',
    status: 'ACTIVE',
    storage: {
      provider: 'GCS',
      bucket: 'bucket-a',
      path: 'projects/project-a/originals/asset-image-1.png',
      thumbnailPath: '',
      previewPath: '',
    },
    metadata: {
      width: 1920,
      height: 1080,
      aspectRatio: '16:9',
      durationSeconds: 0,
      fileSize: 20,
      mimeType: 'image/png',
    },
    source: {
      type: 'KEYFRAME_ASSET',
      sourceId: 'asset-image-1',
      createdAt: '2026-09-02T00:00:00.000Z',
      createdBy: 'system',
    },
    relations: {
      characters: ['吕子豪'],
      scene: '教室',
      description: '掌机关键帧',
      shotPurpose: '建立调皮角色',
    },
    review: { status: 'APPROVED', score: 92, notes: '' },
    preview: {
      status: 'READY',
      generatedAt: '2026-09-02T00:00:00.000Z',
      thumbnailPath: '',
      previewPath: '',
      mediumPreviewPath: '',
      videoPreviewPath: '',
      framePaths: [],
      width: 1920,
      height: 1080,
      durationSeconds: 0,
      sourcePath: 'projects/project-a/originals/asset-image-1.png',
    },
    ...overrides,
  };
}

function context(episodeId: string, title: string, shotUid = 'S03-01'): DirectorContext {
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
        allowedAspectRatios: ['16:9', '9:16', '1:1'],
        allowShotOverride: true,
      },
    },
    episode: {
      episodeId,
      title,
      summary: `${episodeId} summary`,
      status: 'REVIEW',
    },
    shots: [{
      shotUid,
      order: 1,
      title: '吕子豪课本下偷偷玩掌机',
      storyPurpose: '建立调皮角色',
      visualDescription: '课本下露出蓝色掌机。',
      camera: '中近景',
      action: '偷偷玩掌机。',
      dialogue: '嘘。',
      status: 'VIDEO_REVIEW',
      storyboard: { uid: shotUid, title: '吕子豪课本下偷偷玩掌机' },
      blueprint: { shotUid, prompt: 'classroom handheld game' },
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

class MemoryAssetRepository implements DirectorAssetRepositoryLike {
  constructor(readonly values: DirectorAssetRecord[]) {}
  isAvailable(): boolean { return true; }
  async createAsset(value: DirectorAssetRecord): Promise<DirectorAssetRecord> { this.values.push(value); return value; }
  async getAsset(assetId: string): Promise<DirectorAssetRecord | null> { return this.values.find((value) => value.assetId === assetId) || null; }
  async listAssets(filters: { projectId?: string; episodeId?: string } = {}): Promise<DirectorAssetRecord[]> {
    return this.values.filter((value) => (!filters.projectId || value.projectId === filters.projectId) && (!filters.episodeId || value.episodeId === filters.episodeId));
  }
  async listShotAssets(shotUid: string, projectId?: string): Promise<DirectorAssetRecord[]> {
    return this.values.filter((value) => value.shotUid === shotUid && (!projectId || value.projectId === projectId));
  }
  async updateAsset(assetId: string, patch: DirectorAssetPatch): Promise<DirectorAssetRecord | null> {
    const current = await this.getAsset(assetId);
    return current ? { ...current, ...patch } as DirectorAssetRecord : null;
  }
  async deleteAsset(): Promise<boolean> { return true; }
}

class MemoryStorage implements AiDirectorStorageLike {
  readonly objects = new Map<string, { buffer: Buffer; mimeType: string }>();
  constructor(private readonly imageBuffer: Buffer) {}
  bucketName(): string { return 'bucket-a'; }
  async putObject(input: { objectPath: string; buffer: Buffer; mimeType: string }): Promise<AiStoredObject> {
    this.objects.set(input.objectPath, { buffer: input.buffer, mimeType: input.mimeType });
    return {
      bucket: this.bucketName(),
      objectPath: input.objectPath,
      uri: `gs://${this.bucketName()}/${input.objectPath}`,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.length,
    };
  }
  async getObject(ref: AiObjectRef): Promise<{ buffer: Buffer; mimeType: string }> {
    const stored = this.objects.get(ref.objectPath);
    if (stored) return stored;
    if (ref.objectPath.endsWith('.png') || ref.objectPath.endsWith('.jpg')) return { buffer: this.imageBuffer, mimeType: 'image/png' };
    return { buffer: Buffer.from('video-preview'), mimeType: 'video/mp4' };
  }
  async getSignedUrl(ref: AiObjectRef, expiresAt: Date): Promise<string> {
    return `https://signed.example.test/${ref.bucket}/${encodeURIComponent(ref.objectPath)}?expires=${expiresAt.getTime()}`;
  }
}

function contextSource(contexts: DirectorContext[]) {
  const shots = new Map<string, DirectorShotContext>();
  for (const value of contexts) {
    for (const shot of value.shots) {
      shots.set(shot.shotUid, { ...shot, projectId: value.project.projectId, episodeId: value.episode.episodeId, purpose: shot.storyPurpose });
    }
  }
  return {
    getProjectContexts: async () => contexts,
    getShotContext: async (shotUid: string) => {
      const shot = shots.get(shotUid);
      if (!shot) throw Object.assign(new Error('Shot not found'), { code: 'AI_SHOT_NOT_FOUND', statusCode: 404 });
      return shot;
    },
  };
}

describe('AiDirectorService', () => {
  it('accepts only GCS object references for signing, including Google Storage HTTPS aliases', () => {
    expect(resolveAiObjectRef('gs://bucket-a/projects/p1/image.png')).toEqual({ bucket: 'bucket-a', objectPath: 'projects/p1/image.png' });
    expect(resolveAiObjectRef('https://storage.googleapis.com/bucket-a/projects/p1/image.png')).toEqual({ bucket: 'bucket-a', objectPath: 'projects/p1/image.png' });
    expect(resolveAiObjectRef('https://cdn.example.test/image.png', 'bucket-a')).toBeNull();
  });

  it('emits the AI context schema, all episodes, blueprints, and project asset summary', async () => {
    const repository = new MemoryAssetRepository([
      asset(),
      asset({ assetId: 'asset-video-1', assetType: 'VIDEO', mediaType: 'GENERATED_VIDEO', shotUid: 'S03-01', storage: { provider: 'GCS', bucket: 'bucket-a', path: 'projects/project-a/originals/asset-video-1.mp4', thumbnailPath: '', previewPath: '' }, metadata: { width: 1920, height: 1080, aspectRatio: '16:9', durationSeconds: 4.2, fileSize: 30, mimeType: 'video/mp4' } }),
    ]);
    const service = new AiDirectorService(
      contextSource([context('EP01', '她转学来的那天下午'), context('EP02', '午休风波之后', 'S04-01')]),
      repository,
      { syncProjectAssets: async () => [] } as any,
      new MemoryStorage(await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } }).png().toBuffer()),
      () => Date.parse('2026-09-02T00:00:00.000Z'),
    );

    const result = await service.getProjectContext('project-a', ['context']);

    expect(result.schema).toBe('zaojing.ai.context.v1');
    expect(result.project.title).toBe('风从那年教室吹过');
    expect(result.episodes.map((episode) => episode.episodeId)).toEqual(['EP01', 'EP02']);
    expect(result.shots).toHaveLength(2);
    expect(result.shots[0].blueprint).toMatchObject({ shotUid: 'S03-01' });
    expect(result.assetSummary).toEqual({ total: 2, images: 1, videos: 1, audio: 0 });
    expect(result.assets[0]).not.toHaveProperty('preview');
  });

  it('adds only signed preview URLs when the preview scope is granted', async () => {
    const storage = new MemoryStorage(await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } }).png().toBuffer());
    const service = new AiDirectorService(
      contextSource([context('EP01', '她转学来的那天下午')]),
      new MemoryAssetRepository([asset()]),
      { syncProjectAssets: async () => [] } as any,
      storage,
      () => Date.parse('2026-09-02T00:00:00.000Z'),
    );

    const result = await service.getProjectContext('project-a', ['context', 'preview']);
    const preview = result.assets[0].preview;
    expect(preview?.mediumUrl).toContain('https://signed.example.test');
    expect(preview?.mediumUrl).not.toContain('gs://');
    expect(preview?.expiresAt).toBe('2026-09-02T00:15:00.000Z');

    const shot = await service.getShotContext('project-a', 'S03-01', ['context', 'preview']);
    expect(shot).toMatchObject({ shotUid: 'S03-01', purpose: '建立调皮角色' });
    expect(shot.blueprint).toMatchObject({ shotUid: 'S03-01' });
    expect(shot.assets[0].preview?.thumbnailUrl).toContain('https://signed.example.test');

    const previewResponse = await service.getAssetPreview('project-a', 'asset-image-1');
    expect(previewResponse.preview.mediumUrl).toContain('https://signed.example.test');
  });

  it('writes a GCS-only Review Package with JSON, contact sheet, and preview folders', async () => {
    const storage = new MemoryStorage(await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } }).png().toBuffer());
    const service = new AiDirectorService(
      contextSource([context('EP01', '她转学来的那天下午')]),
      new MemoryAssetRepository([
        asset(),
        asset({ assetId: 'asset-video-1', assetType: 'VIDEO', mediaType: 'GENERATED_VIDEO', storage: { provider: 'GCS', bucket: 'bucket-a', path: 'projects/project-a/originals/asset-video-1.mp4', thumbnailPath: '', previewPath: '' }, metadata: { width: 1920, height: 1080, aspectRatio: '16:9', durationSeconds: 4.2, fileSize: 30, mimeType: 'video/mp4' } }),
      ]),
      { syncProjectAssets: async () => [] } as any,
      storage,
      () => Date.parse('2026-09-02T00:00:00.000Z'),
    );

    const result = await service.generateReviewPackage('project-a', ['context', 'preview', 'review_package']);
    const paths = [...storage.objects.keys()];
    expect(result.assetCount).toBe(2);
    expect(result.previewCount).toBe(2);
    expect(paths.some((value) => value.endsWith('/project.json'))).toBe(true);
    expect(paths.some((value) => value.endsWith('/context.json'))).toBe(true);
    expect(paths.some((value) => value.endsWith('/asset_manifest.json'))).toBe(true);
    expect(paths.some((value) => value.endsWith('/contact_sheet.jpg'))).toBe(true);
    expect(paths.some((value) => value.includes('/previews/images/asset-image-1.jpg'))).toBe(true);
    expect(paths.some((value) => value.includes('/previews/videos/asset-video-1.mp4'))).toBe(true);
    expect(result.files.contactSheet.url).not.toContain('gs://');
  });
});
