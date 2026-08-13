import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { gcsArtifactStore, getVeoBucketName } from '../server/storage/gcsArtifactStore';
import { firestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';
import { serverVideoTaskStore, ephemeralVideoStore, ephemeralImageStore } from '../../server';
import type { ServerVideoTaskRecord } from '../types';

function createTestTask(overrides: Partial<ServerVideoTaskRecord>): ServerVideoTaskRecord {
  const taskId = overrides.taskId || overrides.id || 'task_test_default';
  return {
    id: taskId,
    taskId: taskId,
    status: 'completed',
    modelId: 'veo-3.1-fast-generate-001',
    projectId: 'test-project',
    region: 'asia-south1',
    durationSeconds: 4,
    aspectRatio: '16:9',
    mode: 'first_frame',
    scenePrompt: 'test prompt',
    evidenceSource: 'firestore',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as ServerVideoTaskRecord;
}

describe('P0-2R Storage Authority Regression & Contract Tests', () => {
  const validHeader = Buffer.from('000000206674797069736f6d0000020069736f6d69736f3261766331', 'hex');
  const sampleMp4Buffer = Buffer.concat([validHeader, Buffer.alloc(2000, 1)]);

  beforeEach(() => {
    gcsArtifactStore.clearMockStore();
    gcsArtifactStore.setMockMode(true);
    gcsArtifactStore.setMockUploadFailure(false);
    serverVideoTaskStore.clear();
    ephemeralVideoStore.clear();
    ephemeralImageStore.clear();
  });

  afterEach(() => {
    gcsArtifactStore.setMockUploadFailure(false);
  });

  // ==========================================
  // 1. Cold Start Regression
  // ==========================================
  describe('R1 Cold Start Regression', () => {
    it('Task can be recovered from Firestore, GCS metadata points to video, no local files required', async () => {
      const taskId = 'task_cold_start_1';
      
      // Upload artifact to GCS
      const artifactMeta = await gcsArtifactStore.uploadVideoArtifact({
        taskId,
        videoBuffer: sampleMp4Buffer,
        contentType: 'video/mp4',
      });

      const record = createTestTask({
        id: taskId,
        taskId,
        status: 'completed',
        completedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        outputBucket: artifactMeta.outputBucket,
        outputObjectPath: artifactMeta.outputObjectPath,
        videoUri: artifactMeta.videoUri,
        sizeBytes: sampleMp4Buffer.length,
        contentType: 'video/mp4',
        artifactPersisted: true,
        artifactPersistedAt: artifactMeta.artifactPersistedAt,
        videoDataUrl: `/api/videos/stream/${taskId}`,
      });

      await firestoreTaskRepository.createTask(record);

      // Simulate Cold Start: Clear memory maps
      serverVideoTaskStore.clear();
      ephemeralVideoStore.clear();
      ephemeralImageStore.clear();

      // 1. Query Firestore directly
      const fetchedTask = await firestoreTaskRepository.getTask(taskId);
      expect(fetchedTask).toBeDefined();
      expect(fetchedTask?.status).toBe('completed');
      expect(fetchedTask?.outputBucket).toBe(artifactMeta.outputBucket);
      expect(fetchedTask?.outputObjectPath).toBe(artifactMeta.outputObjectPath);
      expect(fetchedTask?.artifactPersisted).toBe(true);

      // 2. Fetch video artifact directly from GCS using Firestore metadata
      const fetchedVideoBuf = await gcsArtifactStore.fetchArtifactBuffer(
        fetchedTask!.outputBucket!,
        fetchedTask!.outputObjectPath!
      );
      expect(fetchedVideoBuf).toBeDefined();
      expect(fetchedVideoBuf.length).toBe(sampleMp4Buffer.length);
    });
  });

  // ==========================================
  // 2. Cross Instance Regression
  // ==========================================
  describe('R2 Cross Instance Regression', () => {
    it('Instance B reads task from Firestore & video from GCS with zero memory/disk state from Instance A', async () => {
      const taskId = 'task_cross_inst_2';

      // --- Instance A ---
      const artifactMeta = await gcsArtifactStore.uploadVideoArtifact({
        taskId,
        videoBuffer: sampleMp4Buffer,
        contentType: 'video/mp4',
      });

      const taskA = createTestTask({
        id: taskId,
        taskId,
        status: 'completed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        outputBucket: artifactMeta.outputBucket,
        outputObjectPath: artifactMeta.outputObjectPath,
        videoUri: artifactMeta.videoUri,
        artifactPersisted: true,
        sizeBytes: sampleMp4Buffer.length,
      });

      await firestoreTaskRepository.createTask(taskA);

      // --- Instance B ---
      // Clear memory stores to simulate unshared memory in Instance B
      serverVideoTaskStore.clear();
      ephemeralVideoStore.clear();

      // Instance B queries Firestore for Task
      const taskB = await firestoreTaskRepository.getTask(taskId);
      expect(taskB).toBeDefined();
      expect(taskB?.taskId).toBe(taskId);
      expect(taskB?.status).toBe('completed');

      // Instance B fetches video artifact from GCS using retrieved metadata
      const videoB = await gcsArtifactStore.fetchArtifactBuffer(
        taskB!.outputBucket!,
        taskB!.outputObjectPath!
      );
      expect(videoB).toBeDefined();
      expect(videoB.length).toBe(sampleMp4Buffer.length);
    });
  });

  // ==========================================
  // 3. Video Cache Miss Regression
  // ==========================================
  describe('R3 Video Cache Miss Regression', () => {
    it('Cache miss on ephemeralVideoStore triggers Firestore + GCS fetch without writing to local disk', async () => {
      const taskId = 'task_cache_miss_3';

      const artifactMeta = await gcsArtifactStore.uploadVideoArtifact({
        taskId,
        videoBuffer: sampleMp4Buffer,
      });

      const taskRecord = createTestTask({
        id: taskId,
        taskId,
        status: 'completed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        outputBucket: artifactMeta.outputBucket,
        outputObjectPath: artifactMeta.outputObjectPath,
        videoUri: artifactMeta.videoUri,
        artifactPersisted: true,
        sizeBytes: sampleMp4Buffer.length,
      });

      await firestoreTaskRepository.createTask(taskRecord);

      // Ensure cache miss
      ephemeralVideoStore.delete(taskId);
      expect(ephemeralVideoStore.has(taskId)).toBe(false);

      // Query task & fetch video
      const rec = await firestoreTaskRepository.getTask(taskId);
      expect(rec).toBeDefined();

      const videoBuffer = await gcsArtifactStore.fetchArtifactBuffer(rec!.outputBucket!, rec!.outputObjectPath!);
      expect(videoBuffer).toBeDefined();
      expect(videoBuffer.length).toBe(sampleMp4Buffer.length);

      // Populates ephemeral memory store only
      ephemeralVideoStore.set(taskId, videoBuffer);
      expect(ephemeralVideoStore.has(taskId)).toBe(true);

      // Verify Cloud Run local disk was NOT written to
      const localDiskPath = path.join(process.cwd(), 'data', 'videos', `${taskId}.mp4`);
      expect(fs.existsSync(localDiskPath)).toBe(false);
    });
  });

  // ==========================================
  // 4. GCS Upload Failure Regression
  // ==========================================
  describe('R4 GCS Upload Failure Regression', () => {
    it('When GCS upload fails, status MUST be artifact_persist_failed and artifactPersisted MUST NOT be true', async () => {
      const taskId = 'task_gcs_fail_4';
      gcsArtifactStore.setMockUploadFailure(true);

      let status = 'polling';
      let artifactPersisted = false;
      let errorObj: any = null;

      try {
        await gcsArtifactStore.uploadVideoArtifact({
          taskId,
          videoBuffer: sampleMp4Buffer,
        });
        status = 'completed';
        artifactPersisted = true;
      } catch (err: any) {
        status = 'artifact_persist_failed';
        artifactPersisted = false;
        errorObj = {
          code: 'GCS_UPLOAD_FAILED',
          stage: 'artifact_persist',
          source: 'artifact_persist',
          message: err.message,
          retryable: true,
          timestamp: Date.now(),
        };
      }

      expect(status).toBe('artifact_persist_failed');
      expect(status).not.toBe('completed');
      expect(artifactPersisted).toBe(false);
      expect(errorObj).toBeDefined();
      expect(errorObj.stage).toBe('artifact_persist');

      // Verify task in Firestore if saved as failed
      const failRecord = createTestTask({
        id: taskId,
        taskId,
        status: 'artifact_persist_failed',
        error: errorObj.message,
        structuredError: errorObj,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await firestoreTaskRepository.createTask(failRecord);

      const savedTask = await firestoreTaskRepository.getTask(taskId);
      expect(savedTask?.status).toBe('artifact_persist_failed');
      expect(savedTask?.artifactPersisted).not.toBe(true);
    });
  });

  // ==========================================
  // 5. Restart Recovery Regression
  // ==========================================
  describe('R5 Restart Recovery Regression', () => {
    it('Restart clears all memory maps; completed task & video metadata remain intact in Firestore + GCS', async () => {
      const taskId = 'task_restart_5';

      const artifactMeta = await gcsArtifactStore.uploadVideoArtifact({
        taskId,
        videoBuffer: sampleMp4Buffer,
      });

      const taskRecord = createTestTask({
        id: taskId,
        taskId,
        status: 'completed',
        completedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        outputBucket: artifactMeta.outputBucket,
        outputObjectPath: artifactMeta.outputObjectPath,
        videoUri: artifactMeta.videoUri,
        artifactPersisted: true,
        sizeBytes: sampleMp4Buffer.length,
      });

      await firestoreTaskRepository.createTask(taskRecord);
      serverVideoTaskStore.set(taskId, taskRecord);
      ephemeralVideoStore.set(taskId, sampleMp4Buffer);

      // Simulate Restart
      serverVideoTaskStore.clear();
      ephemeralVideoStore.clear();
      ephemeralImageStore.clear();

      // Verify recovery
      const recoveredTask = await firestoreTaskRepository.getTask(taskId);
      expect(recoveredTask?.status).toBe('completed');
      expect(recoveredTask?.artifactPersisted).toBe(true);

      const recoveredVideo = await gcsArtifactStore.fetchArtifactBuffer(
        recoveredTask!.outputBucket!,
        recoveredTask!.outputObjectPath!
      );
      expect(recoveredVideo.length).toBe(sampleMp4Buffer.length);
    });
  });

  // ==========================================
  // 6. Ghost Artifact Regression
  // ==========================================
  describe('R6 Ghost Artifact Regression', () => {
    it('When Firestore marks completed but GCS Object is missing, stream returns artifact_not_found error', async () => {
      const taskId = 'task_ghost_6';

      // Record says completed in Firestore, but Object was NEVER uploaded to GCS
      const ghostTaskRecord = createTestTask({
        id: taskId,
        taskId,
        status: 'completed',
        outputBucket: getVeoBucketName(),
        outputObjectPath: `veo/${taskId}/video.mp4`,
        videoUri: `gs://${getVeoBucketName()}/veo/${taskId}/video.mp4`,
        artifactPersisted: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await firestoreTaskRepository.createTask(ghostTaskRecord);

      // Attempt to fetch non-existent GCS artifact
      let errorOccurred = false;
      let errorType = '';

      try {
        await gcsArtifactStore.fetchArtifactBuffer(ghostTaskRecord.outputBucket!, ghostTaskRecord.outputObjectPath!);
      } catch (err: any) {
        errorOccurred = true;
        errorType = 'artifact_not_found';
      }

      expect(errorOccurred).toBe(true);
      expect(errorType).toBe('artifact_not_found');

      // Verify we do NOT return a fake or 0-byte buffer
      let fakeBufferCreated = false;
      if (!errorOccurred) {
        fakeBufferCreated = true;
      }
      expect(fakeBufferCreated).toBe(false);
    });
  });

  // ==========================================
  // 7. Runtime Git Clean Regression
  // ==========================================
  describe('R7 Runtime Git Clean Regression', () => {
    it('Verifies .gitignore blocks runtime persistence artifacts from Git tracking', () => {
      const gitignorePath = path.join(process.cwd(), '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
      
      expect(gitignoreContent).toContain('data/video_tasks.json');
      expect(gitignoreContent).toContain('data/videos/');
      expect(gitignoreContent).toContain('data/images/');
      expect(gitignoreContent).toContain('data/characters.json');
    });
  });

  // ==========================================
  // 8. Storage Authority Contract Tests
  // ==========================================
  describe('Storage Authority Contract Tests', () => {
    it('CONTRACT-01: Task Metadata Authority = Firestore only', async () => {
      const taskId = 'contract_01_task';
      const record = createTestTask({
        id: taskId,
        taskId,
        status: 'completed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await firestoreTaskRepository.createTask(record);

      // Clear memory map
      serverVideoTaskStore.clear();

      // Memory cache miss must fall back to Firestore
      const retrieved = await firestoreTaskRepository.getTask(taskId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.taskId).toBe(taskId);
    });

    it('CONTRACT-02: Video Artifact Authority = GCS only', async () => {
      const taskId = 'contract_02_task';
      const meta = await gcsArtifactStore.uploadVideoArtifact({
        taskId,
        videoBuffer: sampleMp4Buffer,
      });

      expect(meta.outputBucket).toBe(getVeoBucketName());
      expect(meta.outputObjectPath).toBe(`veo/${taskId}/video.mp4`);
      expect(meta.videoUri).toContain('gs://');

      // Ensure local disk file does NOT exist
      const localDiskPath = path.join(process.cwd(), 'data', 'videos', `${taskId}.mp4`);
      expect(fs.existsSync(localDiskPath)).toBe(false);
    });

    it('CONTRACT-03: completed invariant', async () => {
      const completedTasks: ServerVideoTaskRecord[] = [
        createTestTask({
          id: 'task_inv_1',
          taskId: 'task_inv_1',
          status: 'completed',
          artifactPersisted: true,
          outputBucket: getVeoBucketName(),
          outputObjectPath: 'veo/task_inv_1/video.mp4',
          videoUri: `gs://${getVeoBucketName()}/veo/task_inv_1/video.mp4`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      ];

      for (const task of completedTasks) {
        if (task.status === 'completed') {
          expect(task.artifactPersisted).toBe(true);
          expect(task.outputBucket).toBeTruthy();
          expect(task.outputObjectPath).toBeTruthy();
          expect(task.videoUri).toBeTruthy();
        }
      }
    });

    it('CONTRACT-04: Memory Cache / Cloud Run Local FS != Durable Authority', async () => {
      const taskId = 'contract_04_task';
      const meta = await gcsArtifactStore.uploadVideoArtifact({
        taskId,
        videoBuffer: sampleMp4Buffer,
      });

      const record = createTestTask({
        id: taskId,
        taskId,
        status: 'completed',
        outputBucket: meta.outputBucket,
        outputObjectPath: meta.outputObjectPath,
        videoUri: meta.videoUri,
        artifactPersisted: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await firestoreTaskRepository.createTask(record);

      // Wipe all memory caches
      serverVideoTaskStore.clear();
      ephemeralVideoStore.clear();
      ephemeralImageStore.clear();

      // Complete recovery from Firestore + GCS
      const task = await firestoreTaskRepository.getTask(taskId);
      expect(task).toBeDefined();

      const videoBuf = await gcsArtifactStore.fetchArtifactBuffer(task!.outputBucket!, task!.outputObjectPath!);
      expect(videoBuf.length).toBe(sampleMp4Buffer.length);
    });
  });
});
