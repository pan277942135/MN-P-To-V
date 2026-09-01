import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import { describe, expect, it } from 'vitest';
import type { DirectorAssetRepositoryLike } from '../server/repositories/directorAssetRepository';
import { normalizeDirectorAsset } from '../server/repositories/directorAssetRepository';
import {
  AssetPreviewService,
  describeDirectorAssetPreview,
} from '../server/services/assetPreview/assetPreviewService';
import {
  ImagePreviewService,
  type AssetPreviewObjectStoreLike,
} from '../server/services/assetPreview/imagePreviewService';
import {
  VideoPreviewService,
  type FfmpegRunnerLike,
} from '../server/services/assetPreview/videoPreviewService';
import { directorPreviewObjectPath } from '../server/storage/directorGcsStore';
import type {
  DirectorAssetPatch,
  DirectorAssetRecord,
} from '../services/assetRegistry/assetRegistryTypes';

function asset(overrides: Partial<DirectorAssetRecord> = {}): DirectorAssetRecord {
  return {
    assetId: 'asset-image-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    shotUid: 'S01-01',
    assetType: 'IMAGE',
    mediaType: 'KEYFRAME',
    status: 'ACTIVE',
    storage: {
      provider: 'GCS',
      bucket: 'preview-test-bucket',
      path: 'originals/asset-image-1.png',
      thumbnailPath: '',
      previewPath: '',
    },
    metadata: {
      width: 1920,
      height: 1080,
      aspectRatio: '16:9',
      durationSeconds: 0,
      fileSize: 0,
      mimeType: 'image/png',
    },
    source: {
      type: 'KEYFRAME_ASSET',
      sourceId: 'asset-image-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      createdBy: 'system',
    },
    relations: { characters: [], scene: '教室', description: '关键帧', shotPurpose: '建立空间' },
    review: { status: 'PENDING', score: 0, notes: '' },
    ...overrides,
  };
}

class MemoryPreviewStore implements AssetPreviewObjectStoreLike {
  public readonly source = new Map<string, { buffer: Buffer; mimeType: string }>();
  public readonly derived = new Map<string, { buffer: Buffer; mimeType: string }>();

  async getAsset(ref: { bucket: string; objectPath: string }) {
    const value = this.source.get(`${ref.bucket}/${ref.objectPath}`);
    if (!value) throw new Error(`missing source ${ref.bucket}/${ref.objectPath}`);
    return value;
  }

  async putPreview(input: { projectId: string; assetId: string; variant: 'thumbnail' | 'medium' | 'video-preview' | 'frame'; mimeType: string; buffer: Buffer; frameIndex?: number }) {
    const objectPath = directorPreviewObjectPath(input);
    this.derived.set(objectPath, { buffer: input.buffer, mimeType: input.mimeType });
    return {
      bucket: 'preview-test-bucket',
      objectPath,
      uri: `gs://preview-test-bucket/${objectPath}`,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.length,
      generation: '1',
      updatedAt: Date.now(),
    };
  }
}

class MemoryAssetRepository implements DirectorAssetRepositoryLike {
  public value: DirectorAssetRecord;

  constructor(value: DirectorAssetRecord) {
    this.value = value;
  }

  isAvailable(): boolean { return true; }
  async createAsset(value: DirectorAssetRecord): Promise<DirectorAssetRecord> { this.value = value; return value; }
  async getAsset(): Promise<DirectorAssetRecord | null> { return this.value; }
  async listAssets(): Promise<DirectorAssetRecord[]> { return [this.value]; }
  async listShotAssets(): Promise<DirectorAssetRecord[]> { return [this.value]; }
  async updateAsset(_assetId: string, patch: DirectorAssetPatch): Promise<DirectorAssetRecord | null> {
    this.value = normalizeDirectorAsset({
      ...this.value,
      ...patch,
      assetId: this.value.assetId,
      storage: { ...this.value.storage, ...(patch.storage || {}) },
      metadata: { ...this.value.metadata, ...(patch.metadata || {}) },
      source: { ...this.value.source, ...(patch.source || {}) },
      relations: { ...this.value.relations, ...(patch.relations || {}) },
      review: { ...this.value.review, ...(patch.review || {}) },
      preview: patch.preview === undefined ? this.value.preview : { ...(this.value.preview || {}), ...patch.preview },
    });
    return this.value;
  }
  async deleteAsset(): Promise<boolean> { return true; }
}

