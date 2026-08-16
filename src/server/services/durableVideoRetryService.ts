import type { GoogleGenAI } from '@google/genai';
import type { ActiveSession } from '../../services/google/credentialService';
import { VideoGenerator, type VideoStartResult } from '../../services/video/videoGenerator';
import type { ServerVideoTaskRecord } from '../../types';
import type { VideoRetryDecision } from '../../services/qa/videoRetryPolicyService';
import { gcsArtifactStore, resolveVeoStorageUri } from '../storage/gcsArtifactStore';

export interface PreparedVideoRetryInput {
  firstFrame: Buffer;
  firstFrameMimeType: string;
  masterImages: Buffer[];
  masterImageMimeTypes: string[];
  prompt: string;
  attemptTaskKey: string;
  expectedStorageUri: string;
}

export class DurableVideoRetryService {
  static getAttemptTaskKey(taskId: string, providerAttempt: number): string {
    return providerAttempt <= 1 ? taskId : `${taskId}/attempts/${providerAttempt}`;
  }

  static async prepare(params: {
    task: ServerVideoTaskRecord;
    decision: VideoRetryDecision;
    session: ActiveSession;
  }): Promise<PreparedVideoRetryInput> {
    const { task, decision, session } = params;

    if (decision.action !== 'REGENERATE_VIDEO' || !decision.idempotencyKey) {
      throw new Error('M2_4_RETRY_POLICY_VIOLATION: provider preparation requires REGENERATE_VIDEO decision and idempotency key');
    }
    if (task.providerRetryIdempotencyKey !== decision.idempotencyKey) {
      throw new Error('M2_4_RETRY_PREPARATION_STALE: retry preparation no longer owns the task');
    }
    if (task.retrySubmissionState !== 'reserved' || task.retryProviderAuthorizedAt || task.retryProviderAuthorizedIdempotencyKey) {
      throw new Error('M2_4_RETRY_PREPARATION_INVALID_STATE: retry preparation must happen before durable Provider authorization');
    }
    if (!task.qaApprovedFirstFrameObjectPath) {
      throw new Error('M2_4_RETRY_INPUT_MISSING: approved first-frame anchor is missing');
    }
    if (!task.qaMasterImageObjectPaths?.length) {
      throw new Error('M2_4_RETRY_INPUT_MISSING: character master anchors are missing');
    }
    if (!task.identitySpec) {
      throw new Error('M2_4_RETRY_INPUT_MISSING: IdentitySpec is missing');
    }

    const bucket = task.outputBucket;
    if (!bucket) {
      throw new Error('M2_4_RETRY_INPUT_MISSING: artifact bucket is missing');
    }

    const attemptTaskKey = this.getAttemptTaskKey(task.taskId, decision.nextProviderAttempt);
    const derivedStorageUri = resolveVeoStorageUri(attemptTaskKey);
    if (task.providerStorageTaskKey !== attemptTaskKey || task.expectedProviderStorageUri !== derivedStorageUri) {
      throw new Error(
        `M2_4_RETRY_STORAGE_INTENT_MISMATCH: durable storage intent does not match provider attempt ${decision.nextProviderAttempt}`
      );
    }

    // All fallible artifact I/O happens while the retry is still only reserved. A failure
    // here is provably pre-Provider and can be safely terminated/retried.
    const firstFrame = await gcsArtifactStore.fetchArtifactBuffer(
      bucket,
      task.qaApprovedFirstFrameObjectPath,
      { session }
    );
    const masterImages = await Promise.all(
      task.qaMasterImageObjectPaths.slice(0, 3).map((objectPath) =>
        gcsArtifactStore.fetchArtifactBuffer(bucket, objectPath, { session })
      )
    );

    const prompt =
      task.veoSafePrompt ||
      task.compiledPrompt ||
      task.rawUserPrompt ||
      'Natural subtle motion while preserving the approved character identity.';

    return {
      firstFrame,
      firstFrameMimeType: task.qaApprovedFirstFrameMimeType || 'image/jpeg',
      masterImages,
      masterImageMimeTypes: task.qaMasterImageMimeTypes || [],
      prompt,
      attemptTaskKey,
      expectedStorageUri: task.expectedProviderStorageUri,
    };
  }

  static async launch(params: {
    task: ServerVideoTaskRecord;
    decision: VideoRetryDecision;
    session: ActiveSession;
    ai: GoogleGenAI;
    prepared: PreparedVideoRetryInput;
  }): Promise<VideoStartResult> {
    const { task, decision, session, ai, prepared } = params;

    if (decision.action !== 'REGENERATE_VIDEO' || !decision.idempotencyKey) {
      throw new Error('M2_4_RETRY_POLICY_VIOLATION: provider launch requires REGENERATE_VIDEO decision and idempotency key');
    }
    if (
      task.retrySubmissionState !== 'authorized' ||
      !task.retryProviderAuthorizedAt ||
      task.retryProviderAuthorizedIdempotencyKey !== decision.idempotencyKey
    ) {
      throw new Error('M2_4_RETRY_PROVIDER_NOT_AUTHORIZED: durable retry Provider authorization is required before launch');
    }

    const attemptTaskKey = this.getAttemptTaskKey(task.taskId, decision.nextProviderAttempt);
    if (
      prepared.attemptTaskKey !== attemptTaskKey ||
      task.providerStorageTaskKey !== attemptTaskKey ||
      prepared.expectedStorageUri !== task.expectedProviderStorageUri ||
      task.expectedProviderStorageUri !== resolveVeoStorageUri(attemptTaskKey)
    ) {
      throw new Error('M2_4_RETRY_PREPARED_INPUT_STALE: prepared retry input no longer matches durable Provider intent');
    }

    // IMPORTANT: after durable authorization there is no artifact/network preparation left.
    // The next asynchronous operation is the Provider generation call itself.
    return await VideoGenerator.startVideoGeneration(
      ai,
      session,
      task.modelId || session.videoModel || 'veo-3.1-fast-generate-001',
      prepared.firstFrame,
      prepared.firstFrameMimeType,
      prepared.masterImages,
      prepared.masterImageMimeTypes,
      prepared.prompt,
      task.identitySpec,
      undefined,
      decision.repairPromptAppend,
      task.sceneMode,
      task.characterDescription,
      task.durationSeconds || 6,
      prepared.attemptTaskKey,
      prepared.expectedStorageUri
    );
  }

}
