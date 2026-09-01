import sharp from 'sharp';
import type { DirectorAssetRecord } from '../../../services/assetRegistry/assetRegistryTypes';
import {
  directorGcsStore,
  type DirectorPreviewObjectRef,
} from '../../storage/directorGcsStore';

export interface AssetPreviewObjectStoreLike {
  getAsset(ref: { bucket: string; objectPath: string }): Promise<{ buffer: Buffer; mimeType: string }>;
  putPreview(input: {
    projectId: string;
    assetId: string;
    variant: 'thumbnail' | 'medium' | 'video-preview' | 'frame';
    mimeType: string;
    buffer: Buffer;
    frameIndex?: number;
  }): Promise<DirectorPreviewObjectRef>;
}

export interface ImagePreviewGenerationResult {
  width: number;
  height: number;
  durationSeconds: number;
  thumbnailPath: string;
  mediumPreviewPath: string;
  previewPath: string;
  videoPreviewPath: string;
  framePaths: string[];
}

export interface ImagePreviewGeneratorLike {
  generate(asset: DirectorAssetRecord): Promise<ImagePreviewGenerationResult>;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sourceObject(asset: DirectorAssetRecord): { bucket: string; objectPath: string } {
  const rawPath = clean(asset.storage.path);
  const match = rawPath.match(/^gs:\/\/([^/]+)\/(.+)$/i);
  return {
    bucket: clean(asset.storage.bucket) || (match ? match[1] : ''),
    objectPath: match ? match[2] : rawPath,
  };
}

export class ImagePreviewService implements ImagePreviewGeneratorLike {
  constructor(private readonly objectStore: AssetPreviewObjectStoreLike = directorGcsStore) {}

  async generate(asset: DirectorAssetRecord): Promise<ImagePreviewGenerationResult> {
    const source = sourceObject(asset);
    if (!source.bucket || !source.objectPath) throw new Error('DIRECTOR_PREVIEW_SOURCE_NOT_FOUND');
    const sourceFile = await this.objectStore.getAsset(source);
    const sourceImage = sharp(sourceFile.buffer, { failOn: 'error' });
    const metadata = await sourceImage.metadata();
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    if (!width || !height) throw new Error('DIRECTOR_PREVIEW_IMAGE_METADATA_INVALID');

    const thumbnail = await sharp(sourceFile.buffer)
      .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer();
    const medium = await sharp(sourceFile.buffer)
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();

    const [thumbnailRef, mediumRef] = await Promise.all([
      this.objectStore.putPreview({
        projectId: asset.projectId,
        assetId: asset.assetId,
        variant: 'thumbnail',
        mimeType: 'image/jpeg',
        buffer: thumbnail,
      }),
      this.objectStore.putPreview({
        projectId: asset.projectId,
        assetId: asset.assetId,
        variant: 'medium',
        mimeType: 'image/jpeg',
        buffer: medium,
      }),
    ]);

    return {
      width,
      height,
      durationSeconds: 0,
      thumbnailPath: thumbnailRef.objectPath,
      mediumPreviewPath: mediumRef.objectPath,
      previewPath: mediumRef.objectPath,
      videoPreviewPath: '',
      framePaths: [],
    };
  }
}

export const imagePreviewService = new ImagePreviewService();
