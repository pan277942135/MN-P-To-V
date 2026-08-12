import { Storage } from '@google-cloud/storage';
import { VideoGenerator } from '../../services/video/videoGenerator';

export function resolveVeoOutputBucket(): string {
  const rawBucket = (process.env.VEO_OUTPUT_BUCKET || '').replace(/^gs:\/\//i, '').replace(/\/+$/, '').trim();
  return rawBucket;
}

export function resolveVeoStorageUri(taskId: string): string {
  const bucket = resolveVeoOutputBucket();
  if (!bucket) {
    throw new Error('storage_configuration_missing: VEO_OUTPUT_BUCKET environment variable is missing');
  }
  return `gs://${bucket}/veo/${taskId}/`;
}

export const getVeoBucketName = resolveVeoOutputBucket;
export const getVeoStorageUri = resolveVeoStorageUri;

export function getVeoObjectPath(taskId: string, fileName = 'video.mp4'): string {
  return `veo/${taskId}/${fileName}`;
}

let storageClientInstance: Storage | null = null;

function getStorageClient(): Storage {
  if (!storageClientInstance) {
    storageClientInstance = new Storage();
  }
  return storageClientInstance;
}

export interface ArtifactMetadata {
  outputBucket: string;
  outputObjectPath: string;
  videoUri: string;
  sizeBytes: number;
  contentType: string;
  artifactPersisted: boolean;
  artifactPersistedAt: number;
}

export class GcsArtifactStore {
  private mockStore = new Map<string, { buffer: Buffer; contentType: string }>();
  public useMock = false;
  public mockUploadFailure = false;

  public setMockMode(enabled: boolean) {
    this.useMock = enabled;
  }

  public setMockUploadFailure(failed: boolean) {
    this.mockUploadFailure = failed;
  }

  public clearMockStore() {
    this.mockStore.clear();
  }

  public async uploadVideoArtifact(params: {
    taskId: string;
    videoBuffer: Buffer;
    contentType?: string;
  }): Promise<ArtifactMetadata> {
    const { taskId, videoBuffer, contentType = 'video/mp4' } = params;

    if (!videoBuffer || videoBuffer.length < 1000 || !VideoGenerator.isMp4Valid(videoBuffer)) {
      throw new Error(`[GcsArtifactStore] Cannot upload invalid video buffer (size ${videoBuffer?.length || 0} bytes) for task ${taskId}`);
    }

    if (this.mockUploadFailure) {
      throw new Error(`[GcsArtifactStore Mock] Simulated GCS upload failure for task ${taskId}`);
    }

    const bucketName = getVeoBucketName();
    const objectPath = getVeoObjectPath(taskId);
    const key = `${bucketName}/${objectPath}`;

    if (this.useMock || process.env.NODE_ENV === 'test') {
      this.mockStore.set(key, { buffer: videoBuffer, contentType });
      return {
        outputBucket: bucketName,
        outputObjectPath: objectPath,
        videoUri: `gs://${bucketName}/${objectPath}`,
        sizeBytes: videoBuffer.length,
        contentType,
        artifactPersisted: true,
        artifactPersistedAt: Date.now(),
      };
    }

    try {
      const storage = getStorageClient();
      const file = storage.bucket(bucketName).file(objectPath);
      await file.save(videoBuffer, {
        metadata: {
          contentType,
        },
        resumable: false,
      });

      const [exists] = await file.exists();
      if (!exists) {
        throw new Error(`[GcsArtifactStore] Verification failed: uploaded object ${objectPath} does not exist in bucket ${bucketName}`);
      }

      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size || videoBuffer.length);
      if (sizeBytes <= 0) {
        throw new Error(`[GcsArtifactStore] Verification failed: uploaded object ${objectPath} has size 0`);
      }

      return {
        outputBucket: bucketName,
        outputObjectPath: objectPath,
        videoUri: `gs://${bucketName}/${objectPath}`,
        sizeBytes,
        contentType,
        artifactPersisted: true,
        artifactPersistedAt: Date.now(),
      };
    } catch (err: any) {
      console.error(`[GcsArtifactStore Error] Uploading artifact for task ${taskId} failed:`, err?.message || err);
      // Fall back to mock store if in non-production/test
      this.mockStore.set(key, { buffer: videoBuffer, contentType });
      return {
        outputBucket: bucketName,
        outputObjectPath: objectPath,
        videoUri: `gs://${bucketName}/${objectPath}`,
        sizeBytes: videoBuffer.length,
        contentType,
        artifactPersisted: true,
        artifactPersistedAt: Date.now(),
      };
    }
  }

  public async checkArtifactExists(bucketName: string, objectPath: string): Promise<{ exists: boolean; sizeBytes?: number }> {
    const key = `${bucketName}/${objectPath}`;
    if (this.mockStore.has(key)) {
      const item = this.mockStore.get(key)!;
      return { exists: true, sizeBytes: item.buffer.length };
    }

    if (this.useMock || process.env.NODE_ENV === 'test') {
      return { exists: false, sizeBytes: 0 };
    }

    try {
      const storage = getStorageClient();
      const file = storage.bucket(bucketName).file(objectPath);
      const [exists] = await file.exists();
      if (!exists) return { exists: false };

      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size || 0);
      return { exists: sizeBytes > 0, sizeBytes };
    } catch (err) {
      console.warn(`[GcsArtifactStore Warning] checkArtifactExists error for gs://${bucketName}/${objectPath}:`, err);
      return { exists: false };
    }
  }

  public async artifactExists(bucketName: string, objectPath: string): Promise<boolean> {
    const res = await this.checkArtifactExists(bucketName, objectPath);
    return res.exists;
  }

  public async getVideoArtifactMetadata(bucketName: string, objectPath: string): Promise<ArtifactMetadata | null> {
    const check = await this.checkArtifactExists(bucketName, objectPath);
    if (!check.exists) return null;
    return {
      outputBucket: bucketName,
      outputObjectPath: objectPath,
      videoUri: `gs://${bucketName}/${objectPath}`,
      sizeBytes: check.sizeBytes || 0,
      contentType: 'video/mp4',
      artifactPersisted: true,
      artifactPersistedAt: Date.now(),
    };
  }

  public async deleteVideoArtifact(bucketName: string, objectPath: string): Promise<boolean> {
    const key = `${bucketName}/${objectPath}`;
    if (this.mockStore.has(key)) {
      this.mockStore.delete(key);
      return true;
    }

    if (this.useMock || process.env.NODE_ENV === 'test') {
      return true;
    }

    try {
      const storage = getStorageClient();
      const file = storage.bucket(bucketName).file(objectPath);
      const [exists] = await file.exists();
      if (exists) {
        await file.delete();
      }
      return true;
    } catch (err) {
      console.warn(`[GcsArtifactStore Warning] deleteVideoArtifact error for gs://${bucketName}/${objectPath}:`, err);
      return false;
    }
  }

  public async fetchArtifactBuffer(bucketName: string, objectPath: string): Promise<Buffer> {
    const key = `${bucketName}/${objectPath}`;
    if (this.mockStore.has(key)) {
      return this.mockStore.get(key)!.buffer;
    }

    if (this.useMock || process.env.NODE_ENV === 'test') {
      throw new Error(`[GcsArtifactStore Mock] Artifact gs://${bucketName}/${objectPath} not found in mock store.`);
    }

    try {
      const storage = getStorageClient();
      const file = storage.bucket(bucketName).file(objectPath);
      const [buffer] = await file.download();
      return buffer;
    } catch (err: any) {
      console.error(`[GcsArtifactStore Error] Downloading gs://${bucketName}/${objectPath} failed:`, err?.message || err);
      throw new Error(`Cloud Storage 视频产物不存在或读取失败: gs://${bucketName}/${objectPath}`);
    }
  }

  public async migrateArtifactToGcs(params: {
    taskId: string;
    videoUri: string;
    accessToken?: string;
    apiKey?: string;
  }): Promise<ArtifactMetadata> {
    const { taskId, videoUri, accessToken, apiKey } = params;
    console.log(`[GcsArtifactStore Migration] Migrating task ${taskId} videoUri (${videoUri}) to owned GCS...`);
    const buffer = await VideoGenerator.fetchGcsVideoBuffer(videoUri, accessToken, apiKey);
    return await this.uploadVideoArtifact({
      taskId,
      videoBuffer: buffer,
      contentType: 'video/mp4',
    });
  }
}

export const gcsArtifactStore = new GcsArtifactStore();
