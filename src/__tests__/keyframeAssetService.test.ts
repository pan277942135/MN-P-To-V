import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyframeAssetService } from '../server/services/keyframeAssetService';
import { firestoreShotRepository } from '../server/repositories/firestoreShotRepository';
import { gcsArtifactStore } from '../server/storage/gcsArtifactStore';
import { SHOT_SCHEMA_VERSION, type ShotSpec } from '../domain/episode/episodeTypes';

function shotFixture(overrides: Partial<ShotSpec> = {}): ShotSpec {
  return {
    episodeId: 'MN-COS-001',
    shotId: 'S01',
    order: 0,
    durationSeconds: 4,
    status: 'KEYFRAME_PENDING',
    scene: { location: 'rental_room', time: 'night' },
    action: '梅凝在桌前切割 EVA 泡棉。',
    camera: 'close_static',
    props: ['EVA foam'],
    keyframe: {
      provider: 'CHATGPT_UPLOAD',
      status: 'NOT_REQUESTED',
      version: 1,
      generationAttempt: 0,
      qaAttempt: 0,
    },
    video: {
      provider: 'VEO',
      status: 'NOT_REQUESTED',
      providerAttempt: 0,
      qaAttempt: 0,
    },
    schemaVersion: SHOT_SCHEMA_VERSION,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    ...overrides,
  };
}

async function pngBuffer(): Promise<Buffer> {
  return sharp({
    create: {
      width: 96,
      height: 128,
      channels: 3,
      background: { r: 30, g: 60, b: 90 },
    },
  }).png().toBuffer();
}

