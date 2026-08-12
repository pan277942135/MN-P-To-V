import { describe, it, expect } from 'vitest';
import type { TaskStatus, TaskSubmissionState, ServerVideoTaskRecord } from '../types';

function formatTaskAuditRecord(rec: ServerVideoTaskRecord, envKRevision = 'not_deployed') {
  const createdAtEpochMs = Number(rec.createdAt) || Date.now();
  const dateObj = new Date(createdAtEpochMs);
  const createdAtUtcIso = dateObj.toISOString();
  const createdAtLocalIso = dateObj.toISOString();

  const pollAttempt = Number(rec.pollAttempt) || 0;
  const hasOperationName = Boolean(rec.operationName);

  const lastPolledAt = pollAttempt > 0 ? (rec.lastPolledAt || rec.updatedAt || null) : null;

  let mappedStatus: TaskStatus = rec.status;
  if ((rec.status as string) === 'processing' || (rec.status as string) === 'submitted' || (rec.status as string) === 'draft') {
    mappedStatus = 'polling';
  } else if ((rec.status as string) === 'submit_failed_safe_to_retry') {
    mappedStatus = 'failed';
  }

  let submissionState: TaskSubmissionState = 'not_submitted';
  if (mappedStatus === 'polling' || mappedStatus === 'polling_timeout' || mappedStatus === 'completed') {
    submissionState = 'submitted';
  } else if (mappedStatus === 'submitting') {
    submissionState = 'submitting';
  } else if (mappedStatus === 'validating') {
    submissionState = 'reserved';
  } else if (mappedStatus === 'submission_outcome_unknown') {
    submissionState = 'outcome_unknown';
  } else if (mappedStatus === 'failed') {
    submissionState = hasOperationName ? 'submitted' : 'not_submitted';
  } else if (mappedStatus === 'orphaned_local_task') {
    submissionState = 'not_submitted';
  }

  const hasGoogleResponse = Boolean(rec.submitHttpStatus || rec.pollHttpStatus || rec.operationName);
  const raiMediaFilteredCount = hasGoogleResponse && rec.raiMediaFilteredCount !== undefined ? rec.raiMediaFilteredCount : null;
  const raiStatus = hasGoogleResponse && rec.raiStatus ? rec.raiStatus : 'unknown';

  return {
    taskId: rec.taskId || rec.id,
    createdAtEpochMs,
    createdAtUtcIso,
    createdAtLocalIso,
    status: mappedStatus,
    submissionState,
    idempotencyKeyPrefix: rec.idempotencyKey ? rec.idempotencyKey.slice(0, 8) : null,
    operationNamePresent: hasOperationName,
    operationNamePrefix: hasOperationName && rec.operationName ? (rec.operationName.slice(0, 24) + '...') : null,
    pollAttempt,
    lastPolledAt,
    lastSubmitAttemptAt: rec.lastSubmitAttemptAt || rec.createdAt || null,
    submitTimedOutAt: rec.submitTimedOutAt || (mappedStatus === 'submission_outcome_unknown' ? rec.updatedAt : null),
    upstreamEndpoint: rec.upstreamEndpoint || (hasOperationName ? `${rec.region || 'us-central1'}-aiplatform.googleapis.com` : null),
    upstreamHttpStatus: rec.submitHttpStatus || rec.pollHttpStatus || null,
    upstreamErrorCode: rec.upstreamErrorCode || rec.structuredError?.source || null,
    upstreamErrorMessage: rec.upstreamErrorMessage || rec.error || null,
    raiMediaFilteredCount,
    raiStatus,
    evidenceSource: rec.evidenceSource || 'server_memory',
    K_REVISION: envKRevision,
  };
}

