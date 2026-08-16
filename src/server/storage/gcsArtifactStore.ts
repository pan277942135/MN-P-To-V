import { Storage } from '@google-cloud/storage';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { VideoGenerator } from '../../services/video/videoGenerator';
import { redactSecrets } from '../../utils/redactSecrets';

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

function sanitizeGcsError(msg: string): string {
  if (!msg) return 'Unknown error';
  let cleaned = redactSecrets(msg.split('\n')[0]);
  if (cleaned.includes('does not have storage.objects.get access') || cleaned.includes("Permission 'storage.objects.get' denied")) {
    return 'GCS Access Denied (403: insufficient storage.objects.get permission)';
  }
  return cleaned;
}

function createTokenAuthClient(accessToken: string, projectId?: string) {
  const oauthClient = new OAuth2Client();
  oauthClient.setCredentials({
    access_token: accessToken,
    token_type: 'Bearer',
    expiry_date: Date.now() + 3600 * 1000 * 24,
  });

  return {
    getRequestHeaders: async (_url?: string) => ({
      Authorization: `Bearer ${accessToken}`,
      authorization: `Bearer ${accessToken}`,
    }),
    getAccessToken: async () => ({ token: accessToken }),
    getProjectId: async () => projectId || 'xp-vertex-project',
    request: async (opts: any) => oauthClient.request(opts),
  };
}

async function getStorageClientsForSessions(options?: { session?: any; accessToken?: string }): Promise<Storage[]> {
  const clients: Storage[] = [];
  const seenKeys = new Set<string>();

  if (options?.accessToken) {
    seenKeys.add('token_' + options.accessToken);
    try {
      clients.push(
        new Storage({
          authClient: createTokenAuthClient(options.accessToken, options?.session?.projectId) as any,
          projectId: options?.session?.projectId,
        })
      );
    } catch {}
  }

  const addClientForSession = async (s: any) => {
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
        let jwt = s.serviceAccountJwt;
        if (jwt && typeof jwt.then === 'function') {
          jwt = await jwt;
        }
        if (jwt) {
          clients.push(new Storage({ authClient: jwt, projectId: s.projectId }));
        }
      } catch {}
    }
    if (s.type === 'vertex_ai') {
      try {
        const { VertexClient } = await import('../../services/google/vertexClient');
        const token = await VertexClient.getAccessToken(s).catch(() => undefined);
        if (token && !seenKeys.has('token_' + token)) {
          seenKeys.add('token_' + token);
          clients.push(
            new Storage({
              authClient: createTokenAuthClient(token, s.projectId) as any,
              projectId: s.projectId,
            })
          );
        }
      } catch {}
    }
  };

  if (options?.session) {
    await addClientForSession(options.session);
  }

  try {
    const { CredentialService } = await import('../../services/google/credentialService');
    const sessions = CredentialService.listSessions();
    for (const s of sessions) {
      await addClientForSession(s);
    }
  } catch {}

  // Always include container default ADC client as fallback
  try {
    clients.push(getStorageClient());
  } catch {}

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

export type TaskPrefixVideoDiscoveryStatus = 'found' | 'not_found' | 'ambiguous';

export interface TaskPrefixVideoCandidate {
  outputObjectPath: string;
  videoUri: string;
  sizeBytes: number;
  contentType: string;
  updatedAt?: string;
}

export interface TaskPrefixVideoDiscoveryResult {
  status: TaskPrefixVideoDiscoveryStatus;
  expectedStoragePrefix: string;
  candidates: TaskPrefixVideoCandidate[];
  artifact?: ArtifactMetadata;
  videoBuffer?: Buffer;
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