describe('Asset Preview Gateway foundation', () => {
  it('uses the required deterministic preview GCS layout', () => {
    expect(directorPreviewObjectPath({ projectId: 'p1', assetId: 'a001', variant: 'thumbnail', mimeType: 'image/jpeg' }))
      .toBe('projects/p1/previews/thumbnails/a001.jpg');
    expect(directorPreviewObjectPath({ projectId: 'p1', assetId: 'a001', variant: 'video-preview', mimeType: 'video/mp4' }))
      .toBe('projects/p1/previews/video-preview/a001.mp4');
    expect(directorPreviewObjectPath({ projectId: 'p1', assetId: 'a001', variant: 'frame', frameIndex: 5, mimeType: 'image/jpeg' }))
      .toBe('projects/p1/previews/frames/a001/frame_005.jpg');
  });

  it('generates non-cropping 320px and 1280px image previews', async () => {
    const source = await sharp({
      create: { width: 1920, height: 1080, channels: 4, background: { r: 12, g: 48, b: 80, alpha: 1 } },
    }).png().toBuffer();
    const store = new MemoryPreviewStore();
    store.source.set('preview-test-bucket/originals/asset-image-1.png', { buffer: source, mimeType: 'image/png' });

    const result = await new ImagePreviewService(store).generate(asset());
    const thumbnail = await sharp(store.derived.get(result.thumbnailPath)!.buffer).metadata();
    const medium = await sharp(store.derived.get(result.mediumPreviewPath)!.buffer).metadata();

    expect(result).toMatchObject({ width: 1920, height: 1080, thumbnailPath: expect.stringContaining('/thumbnails/'), mediumPreviewPath: expect.stringContaining('/medium/') });
    expect({ width: thumbnail.width, height: thumbnail.height }).toEqual({ width: 320, height: 180 });
    expect({ width: medium.width, height: medium.height }).toEqual({ width: 1280, height: 720 });
  });

  it('creates a 640px H264 video preview and five percentage frames', async () => {
    const executable = ffmpegPath && existsSync(ffmpegPath) ? ffmpegPath : 'ffmpeg';
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zaojing-preview-test-'));
    const sourcePath = path.join(tempDir, 'source.mp4');
    try {
      const run = promisify(execFile);
      await run(executable, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', sourcePath]);
      const store = new MemoryPreviewStore();
      store.source.set('preview-test-bucket/originals/asset-image-1.png', { buffer: await readFile(sourcePath), mimeType: 'video/mp4' });
      const result = await new VideoPreviewService(store).generate(asset({ assetType: 'VIDEO', mediaType: 'GENERATED_VIDEO', storage: { ...asset().storage, path: 'originals/asset-image-1.png' }, metadata: { ...asset().metadata, mimeType: 'video/mp4' } }));

      expect(result.videoPreviewPath).toContain('/video-preview/');
      expect(result.framePaths).toHaveLength(5);
      expect(result.durationSeconds).toBeGreaterThan(0);
      expect(store.derived.get(result.videoPreviewPath)?.buffer.length).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps production ACTIVE when preview generation fails and records FAILED', async () => {
    const repository = new MemoryAssetRepository(asset());
    const failingImageGenerator = { generate: async () => { throw new Error('source object unavailable'); } };
    const service = new AssetPreviewService(repository, failingImageGenerator as any, { generate: async () => { throw new Error('not used'); } } as any);

    const preview = await service.generateAssetPreview(repository.value);

    expect(preview).toMatchObject({ status: 'FAILED', error: 'source object unavailable' });
    expect(repository.value.status).toBe('ACTIVE');
    expect(repository.value.preview?.status).toBe('FAILED');
  });

  it('exposes AI-readable URLs without leaking raw GCS paths', () => {
    const response = describeDirectorAssetPreview(asset({
      preview: {
        status: 'READY',
        generatedAt: '2026-09-01T00:00:00.000Z',
        thumbnailPath: 'projects/project-1/previews/thumbnails/asset-image-1.jpg',
        previewPath: 'projects/project-1/previews/medium/asset-image-1.jpg',
        mediumPreviewPath: 'projects/project-1/previews/medium/asset-image-1.jpg',
        videoPreviewPath: '',
        framePaths: [],
        width: 1920,
        height: 1080,
        durationSeconds: 0,
        sourcePath: 'originals/asset-image-1.png',
      },
    }));

    expect(response).toMatchObject({
      assetId: 'asset-image-1',
      preview: {
        status: 'READY',
        thumbnailUrl: '/api/director/assets/asset-image-1/preview/content/thumbnail',
        mediumUrl: '/api/director/assets/asset-image-1/preview/content/medium',
      },
    });
    expect(JSON.stringify(response)).not.toContain('gs://');
  });
});
