import { describe, expect, it } from 'vitest';
import { callWithRetry, isRateLimitError } from '../utils/retryHelper';
import { sanitizeError } from '../utils/redactSecrets';

describe('Veo Rate exceeded transport retry regression', () => {
  it('recognizes the exact live UAT message and succeeds after bounded retry', async () => {
    let calls = 0;

    const result = await callWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('Rate exceeded.');
        return 'ok';
      },
      { maxRetries: 2, initialDelayMs: 1, actionName: 'Veo UAT' }
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('preserves rate-limit semantics as HTTP 429 after retry exhaustion', async () => {
    let caught: any = null;

    try {
      await callWithRetry(
        async () => {
          throw new Error('Rate exceeded.');
        },
        { maxRetries: 0, initialDelayMs: 1, actionName: 'Veo UAT' }
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeTruthy();
    expect(caught.httpStatus).toBe(429);
    expect(caught.googleStatus).toBe('RESOURCE_EXHAUSTED');
    expect(caught.failureReason).toBe('quota_or_rate_limited');
    expect(caught.retryMode).toBe('SAFE_TO_REGENERATE');
    expect(caught.message).toContain('429 RESOURCE_EXHAUSTED');
    expect(sanitizeError(caught).redactedMessage).toContain('配额');
  });

  it('recognizes Vertex httpStatus=429 even when the message does not contain 429', async () => {
    let calls = 0;

    const result = await callWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          const err: any = new Error('capacity temporarily unavailable');
          err.httpStatus = 429;
          err.source = 'vertex_submit';
          throw err;
        }
        return 'accepted';
      },
      { maxRetries: 1, initialDelayMs: 1 }
    );

    expect(result).toBe('accepted');
    expect(calls).toBe(2);
  });

  it('recognizes upstreamHttpStatus and googleStatus rate-limit shapes', () => {
    expect(isRateLimitError({ message: 'provider busy', upstreamHttpStatus: 429 })).toBe(true);
    expect(isRateLimitError({ message: 'provider busy', googleStatus: 'RESOURCE_EXHAUSTED' })).toBe(true);
    expect(isRateLimitError(new Error('Too Many Requests'))).toBe(true);
    expect(isRateLimitError(new Error('Quota exceeded for quota metric'))).toBe(true);
  });

  it('never retries a definitive 404', async () => {
    let calls = 0;

    await expect(
      callWithRetry(
        async () => {
          calls += 1;
          const err: any = new Error('model not found');
          err.httpStatus = 404;
          throw err;
        },
        { maxRetries: 3, initialDelayMs: 1 }
      )
    ).rejects.toThrow('model not found');

    expect(calls).toBe(1);
  });
});
