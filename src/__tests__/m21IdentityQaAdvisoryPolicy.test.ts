import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityLockService } from '../services/character/identityLockService';
import { VisualQaService } from '../services/qa/visualQaService';

const scene = Buffer.from('scene');
const master = Buffer.from('master');
const identitySpec = {
  lockedTraits: [
    { traitName: 'faceIdentity', expectedValue: 'target character', sourceText: 'master' },
  ],
};

describe('M2-1 pre-provider identity QA advisory policy', () => {
  const originalBlocking = process.env.FIRST_FRAME_IDENTITY_QA_BLOCKING;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.FIRST_FRAME_IDENTITY_QA_BLOCKING = 'false';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalBlocking === undefined) {
      delete process.env.FIRST_FRAME_IDENTITY_QA_BLOCKING;
    } else {
      process.env.FIRST_FRAME_IDENTITY_QA_BLOCKING = originalBlocking;
    }
  });

  it('retains FAIL diagnostics but does not block Veo submission', async () => {
    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce({
      pass: false,
      identityScore: 62,
      sourcePersonResidualScore: 0,
      scenePreservationScore: 100,
      posePreservationScore: 100,
      outfitPreservationScore: 100,
      anatomyScore: 95,
      faceDetails: 'model says mismatch',
      hairDetails: 'mismatch',
      bodyDetails: 'preserved',
      summary: 'advisory mismatch',
      issues: [{
        code: 'IDENTITY_MISMATCH',
        severity: 'critical',
        description: 'identity mismatch',
        repairInstruction: 'review only',
      }],
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
      manualApproved: false,
    });

    expect(gate.status).toBe('fail');
    expect(gate.identityQaScore).toBe(62);
    expect(gate.identityCriticalIssues.join(' ')).toContain('IDENTITY_MISMATCH');
    expect(gate.requiresManualApproval).toBe(false);
    expect(gate.canStartVeo).toBe(true);
  });
});
