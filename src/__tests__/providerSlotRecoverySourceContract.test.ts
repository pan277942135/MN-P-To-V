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
    expect(serverSource).toContain('isProviderTaskDeletionSafe(rec)');
    expect(serverSource).not.toContain("(!rec.operationName && (rec.status === 'polling' || rec.status === 'submitting'))");
    expect(serverSource).not.toContain("((rec.status === 'polling' || rec.status === 'submitting') && (Date.now() - rec.createdAt) > 300000)");
  });

  it('reconciles submission_outcome_unknown only after live Provider verification succeeds', () => {
    expect(serverSource).toContain("existing.status === 'submission_outcome_unknown'");
    expect(serverSource).toContain('const operationNameLooksValid');
    expect(serverSource).toContain('VideoGenerator.pollVeoOperation(ai, session, operationNameString)');
    expect(serverSource).toContain("failureReason: 'provider_operation_not_verified'");
    expect(serverSource).toContain('任务保持 submission_outcome_unknown，未释放算力槽，也未发起新的 Veo 生成');
    expect(serverSource).toContain("toStatus: 'polling'");
    expect(serverSource).toContain('operationName: operationNameString');
    expect(serverSource).toContain("retryMode: 'RETRY_POLL'");
    expect(serverSource).toContain('providerVerified: true');
    expect(serverSource).toContain('已绑定核实后的 Provider Operation');
  });

  it('initializes a missing recovery record only from a verified operation and current compute project', () => {
    expect(serverSource).toContain('projectId: session.projectId');
    expect(serverSource).toContain("message: '已核实 Provider Operation，并安全初始化 Firestore 恢复任务；未发起新的 Veo 生成。'");
  });

  it('keeps same-task unknown idempotent and never falls through to a second create attempt', () => {
    expect(serverSource).toContain("'qa_pending', 'submission_outcome_unknown'");
    expect(serverSource).toContain("durableExisting.status === 'submission_outcome_unknown'");
    expect(serverSource).toContain("? 'outcome_unknown'");
  });

  it('does not overwrite known healthy/terminal tasks through recover-task', () => {
    expect(serverSource).toContain('任务已在 Firestore 持久化存储中，未修改现有 Provider 状态');
  });
});
