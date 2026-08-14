import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityLockService } from '../services/character/identityLockService';
import { VisualQaService } from '../services/qa/visualQaService';

const scene = Buffer.from('same_direct_scene_candidate');
const masters = [Buffer.from('master_front'), Buffer.from('master_three_quarter'), Buffer.from('master_full')];
const identitySpec = {
  lockedTraits: [
    { traitName: 'faceIdentity', expectedValue: 'target character', sourceText: 'identity pack' },
  ],
};

const report = (identityScore: number) => ({
  pass: false,
  identityScore,
  sourcePersonResidualScore: 0,
  scenePreservationScore: 42,
  posePreservationScore: 53,
  outfitPreservationScore: 61,
  anatomyScore: 96,
  faceDetails: 'identity evaluated from masters',
  hairDetails: 'consistent',
  bodyDetails: 'unchanged',
  issues: [],
  summary: 'model under-scored preservation even though direct candidate equals scene',
});

describe('M2-1 DIRECT_CHARACTER_IMAGE false-negative hardening', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('does not let stochastic scene/pose/outfit scores hard-fail a byte-identical direct first frame', async () => {
    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce(report(96));

    const gate = await IdentityLockService.evaluateIdentityGate({
      ai: {} as any,
      masterImageBuffer: masters[0],
      masterMimeType: 'image/jpeg',
      masterImageBuffers: masters,
      masterMimeTypes: masters.map(() => 'image/jpeg'),
      sceneImageBuffer: scene,
      sceneMimeType: 'image/jpeg',
      candidateBuffer: scene,
      candidateMimeType: 'image/jpeg',
      identitySpec,
      sceneMode: 'animate_existing_character',
      imageIsTargetCharacter: true,
    });

    expect(gate.status).toBe('pass');
    expect(gate.canStartVeo).toBe(true);
    expect(gate.identityQaReport.scenePreservationScore).toBe(100);
    expect(gate.identityQaReport.posePreservationScore).toBe(100);
    expect(gate.identityQaReport.outfitPreservationScore).toBe(100);
    expect(gate.identityQaReport.pass).toBe(true);
  });

  it('keeps the existing identity thresholds: 80-94 is REVIEW, not a relaxed PASS', async () => {
    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce(report(85));

    const gate = await IdentityLockService.evaluateIdentityGate({
      ai: {} as any,
      masterImageBuffer: masters[0],
      masterMimeType: 'image/jpeg',
      masterImageBuffers: masters,
      masterMimeTypes: masters.map(() => 'image/jpeg'),
      sceneImageBuffer: scene,
      sceneMimeType: 'image/jpeg',
      candidateBuffer: scene,
      candidateMimeType: 'image/jpeg',
      identitySpec,
      sceneMode: 'animate_existing_character',
      imageIsTargetCharacter: true,
    });

    expect(gate.status).toBe('review');
    expect(gate.canStartVeo).toBe(false);
    expect(gate.identityQaScore).toBe(85);
  });

  it('sends the full identity pack to the visual QA model instead of only master[0]', async () => {
    const generateContent = vi.fn().mockResolvedValueOnce({
      text: JSON.stringify({
        identityScore: 97,
        sourcePersonResidualScore: 0,
        scenePreservationScore: 99,
        posePreservationScore: 99,
        outfitPreservationScore: 99,
        anatomyScore: 99,
        faceDetails: 'multi-reference match',
        hairDetails: 'consistent',
        bodyDetails: 'consistent',
        issues: [],
        summary: 'pass',
      }),
    });

    await VisualQaService.qaFirstFrame(
      { models: { generateContent } } as any,
      'gemini-test',
      masters,
      masters.map(() => 'image/jpeg'),
      scene,
      'image/jpeg',
      scene,
      'image/jpeg',
      identitySpec,
      'animate_existing_character'
    );

    const call = generateContent.mock.calls[0][0];
    const parts = call.contents[0].parts as any[];
    const inlineImages = parts.filter((part) => part.inlineData);
    const masterLabels = parts.filter((part) => typeof part.text === 'string' && part.text.includes('MASTER_REFERENCE_'));

    expect(inlineImages).toHaveLength(masters.length + 2); // masters + scene + candidate
    expect(masterLabels).toHaveLength(masters.length);
  });
});
