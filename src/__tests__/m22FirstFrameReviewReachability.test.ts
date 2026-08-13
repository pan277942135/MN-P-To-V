import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityLockService } from '../services/character/identityLockService';
import { VisualQaService } from '../services/qa/visualQaService';
import type { IdentitySpec } from '../types';

const identitySpec: IdentitySpec = { lockedTraits: [] };

const borderlineReport = {
  pass: false,
  identityScore: 88,
  sourcePersonResidualScore: 0,
  scenePreservationScore: 92,
  posePreservationScore: 93,
  outfitPreservationScore: 94,
  anatomyScore: 91,
  faceDetails: 'same character, borderline confidence',
  hairDetails: 'consistent',
  bodyDetails: 'consistent',
  issues: [],
  summary: 'Borderline identity confidence requires review',
} as const;

describe('M2-2 first-frame three-state gate semantics', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps a real borderline QA report to REVIEW rather than FAIL', async () => {
    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValue(borderlineReport as any);

    const result = await IdentityLockService.evaluateIdentityGate({
      ai: {} as any,
      analysisModel: 'gemini-test',
      masterImageBuffer: Buffer.from('master'),
      masterMimeType: 'image/jpeg',
      sceneImageBuffer: Buffer.from('scene'),
      sceneMimeType: 'image/jpeg',
      candidateBuffer: Buffer.from('candidate'),
      candidateMimeType: 'image/jpeg',
      identitySpec,
      sceneMode: 'animate_existing_character',
      manualApproved: false,
    });

    expect(result.status).toBe('review');
    expect(result.requiresManualApproval).toBe(true);
    expect(result.canStartVeo).toBe(false);
  });

  it('allows the same REVIEW result only after explicit manual approval', async () => {
    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValue(borderlineReport as any);

    const result = await IdentityLockService.evaluateIdentityGate({
      ai: {} as any,
      analysisModel: 'gemini-test',
      masterImageBuffer: Buffer.from('master'),
      masterMimeType: 'image/jpeg',
      sceneImageBuffer: Buffer.from('scene'),
      sceneMimeType: 'image/jpeg',
      candidateBuffer: Buffer.from('candidate'),
      candidateMimeType: 'image/jpeg',
      identitySpec,
      sceneMode: 'animate_existing_character',
      manualApproved: true,
    });

    expect(result.status).toBe('review');
    expect(result.canStartVeo).toBe(true);
  });

  it('keeps severe identity loss as FAIL', async () => {
    vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValue({
      ...borderlineReport,
      identityScore: 70,
      summary: 'severe identity loss',
    } as any);

    const result = await IdentityLockService.evaluateIdentityGate({
      ai: {} as any,
      analysisModel: 'gemini-test',
      masterImageBuffer: Buffer.from('master'),
      sceneImageBuffer: Buffer.from('scene'),
      sceneMimeType: 'image/jpeg',
      candidateBuffer: Buffer.from('candidate'),
      candidateMimeType: 'image/jpeg',
      identitySpec,
      sceneMode: 'animate_existing_character',
      manualApproved: true,
    });

    expect(result.status).toBe('fail');
    expect(result.canStartVeo).toBe(false);
  });
});
