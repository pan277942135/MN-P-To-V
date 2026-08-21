import { describe, expect, it } from 'vitest';
import { normalizeProviderFailureReason } from '../mvp/mvpContract';

describe('MVP network/deadline hardening', () => {
  it('normalizes the observed nested Vertex Deadline exceeded error to GENERATION_TIMEOUT', () => {
    const error = normalizeProviderFailureReason({
      failureReason: 'upstream_failed',
      httpStatus: 1,
      providerStatus: null,
      message: JSON.stringify({
        code: 1,
        message: JSON.stringify({
          code: 1,
          message: 'Deadline exceeded. Please try again later. Operation ID: ebd9595e-0729-4991-bb6e-486f8a74d91e.',
        }),
      }),
    });

    expect(error.code).toBe('GENERATION_TIMEOUT');
    expect(error.stage).toBe('generation');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('Deadline exceeded. Please try again later. Operation ID: ebd9595e-0729-4991-bb6e-486f8a74d91e.');
    expect(error.providerStatus).toBe('DEADLINE_EXCEEDED');
    expect(error.providerCode).toBe(1);
    expect(error.providerHttpStatus).toBeNull();
    expect(error.recommendedAction).toContain('重新生成');
    expect(error.recommendedAction).toContain('不要继续轮询旧 Operation');
  });

  it('keeps real HTTP 429 as HTTP status rather than provider code', () => {
    const error = normalizeProviderFailureReason({
      failureReason: 'quota_or_rate_limited',
      httpStatus: 429,
      providerStatus: 'RESOURCE_EXHAUSTED',
      message: 'Quota exhausted',
    });
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.providerHttpStatus).toBe(429);
    expect(error.providerCode).toBeNull();
  });

  it('does not misclassify a generic definitive provider failure as timeout', () => {
    const error = normalizeProviderFailureReason({
      failureReason: 'upstream_failed',
      httpStatus: 13,
      message: 'Internal generation failure',
    });
    expect(error.code).toBe('GENERATION_FAILED');
    expect(error.providerCode).toBe(13);
    expect(error.providerHttpStatus).toBeNull();
  });

  it('preserves the terminal Vertex code=8 RCA payload without confusing it with HTTP 8', () => {
    const rawError = {
      code: 8,
      message: 'Service currently has high load. Please try again later.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.DebugInfo', detail: 'capacity-admission' }],
    };
    const error = normalizeProviderFailureReason({
      failureReason: 'upstream_failed',
      httpStatus: null,
      rawStatus: rawError.code,
      providerStatus: null,
      message: rawError.message,
      provider: 'vertex',
      model: 'veo-3.1-fast-generate-001',
      projectId: 'xp-vertex-project',
      region: 'asia-south1',
      requestId: 'req-vertex-8',
      rawMessage: rawError.message,
      rawErrorDetails: rawError,
    });

    expect(error.code).toBe('GENERATION_FAILED');
    expect(error.stage).toBe('generation');
    expect(error.retryable).toBe(true);
    expect(error.providerHttpStatus).toBeNull();
    expect(error.providerCode).toBe(8);
    expect(error.provider).toBe('vertex');
    expect(error.model).toBe('veo-3.1-fast-generate-001');
    expect(error.projectId).toBe('xp-vertex-project');
    expect(error.region).toBe('asia-south1');
    expect(error.requestId).toBe('req-vertex-8');
    expect(error.rawStatus).toBe(8);
    expect(error.rawMessage).toContain('high load');
    expect(error.rawErrorDetails).toEqual(rawError);
  });
});
