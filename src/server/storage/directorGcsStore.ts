import path from 'node:path';
import { Storage } from '@google-cloud/storage';
import { resolveVeoOutputBucket } from './gcsArtifactStore';

export interface DirectorCloudAssetRef {
  shotUid: string;
  blobKey: string;
  bucket: string;
  objectPath: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
  generation: string;
  updatedAt: number;
  width?: number;
  height?: number;
  aspectRatio?: string;
}

export type DirectorPreviewVariant = 'thumbnail' | 'medium' | 'video-preview' | 'frame';

export interface DirectorPreviewObjectRef {
  bucket: string;
  objectPath: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
  generation: string;
  updatedAt: number;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'video/mp4': return '.mp4';
    case 'audio/mpeg': return '.mp3';
    case 'audio/wav': return '.wav';
    default: return '.png';
  }
}

export function directorKeyframeObjectPath(input: {
  projectId: string;
  episodeId: string;
  shotUid: string;
  blobKey: string;
  mimeType: string;
}): string {
  const ext = extensionForMime(input.mimeType);
  return path.posix.join(
    'director',
    'projects',
    safeSegment(input.projectId),
    'episodes',
    safeSegment(input.episodeId),
    'shots',
    safeSegment(input.shotUid),
    'keyframes',
    `${safeSegment(input.blobKey)}${ext}`,
  );
}

/**
 * All preview objects are derived siblings of the original asset. Keeping a
 * deterministic path makes retries idempotent and lets the API serve private
 * GCS objects through the Director Gateway without exposing bucket credentials.
 */
export function directorPreviewObjectPath(input: {
  projectId: string;
  assetId: string;
  variant: DirectorPreviewVariant;
  mimeType?: string;
  frameIndex?: number;
}): string {
  const projectId = safeSegment(clean(input.projectId));
  const assetId = safeSegment(clean(input.assetId));
  const mimeType = clean(input.mimeType) || 'image/jpeg';
  if (input.variant === 'frame') {
    const frameIndex = Math.max(1, Math.floor(Number(input.frameIndex) || 1));
    return path.posix.join(
      'projects',
      projectId,
      'previews',
      'frames',
      assetId,
      `frame_${String(frameIndex).padStart(3, '0')}${extensionForMime(mimeType)}`,
    );
  }
  const extension = extensionForMime(mimeType);
  return path.posix.join(
    'projects',
    projectId,
    'previews',
    input.variant === 'video-preview'
      ? 'video-preview'
      : input.variant === 'thumbnail' ? 'thumbnails' : input.variant,
    `${assetId}${extension}`,
  );
}

class DirectorGcsStore {
  private storage: Storage | null = null;

  private client() {
    if (!this.storage) this.storage = new Storage();
    return this.storage;
  }

  bucketName() {
    return resolveVeoOutputBucket();
  }

  async putKeyframe(input: {
    projectId: string;
    episodeId: string;
    shotUid: string;
    blobKey: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<DirectorCloudAssetRef> {
    const projectId = clean(input.projectId);
    const episodeId = clean(input.episodeId);
    const shotUid = clean(input.shotUid);
    const blobKey = clean(input.blobKey);
    const mimeType = clean(input.mimeType) || 'image/png';
    if (!projectId || !episodeId || !shotUid || !blobKey || !input.buffer?.length) {
      throw new Error('DIRECTOR_GCS_ASSET_INPUT_INVALID');
    }

    const bucket = this.bucketName();
    const objectPath = directorKeyframeObjectPath({ projectId, episodeId, shotUid, blobKey, mimeType });
    const file = this.client().bucket(bucket).file(objectPath);
    await file.save(input.buffer, {
      resumable: false,
      contentType: mimeType,
      metadata: {
        cacheControl: 'private, max-age=31536000, immutable',
        metadata: {
          directorProjectId: projectId,
          directorEpisodeId: episodeId,
          directorShotUid: shotUid,
          directorBlobKey: blobKey,
        },
      },
    });
    const [metadata] = await file.getMetadata();
    return {
      shotUid,
      blobKey,
      bucket,
      objectPath,
      uri: `gs://${bucket}/${objectPath}`,
      mimeType: String(metadata.contentType || mimeType),
      sizeBytes: Number(metadata.size || input.buffer.length),
      generation: String(metadata.generation || ''),
      updatedAt: Date.now(),
    };
  }

  async putPreview(input: {
    projectId: string;
    assetId: string;
    variant: DirectorPreviewVariant;
    mimeType: string;
    buffer: Buffer;
    frameIndex?: number;
  }): Promise<DirectorPreviewObjectRef> {
    const projectId = clean(input.projectId);
    const assetId = clean(input.assetId);
    const mimeType = clean(input.mimeType) || 'application/octet-stream';
    if (!projectId || !assetId || !input.variant || !input.buffer?.length) {
      throw new Error('DIRECTOR_PREVIEW_ASSET_INPUT_INVALID');
    }

    const bucket = this.bucketName();
    const objectPath = directorPreviewObjectPath({
      projectId,
      assetId,
      variant: input.variant,
      mimeType,
      frameIndex: input.frameIndex,
    });
    const file = this.client().bucket(bucket).file(objectPath);
    await file.save(input.buffer, {
      resumable: false,
      contentType: mimeType,
      metadata: {
        cacheControl: 'private, max-age=31536000, immutable',
        metadata: {
          directorProjectId: projectId,
          directorAssetId: assetId,
          directorPreviewVariant: input.variant,
        },
      },
    });
    const [metadata] = await file.getMetadata();
    return {
      bucket,
      objectPath,
      uri: `gs://${bucket}/${objectPath}`,
      mimeType: String(metadata.contentType || mimeType),
      sizeBytes: Number(metadata.size || input.buffer.length),
      generation: String(metadata.generation || ''),
      updatedAt: Date.now(),
    };
  }

  async getAsset(ref: Pick<DirectorCloudAssetRef, 'bucket' | 'objectPath'>): Promise<{ buffer: Buffer; mimeType: string }> {
    const bucket = clean(ref.bucket) || this.bucketName();
    const objectPath = clean(ref.objectPath);
    if (!objectPath) throw new Error('DIRECTOR_GCS_OBJECT_PATH_REQUIRED');
    const file = this.client().bucket(bucket).file(objectPath);
    const [[metadata], [buffer]] = await Promise.all([file.getMetadata(), file.download()]);
    return {
      buffer,
      mimeType: String(metadata.contentType || 'application/octet-stream'),
    };
  }
}

export const directorGcsStore = new DirectorGcsStore();
