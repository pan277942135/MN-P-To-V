import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const server = readFileSync('server.ts', 'utf8');
const state = readFileSync('src/server/services/taskStateMachineService.ts', 'utf8');
const types = readFileSync('src/types/index.ts', 'utf8');

describe('pre-provider durability boundary source contract', () => {
  it('atomically creates the initial task/admission with a preallocated lease in preparing state', () => {
    expect(server).toContain("status: 'preparing'");
    expect(server).toContain('const initialExecutionId = `exec_${crypto.randomUUID()}`');
    expect(server).toContain('executionId: initialExecutionId');
    expect(server).toContain('leaseExpiresAt: initialLeaseExpiresAt');
    expect(server).not.toContain('const leaseResult = await taskStateMachineService.acquireLease({');
  });

  it('authorizes durably before the first provider invocation', () => {
    const authIndex = server.indexOf('taskStateMachineService.authorizeProviderSubmission({');
    const providerIndex = server.indexOf('VideoGenerator.startVideoGeneration(');
    expect(authIndex).toBeGreaterThan(-1);
    expect(providerIndex).toBeGreaterThan(authIndex);
    expect(state).toContain("currentTask.status !== 'preparing'");
    expect(state).toContain("status: 'submitting'");
    expect(state).toContain('providerSubmissionAuthorizedAt: now');
    expect(types).toContain('providerSubmissionAuthorizedAt?: number');
  });

  it('keeps submitting ambiguity fail-closed while safely reclaiming only stale preparing work', () => {
    expect(server).toContain("const isStuckWithoutOpName = rec.status === 'submitting'");
    expect(server).toContain('reconcileStalePreparingTask');
    expect(state).toContain("failureReason: 'pre_provider_abandoned'");
    expect(state).toContain("retryMode: 'SAFE_TO_REGENERATE'");
    expect(server).toContain("submissionState: 'reserved'");
    expect(server).toContain('providerInvocationAuthorized: false');
  });
});
