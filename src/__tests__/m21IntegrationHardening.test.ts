import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdentityLockService } from '../services/character/identityLockService';
import { PromptCompiler } from '../services/prompt/PromptCompiler';
import { GcsArtifactStore, assertProductionStorageConfig, EXPECTED_PRODUCTION_VEO_BUCKET } from '../server/storage/gcsArtifactStore';
import { VideoGenerator } from '../services/video/videoGenerator';
import { VertexClient } from '../services/google/vertexClient';
import { VisualQaService } from '../services/qa/visualQaService';
import { FirstFrameGenerator } from '../services/image/firstFrameGenerator';

describe('M2-1.1 Integration Hardening', () => {
  let mockSceneBuffer: Buffer;
  let mockMasterBuffer: Buffer;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockSceneBuffer = Buffer.from('mock_scene_image_buffer_for_integration_testing');
    mockMasterBuffer = Buffer.from('mock_master_image_buffer_for_integration_testing');
    process.env.VEO_OUTPUT_BUCKET = EXPECTED_PRODUCTION_VEO_BUCKET;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('1. P0 Bucket Drift Guard: wrong bucket causes assertProductionStorageConfig to return valid=false and drift detected', () => {
    process.env.VEO_OUTPUT_BUCKET = 'pan277942135';
    const config = assertProductionStorageConfig();

    expect(config.valid).toBe(false);
    expect(config.bucketDriftDetected).toBe(true);
    expect(config.error).toBe('storage_configuration_drift');
    expect(config.environmentBucket).toBe('pan277942135');
  });

  test('2. P0 Bucket Drift Guard: missing bucket causes assertProductionStorageConfig to return valid=false and missing error', () => {
    delete process.env.VEO_OUTPUT_BUCKET;
    const config = assertProductionStorageConfig();

    expect(config.valid).toBe(false);
    expect(config.bucketDriftDetected).toBe(false);
    expect(config.error).toBe('storage_configuration_missing');
  });

  test('3. GCS Persistence: Real upload failure in production throws error and does not return fake artifactPersisted=true', async () => {
    const store = new GcsArtifactStore();
    store.setMockMode(false);
    store.setMockUploadFailure(true);

    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const validMp4Buf = Buffer.alloc(2048, 0);
    validMp4Buf.write('ftypmp42', 4);

    try {
      await expect(
        store.uploadVideoArtifact({
          taskId: 'task_gcs_fail_test',
          videoBuffer: validMp4Buf,
        })
      ).rejects.toThrow();
    } finally {
      process.env.NODE_ENV = oldNodeEnv;
    }
  });

  test('4. Identity QA fail -> evaluateIdentityGate returns canStartVeo=false and predicts 0 calls', async () => {
    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce({
      pass: false,
      identityScore: 65,
      sourcePersonResidualScore: 40,
      scenePreservationScore: 80,
      posePreservationScore: 80,
      outfitPreservationScore: 80,
      anatomyScore: 70,
      faceDetails: 'Face mismatched',
      hairDetails: 'Hair mismatched',
      bodyDetails: 'Body changed',
      summary: 'Identity QA failed severely',
      issues: [{ code: 'IDENTITY_MISMATCH', severity: 'critical', description: 'Facial anatomy altered', repairInstruction: '' }],
    });

    const spyPredict = vi.spyOn(VertexClient, 'predictLongRunning');

    const mockAi = {} as any;
    const gateResult = await IdentityLockService.evaluateIdentityGate({
      ai: mockAi,
      masterImageBuffer: mockMasterBuffer,
      masterMimeType: 'image/jpeg',
      sceneImageBuffer: mockSceneBuffer,
      sceneMimeType: 'image/jpeg',
      candidateBuffer: mockSceneBuffer,
      candidateMimeType: 'image/jpeg',
      identitySpec: { lockedTraits: [] },
      sceneMode: 'replace_primary_person',
    });

    expect(gateResult.status).toBe('fail');
    expect(gateResult.canStartVeo).toBe(false);
    expect(spyPredict).not.toHaveBeenCalled();
  });

  test('5. Identity QA review WITHOUT manual approval -> canStartVeo=false and predictLongRunning calls=0', async () => {
    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce({
      pass: true,
      identityScore: 88, // In review range [80, 95)
      sourcePersonResidualScore: 10,
      scenePreservationScore: 90,
      posePreservationScore: 90,
      outfitPreservationScore: 90,
      anatomyScore: 90,
      faceDetails: 'Minor feature variance',
      hairDetails: 'Matching',
      bodyDetails: 'Matching',
      summary: 'Review required due to minor score variance',
      issues: [],
    });

    const spyPredict = vi.spyOn(VertexClient, 'predictLongRunning');

    const mockAi = {} as any;
    const gateResult = await IdentityLockService.evaluateIdentityGate({
      ai: mockAi,
      masterImageBuffer: mockMasterBuffer,
      masterMimeType: 'image/jpeg',
      sceneImageBuffer: mockSceneBuffer,
      sceneMimeType: 'image/jpeg',
      candidateBuffer: mockSceneBuffer,
      candidateMimeType: 'image/jpeg',
      identitySpec: { lockedTraits: [] },
      sceneMode: 'replace_primary_person',
      manualApproved: false,
    });

    expect(gateResult.status).toBe('review');
    expect(gateResult.requiresManualApproval).toBe(true);
    expect(gateResult.canStartVeo).toBe(false);
    expect(spyPredict).not.toHaveBeenCalled();
  });

  test('6. Identity QA review WITH explicit manual approval -> canStartVeo=true', async () => {
    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce({
      pass: true,
      identityScore: 88,
      sourcePersonResidualScore: 10,
      scenePreservationScore: 90,
      posePreservationScore: 90,
      outfitPreservationScore: 90,
      anatomyScore: 90,
      faceDetails: 'Minor feature variance',
      hairDetails: 'Matching',
      bodyDetails: 'Matching',
      summary: 'Review approved by user',
      issues: [],
    });

    const mockAi = {} as any;
    const gateResult = await IdentityLockService.evaluateIdentityGate({
      ai: mockAi,
      masterImageBuffer: mockMasterBuffer,
      masterMimeType: 'image/jpeg',
      sceneImageBuffer: mockSceneBuffer,
      sceneMimeType: 'image/jpeg',
      candidateBuffer: mockSceneBuffer,
      candidateMimeType: 'image/jpeg',
      identitySpec: { lockedTraits: [] },
      sceneMode: 'replace_primary_person',
      manualApproved: true,
    });

    expect(gateResult.status).toBe('review');
    expect(gateResult.canStartVeo).toBe(true);
  });

  test('7. Identity QA pass -> canStartVeo=true', async () => {
    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce({
      pass: true,
      identityScore: 98,
      sourcePersonResidualScore: 0,
      scenePreservationScore: 95,
      posePreservationScore: 95,
      outfitPreservationScore: 95,
      anatomyScore: 95,
      faceDetails: 'Perfect match',
      hairDetails: 'Matching',
      bodyDetails: 'Matching',
      summary: 'High confidence pass',
      issues: [],
    });

    const mockAi = {} as any;
    const gateResult = await IdentityLockService.evaluateIdentityGate({
      ai: mockAi,
      masterImageBuffer: mockMasterBuffer,
      masterMimeType: 'image/jpeg',
      sceneImageBuffer: mockSceneBuffer,
      sceneMimeType: 'image/jpeg',
      candidateBuffer: mockSceneBuffer,
      candidateMimeType: 'image/jpeg',
      identitySpec: { lockedTraits: [] },
      sceneMode: 'replace_primary_person',
    });

    expect(gateResult.status).toBe('pass');
    expect(gateResult.canStartVeo).toBe(true);
  });

  test('8. DIRECT_CHARACTER_IMAGE: rebuild calls = 0 when user confirms imageIsTargetCharacter=true', async () => {
    const spyGenerator = vi.spyOn(FirstFrameGenerator, 'generateFirstFrameCandidates');

    const result = await IdentityLockService.rebuildFirstFrame({
      sceneImageBuffer: mockSceneBuffer,
      sceneMimeType: 'image/jpeg',
      identitySpec: { lockedTraits: [] },
      imageIsTargetCharacter: true,
    });

    expect(result.sourceMode).toBe('DIRECT_CHARACTER_IMAGE');
    expect(result.rebuildExecuted).toBe(false);
    expect(spyGenerator).not.toHaveBeenCalled();
  });

  test('9. Vertex Veo diagnostics: useReferenceImages is false and masterImagesSentCount is 0 when calling Veo', async () => {
    const session = {
      type: 'vertex_ai' as const,
      projectId: 'test-project',
      location: 'us-central1',
      requestedModel: 'veo-3.1-fast-generate-001',
      actualModel: 'veo-3.1-fast-generate-001',
      analysisModel: 'gemini-2.5-flash',
      imageModel: 'gemini-3.1-flash-image',
      videoModel: 'veo-3.1-fast-generate-001',
    };

    vi.spyOn(VertexClient, 'predictLongRunning').mockResolvedValueOnce({
      operationName: 'projects/123/locations/us-central1/operations/op_456',
      endpoint: 'us-central1-aiplatform.googleapis.com',
    });

    const validMp4Buf = Buffer.alloc(2048, 0);
    validMp4Buf.write('ftypmp42', 4);

    const result = await VideoGenerator.startVideoGeneration(
      {} as any,
      session as any,
      'veo-3.1-fast-generate-001',
      validMp4Buf,
      'image/jpeg',
      [mockMasterBuffer],
      ['image/jpeg'],
      'Natural subtle breathing',
      { lockedTraits: [] },
      undefined,
      '',
      'animate_existing_character',
      '',
      4,
      'task_diag_test'
    );

    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics?.useReferenceImages).toBe(false);
    expect(result.diagnostics?.masterImagesSentCount).toBe(0);
    expect(result.diagnostics?.fullPrompt).not.toContain('Asian female');
    expect(result.diagnostics?.fullPrompt).not.toContain('young woman');
  });
});
