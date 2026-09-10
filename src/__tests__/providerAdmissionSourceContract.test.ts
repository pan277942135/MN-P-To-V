import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const repoSource = fs.readFileSync(path.join(root, 'src/server/repositories/firestoreTaskRepository.ts'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');

describe('durable personal-mode provider admission source contract', () => {
  it('records a per-task admission marker without a project-wide blocking slot', () => {
    expect(repoSource).toContain("providerAdmissionCollectionName = 'video_provider_admission'");
    expect(repoSource).toContain('buildProviderAdmissionScopeKey(record.projectId)');
    expect(repoSource).toContain("doc(`\${scopeKey}_\${taskId}`)");
    expect(repoSource).not.toContain('transaction.get(admissionRef)');
    expect(repoSource).not.toContain('new ProviderAdmissionBusyError');
    expect(repoSource).toContain('transaction.set(docRef, payload)');
    expect(repoSource).toContain('transaction.set(admissionRef');
    expect(repoSource).toContain("mode: 'per_task_concurrent'");
  });

  it('keeps legacy provider-admission failure reporting and does not hide task-level safeguards', () => {
    expect(serverSource).toContain("fsErr?.code === 'PROVIDER_ADMISSION_BUSY'");
    expect(serverSource).toContain("failureReason: 'provider_admission_busy'");
    expect(serverSource).toContain('predictLongRunningCalls: 0');
    expect(serverSource).toContain('blockingTaskId: fsErr?.blockingTaskId');
  });

  it('never converts an ambiguous pre-operation submission into safe-to-regenerate failed state', () => {
    expect(serverSource).toContain("status: 'submission_outcome_unknown'");
    expect(serverSource).toContain("failureReason: 'submission_outcome_unknown'");
    expect(serverSource).toContain('isAmbiguousSubmitFailure');
  });

  it('keeps stale submitting-without-operation and known-operation timeout fail-closed', () => {
    expect(serverSource).toContain("rec.status = 'submission_outcome_unknown'");
    expect(serverSource).toContain("rec.status = 'polling_timeout'");
    expect(serverSource).toContain('提交结果未知，已阻止新的 Veo 提交');
    expect(serverSource).toContain('已有 Operation Name，保留任务并继续阻止新的 Veo 提交');
  });
});
