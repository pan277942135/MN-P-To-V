import { describe, expect, it } from 'vitest';
import type { ServerVideoTaskRecord } from '../types';
import {
  buildProviderAdmissionScopeKey,
  isProviderAdmissionBlockingTask,
} from '../server/services/providerAdmissionPolicy';

const task = (status: any, overrides: Partial<ServerVideoTaskRecord> = {}) => ({
  id: `task_${status}`,
  taskId: `task_${status}`,
  status,
  ...overrides,
}) as ServerVideoTaskRecord;

describe('durable provider admission policy', () => {
  it('uses a stable per-project scope across tabs and process instances', () => {
    expect(buildProviderAdmissionScopeKey('xp-vertex-project')).toBe(buildProviderAdmissionScopeKey('XP-VERTEX-PROJECT'));
    expect(buildProviderAdmissionScopeKey('xp-vertex-project')).not.toBe(buildProviderAdmissionScopeKey('another-project'));
  });

  it.each([
    'created',
    'preparing',
    'submitting',
    'submitted',
    'generating',
    'polling',
    'polling_timeout',
    'generation_succeeded',
    'artifact_persisting',
    'artifact_persisted',
    'submission_outcome_unknown',
  ])('blocks a second provider task while incumbent status=%s', (status) => {
    expect(isProviderAdmissionBlockingTask(task(status))).toBe(true);
  });

  it('keeps qa_pending blocked until QA has explicitly become human REVIEW', () => {
    expect(isProviderAdmissionBlockingTask(task('qa_pending', { identityQaStatus: 'not_run' }))).toBe(true);
    expect(isProviderAdmissionBlockingTask(task('qa_pending', { identityQaStatus: 'fail' }))).toBe(true);
    expect(isProviderAdmissionBlockingTask(task('qa_pending', { identityQaStatus: 'pass' }))).toBe(true);
    expect(isProviderAdmissionBlockingTask(task('qa_pending', { identityQaStatus: 'review' }))).toBe(false);
  });

  it.each(['completed', 'failed', 'cancelled', 'canceled', 'artifact_persist_failed'])('releases admission when status=%s', (status) => {
    expect(isProviderAdmissionBlockingTask(task(status))).toBe(false);
  });
});
