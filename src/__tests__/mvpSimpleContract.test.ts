import { describe, expect, it } from 'vitest';
import {
  assertArtifactOnlyCompletion,
  isArtifactOnlyCompletionSatisfied,
  normalizeProviderFailureReason,
} from '../mvp/mvpContract';

describe('MVP_SIMPLE artifact-only contract', () => {
  const validArtifact = {
    artifactPersisted: true,
    artifactVerified: true,
    outputBucket: 'bucket',
    outputObjectPath: 'veo/task/video.mp4',
    videoUri: 'gs://bucket/veo/task/video.mp4',
    sizeBytes: 1024,
    contentType: 'video/mp4',
  };

  it('allows completion only when a verified persisted video artifact exists', () => {
    expect(isArtifactOnlyCompletionSatisfied(validArtifact)).toBe(true);
    expect(() => assertArtifactOnlyCompletion(validArtifact)).not.toThrow();
  });

  it('rejects false-success when provider is done but no real artifact exists', () => {
    expect(isArtifactOnlyCompletionSatisfied({
      ...validArtifact,
      artifactPersisted: false,
      artifactVerified: false,
      sizeBytes: 0,
    })).toBe(false);

    expect(() => assertArtifactOnlyCompletion({
      ...validArtifact,
      outputObjectPath: '',
    })).toThrow('MVP_ARTIFACT_COMPLETION_INVARIANT');
  });

  it('maps safety filtering to an explicit non-retryable input-change failure', () => {
    const err = normalizeProviderFailureReason({
      failureReason: 'output_rai_filtered',
      message: 'RAI_MEDIA_FILTERED',
    });
    expect(err.code).toBe('SAFETY_REJECTED');
    expect(err.stage).toBe('generation');
    expect(err.retryable).toBe(false);
  });

  it('maps provider done-without-video to OUTPUT_MISSING', () => {
    const err = normalizeProviderFailureReason({
      failureReason: 'upstream_empty_response',
      message: 'done but no video',
    });
    expect(err.code).toBe('OUTPUT_MISSING');
    expect(err.stage).toBe('output_fetch');
  });

  it('keeps rate limiting distinct from generation failure', () => {
    const err = normalizeProviderFailureReason({
      failureReason: 'quota_or_rate_limited',
      message: 'Rate exceeded.',
      httpStatus: 429,
      providerStatus: 'RESOURCE_EXHAUSTED',
    });
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(true);
  });
});
