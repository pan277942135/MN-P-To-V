import type { GoogleGenAI } from '@google/genai';
import {
  KEYFRAME_QA_VERSION,
  type KeyframeQaResult,
  type KeyframeRetryAction,
  type ShotSpec,
} from '../../domain/episode/episodeTypes';
import { IdentityLockService } from '../../services/character/identityLockService';
import { firestoreEpisodeRepository } from '../repositories/firestoreEpisodeRepository';
import { firestoreShotRepository } from '../repositories/firestoreShotRepository';
import { durableCharacterService } from './durableCharacterService';
import { gcsArtifactStore } from '../storage/gcsArtifactStore';

const MAX_KEYFRAME_GENERATION_ATTEMPTS = 2;

export interface RunKeyframeQaInput {
  episodeId: string;
  shotId: string;
  ai: GoogleGenAI;
  analysisModel?: string;
}

export interface RunKeyframeQaResult {
  shot: ShotSpec;
  qa: KeyframeQaResult;
}

function failureCodeFromGate(report: {
  identityScore: number;
  anatomyScore: number;
  issues?: Array<{ code: string; severity: string }>;
}): string {
  const critical = (report.issues || []).find((issue) => issue.severity === 'critical');
  if (critical?.code) return critical.code;
  if (report.identityScore < 80) return 'KEYFRAME_IDENTITY_CRITICAL';
  if (report.identityScore < 95) return 'KEYFRAME_IDENTITY_BELOW_THRESHOLD';
  if (report.anatomyScore < 80) return 'KEYFRAME_ANATOMY_CRITICAL';
  if (report.anatomyScore < 90) return 'KEYFRAME_ANATOMY_BELOW_THRESHOLD';
  return 'KEYFRAME_QA_REVIEW_REQUIRED';
}

function repairInstructionFromIssues(issues: Array<{ repairInstruction?: string }>): string | undefined {
  const instructions = issues
    .map((issue) => String(issue.repairInstruction || '').trim())
    .filter(Boolean);
  return instructions.length > 0 ? instructions.slice(0, 3).join('；') : undefined;
}

function retryDecision(params: {
  gate: 'PASS' | 'REVIEW' | 'FAIL';
  provider: ShotSpec['keyframe']['provider'];
  generationAttempt: number;
  currentVersion: number;
}): {
  retryAction: KeyframeRetryAction;
  automaticRetryEligible: boolean;
  nextVersion?: number;
} {
  if (params.gate === 'PASS') {
    return { retryAction: 'CONTINUE_VIDEO', automaticRetryEligible: false };
  }
  if (params.gate === 'REVIEW') {
    return { retryAction: 'HUMAN_REVIEW', automaticRetryEligible: false };
  }
  if (params.generationAttempt >= MAX_KEYFRAME_GENERATION_ATTEMPTS) {
    return { retryAction: 'HUMAN_REVIEW', automaticRetryEligible: false };
  }
  if (params.provider === 'GEMINI_GENERATED') {
    return {
      retryAction: 'REGENERATE_KEYFRAME',
      automaticRetryEligible: true,
      nextVersion: params.currentVersion + 1,
    };
  }
  if (params.provider === 'CHATGPT_UPLOAD') {
    return {
      retryAction: 'REQUEST_NEW_KEYFRAME',
      automaticRetryEligible: false,
      nextVersion: params.currentVersion + 1,
    };
  }
  return { retryAction: 'HUMAN_REVIEW', automaticRetryEligible: false };
}

export class KeyframeQaService {
  static readonly VERSION = KEYFRAME_QA_VERSION;

