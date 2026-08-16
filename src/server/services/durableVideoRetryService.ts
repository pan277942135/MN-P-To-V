import type { GoogleGenAI } from '@google/genai';
import type { ActiveSession } from '../../services/google/credentialService';
import { VideoGenerator, type VideoStartResult } from '../../services/video/videoGenerator';
import type { ServerVideoTaskRecord } from '../../types';
import type { VideoRetryDecision } from '../../services/qa/videoRetryPolicyService';
import { gcsArtifactStore, resolveVeoStorageUri } from '../storage/gcsArtifactStore';

export class DurableVideoRetryService {
  static getAttemptTaskKey(taskId: string, providerAttempt: number): string {
    return providerAttempt <= 1 ? taskId : `${taskId}/attempts/${providerAttempt}`;
  }

  static async launch(params: {
    task: ServerVideoTaskRecord;
    decision: VideoRetryDecision;
    session: ActiveSession;
    ai: GoogleGenAI;
  }): Promise<VideoStartResult> {
    const { task, decision, session, ai } = params;

    if (decision.action !== 'REGENERATE_VIDEO' || !decision.idempotencyKey) {
      throw new Error('M2_4_RETRY_POLICY_VIOLATION: provider launch requires REGENERATE_VIDEO decision and idempotency key');
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

    const attemptTaskKey = this.getAttemptTaskKey(task.taskId, decision.nextProviderAttempt);
    const derivedStorageUri = resolveVeoStorageUri(attemptTaskKey);
    if (task.providerStorageTaskKey !== attemptTaskKey || task.expectedProviderStorageUri !== derivedStorageUri) {
      throw new Error(
        `M2_4_RETRY_STORAGE_INTENT_MISMATCH: durable storage intent does not match provider attempt ${decision.nextProviderAttempt}`
      );
    }

    return await VideoGenerator.startVideoGeneration(
      ai,
      session,
      task.modelId || session.videoModel || 'veo-3.1-fast-generate-001',
      firstFrame,
      task.qaApprovedFirstFrameMimeType || 'image/jpeg',
      masterImages,
      task.qaMasterImageMimeTypes || [],
      prompt,
      task.identitySpec,
      undefined,
      decision.repairPromptAppend,
      task.sceneMode,
      task.characterDescription,
      task.durationSeconds || 6,
      attemptTaskKey,
      task.expectedProviderStorageUri
    );
  }
}
