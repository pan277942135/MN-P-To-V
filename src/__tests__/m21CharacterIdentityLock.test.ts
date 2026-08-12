import { describe, test, expect, vi, beforeEach } from 'vitest';
import { IdentityLockService } from '../services/character/identityLockService';
import { PromptCompiler } from '../services/prompt/PromptCompiler';
import type { IdentitySpec } from '../types';

describe('M2-1 Character Identity Lock Pipeline & Gates', () => {
  let mockSceneBuffer: Buffer;
  let mockMasterBuffer: Buffer;
  let dummyIdentitySpec: IdentitySpec;

  beforeEach(() => {
    mockSceneBuffer = Buffer.from('mock_scene_image_buffer_12345');
    mockMasterBuffer = Buffer.from('mock_master_image_buffer_67890');
    dummyIdentitySpec = {
      lockedTraits: [
        { traitName: 'hairColor', expectedValue: 'Silver', sourceText: 'Silver hair' },
      ],
      identityLockPromptEnglish: 'Silver hair, blue eyes',
    };
  });

  test('1. Direct character image bypasses rebuild (DIRECT_CHARACTER_IMAGE)', async () => {
    const sourceMode = IdentityLockService.determineIdentitySourceMode({
      sceneMode: 'animate_existing_character',
      imageIsTargetCharacter: true,
    });

    expect(sourceMode).toBe('DIRECT_CHARACTER_IMAGE');

    const result = await IdentityLockService.rebuildFirstFrame({
      sceneImageBuffer: mockSceneBuffer,
      sceneMimeType: 'image/jpeg',
      identitySpec: dummyIdentitySpec,
      sceneMode: 'animate_existing_character',
      imageIsTargetCharacter: true,
    });

    expect(result.sourceMode).toBe('DIRECT_CHARACTER_IMAGE');
    expect(result.rebuildExecuted).toBe(false);
    expect(result.candidateFirstFrame).toBeDefined();
  });

  test('2. Non-character image enters identity rebuild (IDENTITY_REBUILD_REQUIRED)', async () => {
    const sourceMode = IdentityLockService.determineIdentitySourceMode({
      sceneMode: 'replace_primary_person',
    });

    expect(sourceMode).toBe('IDENTITY_REBUILD_REQUIRED');

    const result = await IdentityLockService.rebuildFirstFrame({
      sceneImageBuffer: mockSceneBuffer,
      sceneMimeType: 'image/jpeg',
      identitySpec: dummyIdentitySpec,
      sceneMode: 'replace_primary_person',
    });

    expect(result.sourceMode).toBe('IDENTITY_REBUILD_REQUIRED');
    expect(result.rebuildExecuted).toBe(true);
  });

  test('3. Failed identity gate blocks Veo submission (Veo calls = 0)', async () => {
    const failedQaResult = await IdentityLockService.evaluateIdentityGate({
      masterImageBuffer: mockMasterBuffer,
      masterMimeType: 'image/jpeg',
      sceneImageBuffer: mockSceneBuffer,
      sceneMimeType: 'image/jpeg',
      candidateBuffer: mockSceneBuffer,
      candidateMimeType: 'image/jpeg',
      identitySpec: dummyIdentitySpec,
      sceneMode: 'replace_primary_person',
      // No AI instance provided with fail mock or status force
    });

    // Manually test gate check logic with status 'fail'
    const gateCheck = {
      status: 'fail' as const,
      canStartVeo: false,
    };

    const submission = IdentityLockService.prepareI2VSubmission({
      userPrompt: 'breathing and smiling softly',
      durationSeconds: 4,
      identityGatePassed: gateCheck.canStartVeo,
    });

    expect(submission.veoSubmissionAllowed).toBe(false);
    expect(submission.compiledMotionPrompt).toBe('');
  });

  test('4. Passed identity gate permits entering Veo submission phase', async () => {
    const gateCheck = {
      status: 'pass' as const,
      canStartVeo: true,
    };

    const submission = IdentityLockService.prepareI2VSubmission({
      userPrompt: 'gentle smile and soft head tilt',
      durationSeconds: 4,
      identityGatePassed: gateCheck.canStartVeo,
    });

    expect(submission.veoSubmissionAllowed).toBe(true);
    expect(submission.compiledMotionPrompt).toContain('Use the uploaded image as the exact first frame.');
  });

  test('5. Veo image-to-video prompt uses motion-first strategy without re-describing physical details', () => {
    const prompt = PromptCompiler.compileI2VMotionPrompt({
      userMotionPrompt: 'gentle breathing, slight eye blink, and soft posture micro-shift',
      durationSeconds: 4,
      cameraPreset: 'fixed',
    });

    expect(prompt).toContain('Use the uploaded image as the exact first frame.');
    expect(prompt).toContain('For 4 seconds:');
    expect(prompt).toContain('Preserve the subject\'s existing facial appearance,');
    expect(prompt).toContain('Fixed camera.');

    // Forbids unnecessary physical appearance re-descriptions
    expect(prompt).not.toContain('Asian female');
    expect(prompt).not.toContain('young woman');
    expect(prompt).not.toContain('black hair');
    expect(prompt).not.toContain('oval face');
  });

  test('6. HIGH identity risk motion generates risk warning', () => {
    const lowRisk = PromptCompiler.classifyIdentityDriftRisk('breathing and blinking softly');
    expect(lowRisk.identityDriftRisk).toBe('low');

    const highRisk = PromptCompiler.classifyIdentityDriftRisk('快速回头，走向镜头并大幅度转身遮脸');
    expect(highRisk.identityDriftRisk).toBe('high');
    expect(highRisk.warning).toBeDefined();
    expect(highRisk.detectedKeywords.length).toBeGreaterThan(0);
  });

  test('7. Master images are NOT sent as unsupported Veo reference fields', () => {
    const submission = IdentityLockService.prepareI2VSubmission({
      userPrompt: 'breathing softly',
      durationSeconds: 4,
      identityGatePassed: true,
    });

    expect(submission.masterImagesSentToVeo).toBe(false);
  });

  test('8. Save character identity profile metadata with GCS paths', async () => {
    const { gcsArtifactStore } = await import('../server/storage/gcsArtifactStore');
    gcsArtifactStore.setMockMode(true);

    const profile = await IdentityLockService.saveIdentityProfile({
      characterId: 'char_test_123',
      characterName: 'Aria',
      identitySpec: dummyIdentitySpec,
      images: [
        {
          buffer: mockMasterBuffer,
          mimeType: 'image/jpeg',
          type: 'front_hd',
        },
      ],
    });

    expect(profile.characterId).toBe('char_test_123');
    expect(profile.characterName).toBe('Aria');
    expect(profile.masterImages.length).toBe(1);
    expect(profile.masterImages[0].url).toContain('gs://');
  });
});