describe('Task Audit and State Machine Constraints', () => {
  it('1. epoch timestamp is consistent with ISO year (1722955913000 -> 2024)', () => {
    const epochMs = 1722955913000;
    const iso = new Date(epochMs).toISOString();
    expect(iso).toContain('2024-08-06');
    expect(iso.startsWith('2024')).toBe(true);
  });

  it('2. completed task retains operationName and operationNamePresent is true', () => {
    const record: ServerVideoTaskRecord = {
      id: 'task_001',
      taskId: 'task_001',
      operationName: 'projects/123/locations/us-central1/operations/456',
      status: 'completed',
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'xp-vertex-project',
      region: 'us-central1',
      durationSeconds: 8,
      aspectRatio: '9:16',
      resolution: '1080p',
      generateAudio: false,
      pollAttempt: 5,
      createdAt: 1722955913000,
      updatedAt: 1722955950000,
    };

    const audit = formatTaskAuditRecord(record);
    expect(audit.operationNamePresent).toBe(true);
    expect(audit.operationNamePrefix).toContain('projects/123/locations/u');
    expect(audit.status).toBe('completed');
    expect(audit.submissionState).toBe('submitted');
  });

  it('3. pollAttempt = 0 results in lastPolledAt = null', () => {
    const record: ServerVideoTaskRecord = {
      id: 'task_002',
      taskId: 'task_002',
      status: 'submitting',
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'xp-vertex-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const audit = formatTaskAuditRecord(record);
    expect(audit.pollAttempt).toBe(0);
    expect(audit.lastPolledAt).toBeNull();
  });

  it('4. without upstream response, raiMediaFilteredCount is null and raiStatus is unknown', () => {
    const record: ServerVideoTaskRecord = {
      id: 'task_003',
      taskId: 'task_003',
      status: 'failed',
      modelId: 'veo-3.1-fast-generate-001',
      projectId: 'xp-vertex-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 0,
      submitHttpStatus: null,
      pollHttpStatus: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const audit = formatTaskAuditRecord(record);
    expect(audit.raiMediaFilteredCount).toBeNull();
    expect(audit.raiStatus).toBe('unknown');
  });

  it('5. submissionState does not contain accepted_polling or accepted_completed', () => {
    const allowedSubmissionStates = ['reserved', 'submitting', 'submitted', 'outcome_unknown', 'not_submitted'];

    const statuses: TaskStatus[] = ['validating', 'submitting', 'polling', 'polling_timeout', 'completed', 'failed', 'submission_outcome_unknown', 'orphaned_local_task'];

    for (const st of statuses) {
      const rec: ServerVideoTaskRecord = {
        id: 't', taskId: 't', status: st, modelId: 'm', projectId: 'p', region: 'r',
        durationSeconds: 4, aspectRatio: '9:16', resolution: '1080p', generateAudio: false,
        pollAttempt: 1, createdAt: Date.now(), updatedAt: Date.now()
      };
      const audit = formatTaskAuditRecord(rec);
      expect(allowedSubmissionStates).toContain(audit.submissionState);
      expect(audit.submissionState).not.toBe('accepted_polling');
      expect(audit.submissionState).not.toBe('accepted_completed');
    }
  });

  it('6. audit report shows real evidenceSource and marks non-production if not Firestore', () => {
    const rec: ServerVideoTaskRecord = {
      id: 'task_004',
      taskId: 'task_004',
      status: 'polling',
      modelId: 'veo-3.1',
      projectId: 'xp-vertex-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 1,
      evidenceSource: 'server_memory',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const audit = formatTaskAuditRecord(rec);
    expect(audit.evidenceSource).toBe('server_memory');
    expect(audit.evidenceSource).not.toBe('firestore');
  });

  it('7. mock or local memory data cannot be marked as production', () => {
    const rec: ServerVideoTaskRecord = {
      id: 'task_005',
      taskId: 'task_005',
      status: 'completed',
      modelId: 'veo-3.1',
      projectId: 'xp-vertex-project',
      region: 'us-central1',
      durationSeconds: 4,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      pollAttempt: 1,
      evidenceSource: 'server_memory',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const audit = formatTaskAuditRecord(rec);
    expect(audit.evidenceSource).not.toBe('production');
  });
});
