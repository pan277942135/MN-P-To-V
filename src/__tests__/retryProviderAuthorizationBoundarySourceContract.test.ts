import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const server = readFileSync('server.ts', 'utf8');
const state = readFileSync('src/server/services/taskStateMachineService.ts', 'utf8');
const retry = readFileSync('src/server/services/durableVideoRetryService.ts', 'utf8');
const types = readFileSync('src/types/index.ts', 'utf8');

describe('automatic retry Provider authorization source contract', () => {
  it('models reserved and authorized as distinct durable retry states', () => {
    expect(types).toContain("'reserved' | 'authorized' | 'submitted'");
    expect(types).toContain('retryProviderAuthorizedAt?: number | null');
    expect(types).toContain('retryProviderAuthorizedIdempotencyKey?: string | null');
    expect(state).toContain('authorizeAutomaticProviderRetry');
    expect(state).toContain("retrySubmissionState: 'authorized'");
  });

  it('finishes fallible preparation before authorization and Provider launch', () => {
    const prepareIndex = server.indexOf('DurableVideoRetryService.prepare({');
    const authorizeIndex = server.indexOf('authorizeAutomaticProviderRetry({');
    const launchIndex = server.indexOf('DurableVideoRetryService.launch({');
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(authorizeIndex).toBeGreaterThan(prepareIndex);
    expect(launchIndex).toBeGreaterThan(authorizeIndex);

    const prepareMethod = retry.indexOf('static async prepare');
    const launchMethod = retry.indexOf('static async launch');
    const providerCall = retry.indexOf('VideoGenerator.startVideoGeneration', launchMethod);
    expect(prepareMethod).toBeGreaterThan(-1);
    expect(retry.indexOf('fetchArtifactBuffer', prepareMethod)).toBeLessThan(launchMethod);
    expect(launchMethod).toBeGreaterThan(prepareMethod);
    expect(providerCall).toBeGreaterThan(launchMethod);
    expect(retry.slice(launchMethod, providerCall)).not.toContain('fetchArtifactBuffer');
    expect(retry).toContain('M2_4_RETRY_PROVIDER_NOT_AUTHORIZED');
  });

  it('never turns an evidence-free reserved retry into unknown', () => {
    expect(state).toContain('M2_4_RETRY_OUTCOME_UNKNOWN_BEFORE_AUTHORIZATION');
    expect(state).toContain("failureReason: 'pre_provider_retry_abandoned'");
    expect(server).toContain('reconcileStaleAutomaticRetryReservation');
    expect(server).toContain('AUTOMATIC_RETRY_AUTHORIZATION_STALE');
  });

  it('never downgrades durable authorization evidence to safe-to-regenerate failure', () => {
    expect(state).toContain("currentTask.retrySubmissionState === 'authorized'");
    expect(state).toContain('currentTask.retryProviderAuthorizedAt');
    expect(state).toContain('return { taskPatch: undefined, result: currentTask }');
  });
});