  public resetMockStore() {
    this.mockStore.clear();
    this.mockUploadFailure = false;
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

    const storageConfig = assertProductionStorageConfig();
    if (!storageConfig.valid) {
      throw new Error(`[GcsArtifactStore Guard Error] ${storageConfig.error}`);
    }
    const bucketName = storageConfig.effectiveBucket;
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

    const storageConfig = assertProductionStorageConfig();
    if (!storageConfig.valid) {
      throw new Error(`[GcsArtifactStore Guard Error] ${storageConfig.error}`);
    }
    const bucketName = storageConfig.effectiveBucket;
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

  private async fetchExactArtifactBuffer(
    bucketName: string,
    objectPath: string,
    options?: { session?: any }
  ): Promise<Buffer> {
    const exactMockKey = `${bucketName}/${objectPath}`;
    if (this.mockStore.has(exactMockKey)) {
      return this.mockStore.get(exactMockKey)!.buffer;
    }
    if (this.useMock || process.env.NODE_ENV === 'test') {
      throw new Error(`[GcsArtifactStore Mock] Exact artifact gs://${bucketName}/${objectPath} not found.`);
    }

    const clients = await getStorageClientsForSessions({ session: options?.session });
    let lastError: any = null;
    for (const storage of clients) {
      try {
        const [bytes] = await storage.bucket(bucketName).file(objectPath).download();
        const buffer = Buffer.from(bytes);
        if (buffer.length > 0) return buffer;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `[GcsArtifactStore] Exact artifact download failed for gs://${bucketName}/${objectPath}: ${sanitizeGcsError(String(lastError?.message || lastError || 'no usable storage client'))}`
    );
  }

  public async discoverTaskPrefixVideo(params: {
    taskKey: string;
    session?: any;
  }): Promise<TaskPrefixVideoDiscoveryResult> {
    const rawTaskKey = String(params.taskKey || '').trim().replace(/^\/+|\/+$/g, '');
    if (!rawTaskKey || rawTaskKey.includes('..') || rawTaskKey.includes('\\') || rawTaskKey.includes('//')) {
      throw new Error('[GcsArtifactStore] Invalid taskKey for task-prefix recovery.');
    }

    const storageConfig = assertProductionStorageConfig();
    if (!storageConfig.valid) {
      throw new Error(`[GcsArtifactStore Guard Error] ${storageConfig.error}`);
    }

    const bucketName = storageConfig.effectiveBucket;
    const prefix = `veo/${rawTaskKey}/`;
    const expectedStoragePrefix = `gs://${bucketName}/${prefix}`;
    const candidatesByPath = new Map<string, TaskPrefixVideoCandidate>();

    const addCandidate = (objectPath: string, sizeBytes: number, contentType = '', updatedAt?: string) => {
      if (!objectPath.startsWith(prefix)) return;
      if (objectPath.includes('/qa/')) return;
      const isMp4 = objectPath.toLowerCase().endsWith('.mp4') || contentType.toLowerCase().includes('video/mp4');
      if (!isMp4 || !Number.isFinite(sizeBytes) || sizeBytes < 1000) return;
      candidatesByPath.set(objectPath, {
        outputObjectPath: objectPath,
        videoUri: `gs://${bucketName}/${objectPath}`,
        sizeBytes,
        contentType: contentType || 'video/mp4',
        updatedAt,
      });
    };

    if (this.useMock || process.env.NODE_ENV === 'test') {
      const bucketPrefix = `${bucketName}/`;
      for (const [key, item] of this.mockStore.entries()) {
        if (!key.startsWith(bucketPrefix)) continue;
        const objectPath = key.slice(bucketPrefix.length);
        addCandidate(objectPath, item.buffer.length, item.contentType);
      }
    } else {
      const clients = await getStorageClientsForSessions({ session: params.session });
      let listingSucceeded = false;
      let lastError: any = null;

      for (const storage of clients) {
        try {
          const [files] = await storage.bucket(bucketName).getFiles({ prefix });
          listingSucceeded = true;
          for (const file of files) {
            let metadata: any = (file as any).metadata || {};
            if (!metadata.size || !metadata.contentType || !metadata.updated) {
              try {
                [metadata] = await file.getMetadata();
              } catch {}
            }
            addCandidate(
              file.name,
              Number(metadata?.size || 0),
              String(metadata?.contentType || ''),
              metadata?.updated ? String(metadata.updated) : undefined
            );
          }
          break;
        } catch (err) {
          lastError = err;
        }
      }

      if (!listingSucceeded) {
        throw new Error(`[GcsArtifactStore] Unable to list task-prefix objects for ${expectedStoragePrefix}: ${sanitizeGcsError(String(lastError?.message || lastError || 'no usable storage client'))}`);
      }
    }

    const candidates = Array.from(candidatesByPath.values()).sort((a, b) => a.outputObjectPath.localeCompare(b.outputObjectPath));
    if (candidates.length === 0) {
      return { status: 'not_found', expectedStoragePrefix, candidates: [] };
    }

    const valid: Array<{ candidate: TaskPrefixVideoCandidate; buffer: Buffer }> = [];
    for (const candidate of candidates) {
      try {
        // Recovery evidence must be the exact object returned by the exact task/attempt
        // prefix listing. The general artifact fetcher intentionally has historical
        // fallback paths, so it is forbidden here.
        const buffer = await this.fetchExactArtifactBuffer(bucketName, candidate.outputObjectPath, { session: params.session });
        if (buffer.length >= 1000 && VideoGenerator.isMp4Valid(buffer)) {
          valid.push({ candidate, buffer });
        }
      } catch {}
    }

    if (valid.length === 0) {
      return { status: 'not_found', expectedStoragePrefix, candidates };
    }

    // If the app already managed to write its canonical video.mp4 before crashing, that
    // object is stronger evidence than additional Provider files under the same prefix.
    const canonicalPath = `${prefix}video.mp4`;
    const canonical = valid.find((entry) => entry.candidate.outputObjectPath === canonicalPath);
    const selected = canonical || (valid.length === 1 ? valid[0] : null);

    if (!selected) {
      return {
        status: 'ambiguous',
        expectedStoragePrefix,
        candidates: valid.map((entry) => entry.candidate),
      };
    }

    const persistedAt = selected.candidate.updatedAt
      ? Date.parse(selected.candidate.updatedAt) || Date.now()
      : Date.now();
    return {
      status: 'found',
      expectedStoragePrefix,
      candidates: valid.map((entry) => entry.candidate),
      artifact: {
        outputBucket: bucketName,
        outputObjectPath: selected.candidate.outputObjectPath,
        videoUri: selected.candidate.videoUri,
        sizeBytes: selected.buffer.length,
        contentType: selected.candidate.contentType || 'video/mp4',
        artifactPersisted: true,
        artifactPersistedAt: persistedAt,
      },
      videoBuffer: selected.buffer,
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

    // Resolve session & token upfront for both SDK download and REST fallback
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

    let lastError = '';

    // Tier 1: Primary HTTP REST fetch via Vertex Access Token or API Key
    try {
      const apiKey = options?.apiKey || activeSession?.apiKey || process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';

      for (const b of candidateBuckets) {
        try {
          const gcsUri = `gs://${b}/${objectPath}`;
          const buffer = await VideoGenerator.fetchGcsVideoBuffer(gcsUri, token, apiKey);
          if (buffer && buffer.length > 0) {
            console.log(`[GcsArtifactStore Success] Fetched video via REST API for gs://${b}/${objectPath} (${buffer.length} bytes)`);
            return buffer;
          }
        } catch (httpErr: any) {
          lastError = httpErr?.message || String(httpErr);
        }
      }
    } catch (tokenErr: any) {
      console.debug('[GcsArtifactStore Notice] REST token resolution skipped:', tokenErr?.message || tokenErr);
    }

    // Tier 2: Fallback to Node @google-cloud/storage SDK with session credentials or ADC
    const storageClients = await getStorageClientsForSessions({ session: activeSession, accessToken: token });

    const taskMatch = objectPath.match(/veo\/([^\/]+)/);
    const taskId = taskMatch ? taskMatch[1] : '';
    const candidatePaths = Array.from(new Set([
      objectPath,
      ...(taskId ? [
        `veo/${taskId}/video.mp4`,
        `veo/${taskId}/sample_0.mp4`,
        `veo/${taskId}/output_0.mp4`,
        `veo/${taskId}/video_0.mp4`,
        `veo/${taskId}/0.mp4`,
      ] : []),
    ]));

    for (const storage of storageClients) {
      for (const b of candidateBuckets) {
        for (const objPath of candidatePaths) {
          try {
            const file = storage.bucket(b).file(objPath);
            const [buffer] = await file.download();
            if (buffer && buffer.length > 0) {
              return buffer;
            }
          } catch (err: any) {
            lastError = err?.message || String(err);
            const cleanErr = sanitizeGcsError(lastError);
            console.debug(`[GcsArtifactStore Notice] SDK download for gs://${b}/${objPath} skipped: ${cleanErr}`);
          }
        }
      }
    }

    const finalCleanErr = sanitizeGcsError(lastError);
    console.info(`[GcsArtifactStore Notice] Downloading gs://${bucketName}/${objectPath} skipped across candidate buckets (${candidateBuckets.join(', ')}): ${finalCleanErr}`);
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
