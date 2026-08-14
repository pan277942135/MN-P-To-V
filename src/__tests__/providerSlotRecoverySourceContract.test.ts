import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const serverSource = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
const policySource = fs.readFileSync(path.join(root, 'src/server/services/providerAdmissionPolicy.ts'), 'utf8');

describe('provider slot recovery safety contract', () => {
  it('blocks deletion of any task that may still consume provider capacity', () => {
    expect(serverSource).toContain('isProviderTaskDeletionSafe(existingTask)');
    expect(serverSource).toContain("failureReason: 'provider_task_delete_blocked'");
    expect(serverSource).toContain('当前任务仍可能占用 Veo Provider');
    expect(policySource).toContain('return !isProviderAdmissionBlockingTask(task)');
  });

  it('clear-failed never treats active/ambiguous provider tasks as deletable stuck tasks', () => {
    expect(serverSource).toContain("rec.status === 'failed'");
    expect(serverSource).toContain("(rec.status as string) === 'submit_failed_safe_to_retry'");
    expect(serverSource).toContain("rec.status === 'artifact_persist_failed'");
    expect(serverSource).not.toContain("(!rec.operationName && (rec.status === 'polling' || rec.status === 'submitting'))");
    expect(serverSource).not.toContain("((rec.status === 'polling' || rec.status === 'submitting') && (Date.now() - rec.createdAt) > 300000)");
  });

  it('reconciles an existing submission_outcome_unknown only from an explicit proven operationName', () => {
    expect(serverSource).toContain("existing.status === 'submission_outcome_unknown'");
    expect(serverSource).toContain("toStatus: 'polling'");
    expect(serverSource).toContain('operationName,');
    expect(serverSource).toContain("retryMode: 'RETRY_POLL'");
    expect(serverSource).toContain('已绑定核实后的 Provider Operation');
  });

  it('does not overwrite known healthy/terminal tasks through recover-task', () => {
    expect(serverSource).toContain('任务已在 Firestore 持久化存储中，未修改现有 Provider 状态');
  });
});
