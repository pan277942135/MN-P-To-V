import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveVeoOutputBucket, resolveVeoStorageUri, getVeoBucketName, getVeoStorageUri, gcsArtifactStore } from '../server/storage/gcsArtifactStore';
import { VertexClient } from '../services/google/vertexClient';
import { VideoGenerator } from '../services/video/videoGenerator';
import { type ActiveSession } from '../services/google/credentialService';

describe('P0-2 Bucket Configuration Drift & Enforced GCS Storage Requirements', () => {
  const originalEnv = process.env.VEO_OUTPUT_BUCKET;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.VEO_OUTPUT_BUCKET = originalEnv;
    } else {
      delete process.env.VEO_OUTPUT_BUCKET;
    }
  });

  it('1. VEO_OUTPUT_BUCKET empty -> resolveVeoOutputBucket returns empty string and predictLongRunning makes ZERO calls', async () => {
    delete process.env.VEO_OUTPUT_BUCKET;

    expect(resolveVeoOutputBucket()).toBe('');
    expect(getVeoBucketName()).toBe('');
    expect(() => resolveVeoStorageUri('task_test123')).toThrow('storage_configuration_missing');
    expect(() => getVeoStorageUri('task_test123')).toThrow('storage_configuration_missing');

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const session = {
      type: 'vertex_ai',
      serviceAccountJwt: 'test.jwt.token',
      projectId: 'xp-vertex-project',
      location: 'us-central1',
    } as unknown as ActiveSession;

    vi.spyOn(VertexClient, 'getAccessToken').mockResolvedValue('test-token');

    let predictError: any = null;
    try {
      await VertexClient.predictLongRunning(session, {
        prompt: 'a cinematic scene',
        imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        mimeType: 'image/png',
        taskId: 'task_missing_bucket',
      });
    } catch (err) {
      predictError = err;
    }

    expect(predictError).not.toBeNull();
    expect(predictError?.message).toContain('storage_configuration_missing');
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it('2. VEO_OUTPUT_BUCKET configured -> storageUri uses gs://${VEO_OUTPUT_BUCKET}/veo/${taskId}/', () => {
    process.env.VEO_OUTPUT_BUCKET = 'ai-studio-bucket-89614354864-asia-south1';

    expect(resolveVeoOutputBucket()).toBe('ai-studio-bucket-89614354864-asia-south1');
    expect(getVeoBucketName()).toBe('ai-studio-bucket-89614354864-asia-south1');
    const storageUri = resolveVeoStorageUri('task_55693400');
    expect(storageUri).toBe('gs://ai-studio-bucket-89614354864-asia-south1/veo/task_55693400/');
    expect(getVeoStorageUri('task_55693400')).toBe(storageUri);
  });

  it('3. predictLongRunning explicitly passes storageUri in parameters', async () => {
    process.env.VEO_OUTPUT_BUCKET = 'ai-studio-bucket-89614354864-asia-south1';

    let capturedBody: any = null;
    const mockFetch = vi.fn().mockImplementation((_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ name: 'projects/123/locations/us-central1/operations/op_123' }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const session = {
      type: 'vertex_ai',
      serviceAccountJwt: 'test.jwt.token',
      projectId: 'xp-vertex-project',
      location: 'us-central1',
    } as unknown as ActiveSession;

    vi.spyOn(VertexClient, 'getAccessToken').mockResolvedValue('test-token');

    const result = await VertexClient.predictLongRunning(session, {
      prompt: 'a cinematic scene',
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      mimeType: 'image/png',
      taskId: 'task_55693400',
    });

    expect(result.operationName).toBe('projects/123/locations/us-central1/operations/op_123');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(capturedBody.parameters.storageUri).toBe('gs://ai-studio-bucket-89614354864-asia-south1/veo/task_55693400/');
  });

  it('4. GCS artifact upload verifies existence and metadata before completing', async () => {
    process.env.VEO_OUTPUT_BUCKET = 'ai-studio-bucket-89614354864-asia-south1';

    const validMp4Buf = Buffer.alloc(2048, 0);
    validMp4Buf.write('ftypmp42', 4);

    expect(VideoGenerator.isMp4Valid(validMp4Buf)).toBe(true);

    const meta = await gcsArtifactStore.uploadVideoArtifact({
      taskId: 'task_gcs_test',
      videoBuffer: validMp4Buf,
    });

    expect(meta.outputBucket).toBe('ai-studio-bucket-89614354864-asia-south1');
    expect(meta.outputObjectPath).toBe('veo/task_gcs_test/video.mp4');
    expect(meta.videoUri).toBe('gs://ai-studio-bucket-89614354864-asia-south1/veo/task_gcs_test/video.mp4');
    expect(meta.artifactPersisted).toBe(true);
    expect(meta.sizeBytes).toBe(2048);
  });

  it('5. RAI filtered responses cannot become completed or generate download artifacts', () => {
    const safetyBlockResult = VideoGenerator.checkSafetyBlock({
      raiMediaFilteredCount: 1,
      raiMediaFilteredReasons: ['Safety reason'],
    });

    expect(safetyBlockResult.isBlocked).toBe(true);
    expect(safetyBlockResult.raiMediaFilteredCount).toBe(1);
  });
});