async function landscapePngBuffer(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1920,
      height: 1080,
      channels: 3,
      background: { r: 30, g: 60, b: 90 },
    },
  }).png().toBuffer();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KeyframeAssetService', () => {
  it('persists a ChatGPT keyframe and binds durable metadata to the shot', async () => {
    const inputShot = shotFixture();
    const buffer = await pngBuffer();
    vi.spyOn(firestoreShotRepository, 'getShot').mockResolvedValue(inputShot);
    vi.spyOn(gcsArtifactStore, 'artifactExists').mockResolvedValue(false);
    const upload = vi.spyOn(gcsArtifactStore, 'uploadImageArtifact').mockImplementation(async ({ objectPath, buffer: bytes, contentType }) => ({
      outputBucket: 'ai-studio-bucket-89614354864-asia-south1',
      outputObjectPath: objectPath,
      videoUri: `gs://ai-studio-bucket-89614354864-asia-south1/${objectPath}`,
      sizeBytes: bytes.length,
      contentType: contentType || 'image/png',
      artifactPersisted: true,
      artifactPersistedAt: 1_800_000_010_000,
    }));
    const bind = vi.spyOn(firestoreShotRepository, 'bindKeyframeAsset').mockImplementation(async (params) => ({
      ...inputShot,
      status: 'KEYFRAME_QA',
      keyframe: {
        ...inputShot.keyframe,
        ...params.asset,
        provider: params.provider,
        status: 'QA_PENDING',
        generationAttempt: 1,
      },
      updatedAt: 1_800_000_010_000,
    }));

    const result = await KeyframeAssetService.persist({
      episodeId: 'MN-COS-001',
      shotId: 'S01',
      provider: 'CHATGPT_UPLOAD',
      sourceFileId: 'file-chatgpt-001',
      buffer,
      declaredMimeType: 'image/png',
    });

    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(96);
    expect(result.height).toBe(128);
    expect(result.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.assetId.length).toBeLessThanOrEqual(240);
    expect(result.outputObjectPath).toContain('episodes/MN-COS-001/shots/S01/keyframes/v1_');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'CHATGPT_UPLOAD',
      expectedVersion: 1,
      asset: expect.objectContaining({
        sourceFileId: 'file-chatgpt-001',
        mimeType: 'image/png',
        width: 96,
        height: 128,
      }),
    }));
    expect(result.shot.status).toBe('KEYFRAME_QA');
    expect(result.shot.keyframe.status).toBe('QA_PENDING');
  });

  it('returns VALID when the uploaded keyframe matches the supplied project policy', async () => {
    const inputShot = shotFixture();
    const buffer = await landscapePngBuffer();
    vi.spyOn(firestoreShotRepository, 'getShot').mockResolvedValue(inputShot);
    vi.spyOn(gcsArtifactStore, 'artifactExists').mockResolvedValue(false);
    vi.spyOn(gcsArtifactStore, 'uploadImageArtifact').mockImplementation(async ({ objectPath, buffer: bytes, contentType }) => ({
      outputBucket: 'ai-studio-bucket-89614354864-asia-south1',
      outputObjectPath: objectPath,
      videoUri: `gs://ai-studio-bucket-89614354864-asia-south1/${objectPath}`,
      sizeBytes: bytes.length,
      contentType: contentType || 'image/png',
      artifactPersisted: true,
      artifactPersistedAt: 1_800_000_010_000,
    }));
    vi.spyOn(firestoreShotRepository, 'bindKeyframeAsset').mockImplementation(async (params) => ({
      ...inputShot,
      status: 'KEYFRAME_QA',
      keyframe: { ...inputShot.keyframe, ...params.asset, provider: params.provider, status: 'QA_PENDING', generationAttempt: 1 },
      updatedAt: 1_800_000_010_000,
    }));

    const result = await KeyframeAssetService.persist({
      episodeId: 'MN-COS-001',
      shotId: 'S01',
      provider: 'CHATGPT_UPLOAD',
      sourceFileId: 'file-chatgpt-format-policy',
      buffer,
      declaredMimeType: 'image/png',
      projectFormatPolicy: {
        defaultAspectRatio: '16:9',
        allowedAspectRatios: ['16:9', '9:16', '1:1'],
        allowShotOverride: true,
      },
    });

    expect(result.validation).toEqual({
      status: 'VALID',
      actualAspectRatio: '16:9',
      expectedAspectRatio: '16:9',
    });
  });

  it('rejects a provider that does not match the planned shot before uploading', async () => {
    const buffer = await pngBuffer();
    vi.spyOn(firestoreShotRepository, 'getShot').mockResolvedValue(shotFixture());
    const upload = vi.spyOn(gcsArtifactStore, 'uploadImageArtifact');

    await expect(KeyframeAssetService.persist({
      episodeId: 'MN-COS-001',
      shotId: 'S01',
      provider: 'GEMINI_GENERATED',
      providerModel: 'gemini-3.1-flash-image',
      buffer,
    })).rejects.toThrow(/KEYFRAME_PROVIDER_MISMATCH/);

    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects declared MIME that disagrees with image magic bytes', async () => {
    const buffer = await pngBuffer();
    vi.spyOn(firestoreShotRepository, 'getShot').mockResolvedValue(shotFixture());

    await expect(KeyframeAssetService.persist({
      episodeId: 'MN-COS-001',
      shotId: 'S01',
      provider: 'CHATGPT_UPLOAD',
      sourceFileId: 'file-chatgpt-002',
      buffer,
      declaredMimeType: 'image/jpeg',
    })).rejects.toThrow(/KEYFRAME_MIME_MISMATCH/);
  });

  it('is idempotent for the same keyframe content and version', async () => {
    const buffer = await pngBuffer();
    const inputShot = shotFixture();
    let persistedShot: ShotSpec | null = null;
    vi.spyOn(firestoreShotRepository, 'getShot').mockImplementation(async () => persistedShot || inputShot);
    vi.spyOn(gcsArtifactStore, 'artifactExists').mockResolvedValue(false);
    const upload = vi.spyOn(gcsArtifactStore, 'uploadImageArtifact').mockImplementation(async ({ objectPath, buffer: bytes, contentType }) => ({
      outputBucket: 'ai-studio-bucket-89614354864-asia-south1',
      outputObjectPath: objectPath,
      videoUri: `gs://ai-studio-bucket-89614354864-asia-south1/${objectPath}`,
      sizeBytes: bytes.length,
      contentType: contentType || 'image/png',
      artifactPersisted: true,
      artifactPersistedAt: 1_800_000_020_000,
    }));
    vi.spyOn(firestoreShotRepository, 'bindKeyframeAsset').mockImplementation(async (params) => {
      persistedShot = {
        ...inputShot,
        status: 'KEYFRAME_QA',
        keyframe: {
          ...inputShot.keyframe,
          ...params.asset,
          provider: params.provider,
          status: 'QA_PENDING',
          generationAttempt: 1,
        },
        updatedAt: 1_800_000_020_000,
      };
      return persistedShot;
    });

    const first = await KeyframeAssetService.persist({
      episodeId: 'MN-COS-001',
      shotId: 'S01',
      provider: 'CHATGPT_UPLOAD',
      sourceFileId: 'file-chatgpt-003',
      buffer,
    });
    const second = await KeyframeAssetService.persist({
      episodeId: 'MN-COS-001',
      shotId: 'S01',
      provider: 'CHATGPT_UPLOAD',
      sourceFileId: 'file-chatgpt-003',
      buffer,
    });

    expect(first.reusedExistingAsset).toBe(false);
    expect(second.reusedExistingAsset).toBe(true);
    expect(second.assetId).toBe(first.assetId);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
