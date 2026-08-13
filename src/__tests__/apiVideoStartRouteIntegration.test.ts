import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server';
import { CredentialService, type ActiveSession } from '../services/google/credentialService';
import { VertexClient } from '../services/google/vertexClient';
import { VisualQaService } from '../services/qa/visualQaService';
import { FirstFrameGenerator } from '../services/image/firstFrameGenerator';
import { EXPECTED_PRODUCTION_VEO_BUCKET, gcsArtifactStore } from '../server/storage/gcsArtifactStore';
import { firestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';
import { taskStateMachineService } from '../server/services/taskStateMachineService';
import type { Express } from 'express';

const createValidPngBuffer = (width = 1080, height = 1920) => {
  const buf = Buffer.alloc(100);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
};

describe('M2-1.2 Express Route Integration Test: /api/videos/start', () => {
  let app: Express;
  let originalEnvBucket: string | undefined;
  let mockDurableTask: any = null;

  beforeEach(async () => {
    vi.restoreAllMocks();
    originalEnvBucket = process.env.VEO_OUTPUT_BUCKET;
    process.env.VEO_OUTPUT_BUCKET = EXPECTED_PRODUCTION_VEO_BUCKET;

    // Enable mock mode on gcsArtifactStore for integration tests
    gcsArtifactStore.setMockMode(true);

    // Mock Firestore repository for integration tests
    mockDurableTask = null;
    vi.spyOn(firestoreTaskRepository, 'isAvailable').mockReturnValue(true);
    vi.spyOn(firestoreTaskRepository, 'createTask').mockImplementation(async (task: any) => {
      mockDurableTask = { ...task };
    });
    vi.spyOn(firestoreTaskRepository, 'getTask').mockImplementation(async () => mockDurableTask);
    vi.spyOn(firestoreTaskRepository, 'updateTask').mockImplementation(async (taskId: string, patch: any) => {
      mockDurableTask = { ...(mockDurableTask || { id: taskId, taskId }), ...patch, id: taskId, taskId };
      return mockDurableTask;
    });

    // Mock the durable execution boundary used by the production route.
    vi.spyOn(taskStateMachineService, 'acquireLease').mockImplementation(async ({ taskId, leaseOwner }: any) => {
      const now = Date.now();
      mockDurableTask = {
        ...(mockDurableTask || { id: taskId, taskId, status: 'submitting' }),
        executionId: 'exec_route_test',
        leaseOwner,
        leaseExpiresAt: now + 180000,
        stateVersion: 2,
        statusVersion: 2,
      };
      return { acquired: true, reason: 'acquired', executionId: 'exec_route_test', task: mockDurableTask };
    });
    vi.spyOn(taskStateMachineService, 'transitionTask').mockImplementation(async ({ taskId, toStatus, patch }: any) => {
      mockDurableTask = {
        ...(mockDurableTask || { id: taskId, taskId }),
        ...(patch || {}),
        id: taskId,
        taskId,
        status: toStatus,
        stateVersion: (mockDurableTask?.stateVersion || 1) + 1,
      };
      mockDurableTask.statusVersion = mockDurableTask.stateVersion;
      return mockDurableTask;
    });
    vi.spyOn(taskStateMachineService, 'releaseLease').mockImplementation(async () => {
      if (mockDurableTask) mockDurableTask.leaseExpiresAt = 0;
      return true;
    });

    // Mock candidate generator to avoid calling external Gemini models during tests
    vi.spyOn(FirstFrameGenerator, 'generateFirstFrameCandidates').mockResolvedValue([
      {
        candidateId: 'cand_mock_1',
        blob: new Blob([createValidPngBuffer()], { type: 'image/png' }),
        mimeType: 'image/png',
        promptUsed: 'mock candidate prompt',
        stylePreservationScore: 90,
      },
    ] as any);

    app = await createApp();

    const mockSession: ActiveSession = {
      connectionId: 'test_conn_route_123',
      type: 'gemini_api_key',
      apiKey: 'test_mock_api_key',
      credentialSource: 'GEMINI_API_KEY',
      projectId: 'xp-vertex-project',
      location: 'us-central1',
      region: 'us-central1',
      requestedModel: 'veo-3.1-fast-generate-001',
      actualModel: 'veo-3.1-fast-generate-001',
      analysisModel: 'gemini-3.6-flash',
      imageModel: 'gemini-3.1-flash-image',
      videoModel: 'veo-3.1-fast-generate-001',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    };
    CredentialService.setSession(mockSession);
  });

  afterEach(() => {
    process.env.VEO_OUTPUT_BUCKET = originalEnvBucket;
    vi.restoreAllMocks();
  });

  it('Case 1: Wrong bucket -> HTTP rejected -> predictLongRunning calls = 0', async () => {
    process.env.VEO_OUTPUT_BUCKET = 'pan277942135';
    const spyPredict = vi.spyOn(VertexClient, 'predictLongRunning');

    const res = await request(app)
      .post('/api/videos/start')
      .set('x-connection-id', 'test_conn_route_123')
      .attach('firstFrame', createValidPngBuffer(), 'firstFrame.png')
      .field('rawUserPrompt', 'A person walking in the street');

    expect(res.status).toBe(503);
    expect(res.body.failureReason).toBe('storage_configuration_drift');
    expect(res.body.predictLongRunningCalls).toBe(0);
    expect(spyPredict).not.toHaveBeenCalled();
  });

  it('Case 2: 非目标角色 + 无master -> identity_reference_missing -> calls = 0', async () => {
    const spyPredict = vi.spyOn(VertexClient, 'predictLongRunning');

    const res = await request(app)
      .post('/api/videos/start')
      .set('x-connection-id', 'test_conn_route_123')
      .attach('firstFrame', createValidPngBuffer(), 'firstFrame.png')
      .field('rawUserPrompt', 'A person running in the field')
      .field('imageIsTargetCharacter', 'false')
      .field('sceneMode', 'replace_primary_person');

    expect(res.status).toBe(400);
    expect(res.body.failureReason).toBe('identity_reference_missing');
    expect(res.body.predictLongRunningCalls).toBe(0);
    expect(spyPredict).not.toHaveBeenCalled();
  });

  it('Case 3: QA fail -> calls = 0', async () => {
    const spyPredict = vi.spyOn(VertexClient, 'predictLongRunning');
    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce({
      pass: false,
      identityScore: 50,
      sourcePersonResidualScore: 80,
      scenePreservationScore: 60,
      posePreservationScore: 60,
      outfitPreservationScore: 60,
      anatomyScore: 60,
      faceDetails: 'Face mismatched drastically',
      hairDetails: 'Hair mismatched',
      bodyDetails: 'Body mismatched',
      summary: 'Identity QA Failed',
      issues: [{ code: 'FACE_MISMATCH', severity: 'critical', description: 'Face features do not match', repairInstruction: 'Re-align face' }],
    });

    const res = await request(app)
      .post('/api/videos/start')
      .set('x-connection-id', 'test_conn_route_123')
      .attach('firstFrame', createValidPngBuffer(), 'firstFrame.png')
      .attach('masterImages', createValidPngBuffer(), 'master.png')
      .field('rawUserPrompt', 'A person walking smoothly')
      .field('imageIsTargetCharacter', 'false')
      .field('sceneMode', 'replace_primary_person');

    expect(res.status).toBe(400);
    expect(res.body.failureReason).toBe('identity_qa_failed');
    expect(res.body.predictLongRunningCalls).toBe(0);
    expect(spyPredict).not.toHaveBeenCalled();
  });

  it('Case 4: QA review + manualApproved=false -> calls = 0', async () => {
    const spyPredict = vi.spyOn(VertexClient, 'predictLongRunning');
    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce({
      pass: true,
      identityScore: 88,
      sourcePersonResidualScore: 10,
      scenePreservationScore: 90,
      posePreservationScore: 90,
      outfitPreservationScore: 90,
      anatomyScore: 90,
      faceDetails: 'Face requires manual review',
      hairDetails: 'Hair acceptable',
      bodyDetails: 'Body acceptable',
      summary: 'Identity QA Review Required',
      issues: [],
    });

    const res = await request(app)
      .post('/api/videos/start')
      .set('x-connection-id', 'test_conn_route_123')
      .attach('firstFrame', createValidPngBuffer(), 'firstFrame.png')
      .attach('masterImages', createValidPngBuffer(), 'master.png')
      .field('rawUserPrompt', 'A person walking smoothly')
      .field('imageIsTargetCharacter', 'false')
      .field('manualApproved', 'false');

    expect(res.status).toBe(422);
    expect(res.body.failureReason).toBe('identity_qa_review_required');
    expect(res.body.requiresManualApproval).toBe(true);
    expect(res.body.predictLongRunningCalls).toBe(0);
    expect(spyPredict).not.toHaveBeenCalled();
  });

  it('Case 5: QA pass -> mocked predictLongRunning 恰好 1 次', async () => {
    const vertexSession: ActiveSession = {
      connectionId: 'test_conn_route_123',
      type: 'vertex_ai',
      apiKey: 'test_mock_api_key',
      serviceAccountJsonRaw: JSON.stringify({ client_email: 'test@account.com', private_key: 'key' }),
      serviceAccountJwt: { getAccessToken: async () => ({ token: 'mock-token' }) } as any,
      credentialSource: 'SERVICE_ACCOUNT',
      projectId: 'xp-vertex-project',
      location: 'us-central1',
      region: 'us-central1',
      requestedModel: 'veo-3.1-fast-generate-001',
      actualModel: 'veo-3.1-fast-generate-001',
      analysisModel: 'gemini-2.5-flash',
      imageModel: 'gemini-2.5-flash',
      videoModel: 'veo-3.1-fast-generate-001',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    };
    CredentialService.setSession(vertexSession);

    const spyPredict = vi.spyOn(VertexClient, 'predictLongRunning').mockResolvedValueOnce({
      operationName: 'projects/xp-vertex-project/locations/us-central1/operations/op_route_test_5',
      endpoint: 'us-central1-aiplatform.googleapis.com',
    });

    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce({
      pass: true,
      identityScore: 98,
      sourcePersonResidualScore: 0,
      scenePreservationScore: 98,
      posePreservationScore: 98,
      outfitPreservationScore: 98,
      anatomyScore: 98,
      faceDetails: 'Identity matched perfectly',
      hairDetails: 'Hair matched',
      bodyDetails: 'Body matched',
      summary: 'Identity QA Passed',
      issues: [],
    });

    const res = await request(app)
      .post('/api/videos/start')
      .set('x-connection-id', 'test_conn_route_123')
      .attach('firstFrame', createValidPngBuffer(), 'firstFrame.png')
      .attach('masterImages', createValidPngBuffer(), 'master.png')
      .field('rawUserPrompt', 'A person walking in the park')
      .field('imageIsTargetCharacter', 'false');

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);

    await vi.waitFor(() => {
      expect(spyPredict).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
  });

  it('Case 6: DIRECT + master QA pass -> rebuild调用0次 -> 允许进入mock Veo submission', async () => {
    const vertexSession: ActiveSession = {
      connectionId: 'test_conn_route_123',
      type: 'vertex_ai',
      apiKey: 'test_mock_api_key',
      serviceAccountJsonRaw: JSON.stringify({ client_email: 'test@account.com', private_key: 'key' }),
      serviceAccountJwt: { getAccessToken: async () => ({ token: 'mock-token' }) } as any,
      credentialSource: 'SERVICE_ACCOUNT',
      projectId: 'xp-vertex-project',
      location: 'us-central1',
      region: 'us-central1',
      requestedModel: 'veo-3.1-fast-generate-001',
      actualModel: 'veo-3.1-fast-generate-001',
      analysisModel: 'gemini-2.5-flash',
      imageModel: 'gemini-2.5-flash',
      videoModel: 'veo-3.1-fast-generate-001',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    };
    CredentialService.setSession(vertexSession);

    const spyRebuild = vi.spyOn(FirstFrameGenerator, 'generateFirstFrameCandidates');
    const spyPredict = vi.spyOn(VertexClient, 'predictLongRunning').mockResolvedValueOnce({
      operationName: 'projects/xp-vertex-project/locations/us-central1/operations/op_route_test_6',
      endpoint: 'us-central1-aiplatform.googleapis.com',
    });

    const spyQa = vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce({
      pass: true,
      identityScore: 98,
      sourcePersonResidualScore: 0,
      scenePreservationScore: 100,
      posePreservationScore: 100,
      outfitPreservationScore: 100,
      anatomyScore: 98,
      faceDetails: 'Direct image verified against master',
      hairDetails: 'Direct image hair verified against master',
      bodyDetails: 'Direct image body preserved',
      summary: 'Direct target-character image passed mandatory master QA',
      issues: [],
    });

    const res = await request(app)
      .post('/api/videos/start')
      .set('x-connection-id', 'test_conn_route_123')
      .attach('firstFrame', createValidPngBuffer(), 'firstFrame.png')
      .attach('masterImages', createValidPngBuffer(), 'master.png')
      .field('rawUserPrompt', 'A target character waving hand')
      .field('imageIsTargetCharacter', 'true');

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(spyRebuild).not.toHaveBeenCalled();
    expect(spyQa).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(spyPredict).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
  });
});
