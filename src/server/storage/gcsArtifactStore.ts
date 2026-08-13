import { Storage } from '@google-cloud/storage';
import { VideoGenerator } from '../../services/video/videoGenerator';

export const EXPECTED_PRODUCTION_VEO_BUCKET = 'ai-studio-bucket-89614354864-asia-south1';

export interface ProductionStorageConfig {
  valid: boolean;
  expectedBucket: string;
  environmentBucket: string;
  effectiveBucket: string;
  bucketDriftDetected: boolean;
  error?: string;
}

export function resolveVeoOutputBucket(): string {
  const rawEnv = process.env.VEO_OUTPUT_BUCKET || '';
  const cleanedEnv = rawEnv.replace(/^gs:\/\//i, '').replace(/\/+$/, '').trim();
  if (cleanedEnv) {
    return cleanedEnv;
  }
  return EXPECTED_PRODUCTION_VEO_BUCKET;
}

export function assertProductionStorageConfig(): ProductionStorageConfig {
  const rawEnv = process.env.VEO_OUTPUT_BUCKET || '';
  const environmentBucket = rawEnv.replace(/^gs:\/\//i, '').replace(/\/+$/, '').trim();
  const expectedBucket = EXPECTED_PRODUCTION_VEO_BUCKET;

  if (!environmentBucket) {
    return {
      valid: false,
      expectedBucket,
      environmentBucket: 'missing',
      effectiveBucket: expectedBucket,
      bucketDriftDetected: false,
      error: 'storage_configuration_missing',
    };
  }

  if (environmentBucket !== expectedBucket) {
    return {
      valid: false,
      expectedBucket,
      environmentBucket,
      effectiveBucket: environmentBucket,
      bucketDriftDetected: true,
      error: 'storage_configuration_drift',
    };
  }

  return {
    valid: true,
    expectedBucket,
    environmentBucket,
    effectiveBucket: environmentBucket,
    bucketDriftDetected: false,
  };
}

export function resolveVeoStorageUri(taskId: string): string {
  const bucket = resolveVeoOutputBucket();
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

function getStorageClientsForSessions(options?: { session?: any; accessToken?: string }): Storage[] {
  const clients: Storage[] = [];
  const seenKeys = new Set<string>();

  const addClientForSession = (s: any) => {
    if (!s) return;
    if (s.serviceAccountJsonRaw && !seenKeys.has(s.serviceAccountJsonRaw)) {
      seenKeys.add(s.serviceAccountJsonRaw);
      try {
        const credentials = JSON.parse(s.serviceAccountJsonRaw);
        clients.push(new Storage({ credentials, projectId: s.projectId }));
      } catch {}
    } else if (s.serviceAccountJwt && !seenKeys.has('jwt_' + (s.connectionId || s.projectId))) {
      seenKeys.add('jwt_' + (s.connectionId || s.projectId));
      try {
        clients.push(new Storage({ authClient: s.serviceAccountJwt, projectId: s.projectId }));
      } catch {}
    }
  };

  if (options?.session) {
    addClientForSession(options.session);
  }

  try {
    const { CredentialService } = require('../../services/google/credentialService');
    const sessions = CredentialService.listSessions();
    for (const s of sessions) {
      addClientForSession(s);
    }
  } catch {}

  // Fallback to container default ADC
  clients.push(getStorageClient());
  return clients;
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

  public async uploadImageArtifact(params: {
    objectPath: string;
    buffer: Buffer;
    contentType?: string;
  }): Promise<ArtifactMetadata> {
    const { objectPath, buffer, contentType = 'image/jpeg' } = params;

    if (!buffer || buffer.length === 0) {
      throw new Error(`[GcsArtifactStore] Cannot upload empty image buffer for ${objectPath}`);
    }

    const bucketName = getVeoBucketName();
    const key = `${bucketName}/${objectPath}`;

    if (this.useMock || process.env.NODE_ENV === 'test') {
      this.mockStore.set(key, { buffer, contentType });
      return {
        outputBucket: bucketName,
        outputObjectPath: objectPath,
        videoUri: `gs://${bucketName}/${objectPath}`,
        sizeBytes: buffer.length,
        contentType,
        artifactPersisted: true,
        artifactPersistedAt: Date.now(),
      };
    }

    try {
      const storage = getStorageClient();
      const file = storage.bucket(bucketName).file(objectPath);
      await file.save(buffer, {
        metadata: { contentType },
        resumable: false,
      });

      return {
        outputBucket: bucketName,
        outputObjectPath: objectPath,
        videoUri: `gs://${bucketName}/${objectPath}`,
        sizeBytes: buffer.length,
        contentType,
        artifactPersisted: true,
        artifactPersistedAt: Date.now(),
      };
    } catch (err: any) {
      console.error(`[GcsArtifactStore Error] Uploading image artifact ${objectPath} failed:`, err?.message || err);
      if (this.useMock || process.env.NODE_ENV === 'test') {
        this.mockStore.set(key, { buffer, contentType });
        return {
          outputBucket: bucketName,
          outputObjectPath: objectPath,
          videoUri: `gs://${bucketName}/${objectPath}`,
          sizeBytes: buffer.length,
          contentType,
          artifactPersisted: true,
          artifactPersistedAt: Date.now(),
        };
      }
      throw err;
    }
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
      throw err;
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
      console.debug(`[GcsArtifactStore Notice] checkArtifactExists skipped for gs://${bucketName}/${objectPath}:`, err);
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
      console.debug(`[GcsArtifactStore Notice] deleteVideoArtifact skipped for gs://${bucketName}/${objectPath}:`, err);
      return false;
    }
  }

  public async fetchArtifactBuffer(
    bucketName: string,
    objectPath: string,
    options?: { accessToken?: string; apiKey?: string; session?: any }
  ): Promise<Buffer> {
    const activeBucket = getVeoBucketName();
    const candidateBuckets = Array.from(
      new Set([bucketName, activeBucket, EXPECTED_PRODUCTION_VEO_BUCKET].filter(Boolean))
    );

    for (const b of candidateBuckets) {
      const mockKey = `${b}/${objectPath}`;
      if (this.mockStore.has(mockKey)) {
        return this.mockStore.get(mockKey)!.buffer;
      }
    }

    if (this.useMock || process.env.NODE_ENV === 'test') {
      throw new Error(`[GcsArtifactStore Mock] Artifact gs://${bucketName}/${objectPath} not found in mock store.`);
    }

    // Tier 1: Try Node @google-cloud/storage SDK with session credentials then ADC
    let lastError = '';
    const storageClients = getStorageClientsForSessions(options);

    for (const storage of storageClients) {
      for (const b of candidateBuckets) {
        try {
          const file = storage.bucket(b).file(objectPath);
          const [buffer] = await file.download();
          if (buffer && buffer.length > 0) {
            return buffer;
          }
        } catch (err: any) {
          lastError = err?.message || String(err);
          const firstLine = lastError.split('\n')[0];
          console.debug(`[GcsArtifactStore Notice] SDK download for gs://${b}/${objectPath} skipped: ${firstLine}`);
        }
      }
    }

    // Tier 2: Fallback to HTTP REST fetch via Vertex Access Token or API Key
    try {
      let token = options?.accessToken;
      let activeSession = options?.session;

      if (!activeSession) {
        try {
          const { CredentialService } = await import('../../services/google/credentialService');
          activeSession = CredentialService.getSession();
        } catch {}
      }

      if (!token && activeSession && activeSession.type === 'vertex_ai') {
        try {
          const { VertexClient } = await import('../../services/google/vertexClient');
          token = await VertexClient.getAccessToken(activeSession).catch(() => undefined);
        } catch {}
      }

      if (!token) {
        try {
          const { CredentialService } = await import('../../services/google/credentialService');
          const { VertexClient } = await import('../../services/google/vertexClient');
          const sessions = CredentialService.listSessions();
          const vSession = sessions.find((s: any) => s.type === 'vertex_ai');
          if (vSession) {
            token = await VertexClient.getAccessToken(vSession).catch(() => undefined);
          }
        } catch {}
      }

      if (!token) {
        try {
          const { GoogleAuth } = await import('google-auth-library');
          const auth = new GoogleAuth({
            scopes: [
              'https://www.googleapis.com/auth/cloud-platform',
              'https://www.googleapis.com/auth/devstorage.read_only',
            ],
          });
          const client = await auth.getClient();
          const tRes = await client.getAccessToken();
          token = typeof tRes === 'string' ? tRes : tRes?.token || undefined;
        } catch {}
      }

      const apiKey = options?.apiKey || activeSession?.apiKey || process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';

      for (const b of candidateBuckets) {
        try {
          const gcsUri = `gs://${b}/${objectPath}`;
          const buffer = await VideoGenerator.fetchGcsVideoBuffer(gcsUri, token, apiKey);
          if (buffer && buffer.length > 0) {
            console.log(`[GcsArtifactStore Success] Fetched video via REST API fallback for gs://${b}/${objectPath} (${buffer.length} bytes)`);
            return buffer;
          }
        } catch (httpErr: any) {
          lastError = httpErr?.message || String(httpErr);
        }
      }
    } catch (tokenErr: any) {
      console.debug('[GcsArtifactStore Notice] REST fallback token resolution skipped:', tokenErr?.message || tokenErr);
    }

    console.warn(`[GcsArtifactStore Warning] Downloading gs://${bucketName}/${objectPath} failed across candidate buckets (${candidateBuckets.join(', ')}):`, lastError);
    throw new Error(`Cloud Storage 视频产物不存在或读取失败: gs://${bucketName}/${objectPath}`);
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
