import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IdentityLockService } from '../services/character/identityLockService';
import { VisualQaService } from '../services/qa/visualQaService';

const scene = Buffer.from('direct_character_scene');
const master = Buffer.from('character_master_reference');

const identitySpec = {
  lockedTraits: [
    { traitName: 'faceIdentity', expectedValue: 'target character', sourceText: 'target character master' },
  ],
};

describe('M2-1 direct character image identity QA regression', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('DIRECT_CHARACTER_IMAGE skips rebuild but still executes master-based QA', async () => {
    const qaSpy = vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce({
      pass: false,
      identityScore: 62,
      sourcePersonResidualScore: 0,
      scenePreservationScore: 100,
      posePreservationScore: 100,
      outfitPreservationScore: 100,
      anatomyScore: 95,
      faceDetails: 'candidate does not match master identity',
      hairDetails: 'mismatch',
      bodyDetails: 'unchanged',
      issues: [
        {
          code: 'IDENTITY_MISMATCH',
          severity: 'critical',
          description: 'direct image is not the target character',
          repairInstruction: 'use the correct target-character image',
        },
      ],
      summary: 'identity mismatch',
    });

    const gate = await IdentityLockService.evaluateIdentityGate({
      ai: {} as any,
      masterImageBuffer: master,
      masterMimeType: 'image/jpeg',
      sceneImageBuffer: scene,
      sceneMimeType: 'image/jpeg',
      candidateBuffer: scene,
      candidateMimeType: 'image/jpeg',
      identitySpec,
      sceneMode: 'animate_existing_character',
      imageIsTargetCharacter: true,
    });

    expect(qaSpy).toHaveBeenCalledTimes(1);
    expect(gate.status).toBe('fail');
    expect(gate.canStartVeo).toBe(false);
    expect(gate.identityQaScore).toBe(62);
  });

  test('DIRECT_CHARACTER_IMAGE without a master reference fails closed outside test mode', async () => {
    process.env.NODE_ENV = 'production';

    const gate = await IdentityLockService.evaluateIdentityGate({
      sceneImageBuffer: scene,
      sceneMimeType: 'image/jpeg',
      candidateBuffer: scene,
      candidateMimeType: 'image/jpeg',
      identitySpec,
      sceneMode: 'animate_existing_character',
      imageIsTargetCharacter: true,
    });

    expect(gate.status).toBe('fail');
    expect(gate.canStartVeo).toBe(false);
    expect(gate.identityCriticalIssues.join(' ')).toContain('IDENTITY_REFERENCE_MISSING');
  });

  test('animate-existing-character QA evaluates model output instead of returning synthetic perfect 100', async () => {
    const generateContent = vi.fn().mockResolvedValueOnce({
      text: JSON.stringify({
        identityScore: 96,
        sourcePersonResidualScore: 100,
        scenePreservationScore: 99,
        posePreservationScore: 99,
        outfitPreservationScore: 99,
        anatomyScore: 99,
        faceDetails: 'verified against master',
        hairDetails: 'verified against master',
        bodyDetails: 'verified against master',
        issues: [],
        summary: 'real model evaluation path',
      }),
    });

    const report = await VisualQaService.qaFirstFrame(
      { models: { generateContent } } as any,
      'gemini-test',
      master,
      'image/jpeg',
      scene,
      'image/jpeg',
      scene,
      'image/jpeg',
      identitySpec,
      'animate_existing_character'
    );

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(report.identityScore).toBe(96);
    expect(report.summary).toBe('real model evaluation path');
    // Residual source-person score is not a gate for animate_existing_character.
    expect(report.pass).toBe(true);
  });
});