  public static async run(input: RunKeyframeQaInput): Promise<RunKeyframeQaResult> {
    const [episode, shot] = await Promise.all([
      firestoreEpisodeRepository.getEpisode(input.episodeId),
      firestoreShotRepository.getShot(input.episodeId, input.shotId),
    ]);
    if (!episode) throw new Error('KEYFRAME_QA_EPISODE_NOT_FOUND');
    if (!shot) throw new Error('KEYFRAME_QA_SHOT_NOT_FOUND');
    if (shot.status !== 'KEYFRAME_QA' || shot.keyframe.status !== 'QA_PENDING') {
      throw new Error(`KEYFRAME_QA_STATE_INVALID: shot=${shot.status}, keyframe=${shot.keyframe.status}`);
    }
    if (!shot.keyframe.assetId || !shot.keyframe.outputBucket || !shot.keyframe.outputObjectPath || !shot.keyframe.mimeType) {
      throw new Error('KEYFRAME_QA_ASSET_INCOMPLETE');
    }

    const character = await durableCharacterService.getHydrated(episode.characterId);
    if (!character) throw new Error('KEYFRAME_QA_CHARACTER_NOT_FOUND');

    const snapshotIds = new Set(episode.characterSnapshot.referenceImageIds || []);
    const masterImages = snapshotIds.size > 0
      ? character.referenceImages.filter((reference) => snapshotIds.has(reference.id))
      : character.referenceImages;
    if (masterImages.length === 0) throw new Error('KEYFRAME_QA_CHARACTER_SNAPSHOT_MISSING');
    if (snapshotIds.size > 0 && masterImages.length !== snapshotIds.size) {
      throw new Error('KEYFRAME_QA_CHARACTER_SNAPSHOT_INCOMPLETE');
    }

    const candidateBuffer = await gcsArtifactStore.fetchArtifactBuffer(
      shot.keyframe.outputBucket,
      shot.keyframe.outputObjectPath
    );
    if (!candidateBuffer?.length) throw new Error('KEYFRAME_QA_ASSET_FETCH_FAILED');

    // A persisted keyframe is already the final visual frame. For Episode V0 we use it
    // as both scene and candidate so the existing Identity Gate evaluates identity and
    // anatomy without inventing a missing pre-keyframe scene reference. Shot/prompt
    // compliance remains an Episode-planning concern and can be added as a separate gate.
    const gate = await IdentityLockService.evaluateIdentityGate({
      ai: input.ai,
      analysisModel: input.analysisModel || 'gemini-3.6-flash',
      masterImageBuffers: masterImages.map((reference) => reference.buffer),
      masterMimeTypes: masterImages.map((reference) => reference.mimeType),
      sceneImageBuffer: candidateBuffer,
      sceneMimeType: shot.keyframe.mimeType,
      candidateBuffer,
      candidateMimeType: shot.keyframe.mimeType,
      identitySpec: character.identitySpec,
      sceneMode: 'animate_existing_character',
      imageIsTargetCharacter: true,
      manualApproved: false,
    });

    const qaGate = gate.status === 'pass' ? 'PASS' : gate.status === 'review' ? 'REVIEW' : 'FAIL';
    const decision = retryDecision({
      gate: qaGate,
      provider: shot.keyframe.provider,
      generationAttempt: shot.keyframe.generationAttempt,
      currentVersion: shot.keyframe.version,
    });
    const issues = (gate.identityQaReport.issues || []).map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      description: issue.description,
      repairInstruction: issue.repairInstruction,
    }));
    const qa: KeyframeQaResult = {
      version: KEYFRAME_QA_VERSION,
      gate: qaGate,
      ...(qaGate === 'PASS' ? {} : { failureCode: failureCodeFromGate(gate.identityQaReport) }),
      identityScore: gate.identityQaReport.identityScore,
      scenePreservationScore: gate.identityQaReport.scenePreservationScore,
      posePreservationScore: gate.identityQaReport.posePreservationScore,
      outfitPreservationScore: gate.identityQaReport.outfitPreservationScore,
      anatomyScore: gate.identityQaReport.anatomyScore,
      issues,
      summary: gate.identityQaReport.summary,
      ...(qaGate === 'PASS' ? {} : { repairInstruction: repairInstructionFromIssues(issues) }),
      ...decision,
      evaluatedAt: Date.now(),
    };

    const updated = await firestoreShotRepository.applyKeyframeQaResult({
      episodeId: input.episodeId,
      shotId: input.shotId,
      expectedAssetId: shot.keyframe.assetId,
      expectedVersion: shot.keyframe.version,
      qa,
    });
    return { shot: updated, qa };
  }
}
