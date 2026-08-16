import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const server = readFileSync('server.ts', 'utf8');
const gcs = readFileSync('src/server/storage/gcsArtifactStore.ts', 'utf8');
const state = readFileSync('src/server/services/taskStateMachineService.ts', 'utf8');
const card = readFileSync('src/components/ProviderOperationRecoveryCard.tsx', 'utf8');

describe('GCS unknown recovery source contract', () => {
  it('discovers only existing task-prefix MP4 evidence', () => {
    expect(gcs).toContain('discoverTaskPrefixVideo');
    expect(gcs).toContain('getFiles({ prefix })');
    expect(gcs).toContain("objectPath.includes('/qa/')");
    expect(gcs).toContain('VideoGenerator.isMp4Valid(buffer)');
    expect(gcs).toContain("status: 'ambiguous'");
  });

  it('permits unknown to advance only after generation evidence is proven', () => {
    expect(state).toContain("submission_outcome_unknown: ['polling', 'generation_succeeded'");
    expect(state).toContain("if (task.status === 'submission_outcome_unknown')");
    expect(state).toContain("advance('generation_succeeded'");
  });

  it('uses current providerAttempt prefix and never generates during GCS recovery', () => {
    expect(server).toContain('DurableVideoRetryService.getAttemptTaskKey(taskId, providerAttempt)');
    expect(server).toContain('discoverTaskPrefixVideo');
    expect(server).toContain("recoveredBy: 'task_gcs_prefix'");
    expect(server).toContain("failureReason: 'task_gcs_artifact_ambiguous'");
    expect(server).toContain("failureReason: 'task_gcs_artifact_not_found'");
    expect(server).toContain('predictLongRunningCalls: 0');
  });

  it('exposes GCS-first recovery before manual Operation Name fallback', () => {
    expect(card).toContain('/api/videos/recover/');
    expect(card).toContain('自动检查并找回原视频');
    expect(card).toContain("fetch('/api/videos/recover-task'");
    expect(card).not.toContain('/api/videos/start');
    expect(card).not.toContain('predictLongRunning');
  });
});
