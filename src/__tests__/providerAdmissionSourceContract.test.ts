import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const repoSource = fs.readFileSync(path.join(root, 'src/server/repositories/firestoreTaskRepository.ts'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');

describe('durable personal-mode provider admission source contract', () => {
  it('reserves the task document and per-project provider slot in one Firestore transaction', () => {
    expect(repoSource).toContain("providerAdmissionCollectionName = 'video_provider_admission'");
    expect(repoSource).toContain('buildProviderAdmissionScopeKey(record.projectId)');
    expect(repoSource).toContain('transaction.get(admissionRef)');
    expect(repoSource).toContain('isProviderAdmissionBlockingTask(incumbentTask)');
    expect(repoSource).toContain('new ProviderAdmissionBusyError');
    expect(repoSource).toContain('transaction.set(docRef, payload)');
    expect(repoSource).toContain('transaction.set(admissionRef');
  });

  it('rejects a second different task before Veo submission when the durable slot is occupied', () => {
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
