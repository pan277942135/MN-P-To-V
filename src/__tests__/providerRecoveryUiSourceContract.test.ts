import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const historySource = fs.readFileSync(path.join(root, 'src/pages/TaskHistoryPage.tsx'), 'utf8');
const recoveryCardSource = fs.readFileSync(path.join(root, 'src/components/ProviderOperationRecoveryCard.tsx'), 'utf8');

describe('provider recovery UI safety contract', () => {
  it('renders submission_outcome_unknown as an explicit protected state', () => {
    expect(historySource).toContain("case 'submission_outcome_unknown':");
    expect(historySource).toContain('提交结果待核实');
    expect(historySource).toContain('isTaskProviderOutcomeUnknown');
    expect(historySource).toContain('ProviderOperationRecoveryCard');
  });

  it('blocks retry and deletion in the client before the protected request reaches the server', () => {
    expect(historySource).toContain('该任务的 Veo 提交结果尚未核实，已禁止重新生成');
    expect(historySource).toContain('该任务仍受 Provider 安全锁保护，禁止删除');
    expect(historySource).toContain('isTaskProviderOutcomeUnknown(targetTask)');
  });

  it('does not count unknown tasks as bulk-clearable failed work', () => {
    expect(historySource).toContain('clearableFailedTaskCount');
    expect(historySource).toContain('!isTaskProviderOutcomeUnknown(t)');
  });

  it('uses only the certified recover-task API and passes the active compute connection', () => {
    expect(recoveryCardSource).toContain("fetch('/api/videos/recover-task'");
    expect(recoveryCardSource).toContain("'x-connection-id': connectionId");
    expect(recoveryCardSource).not.toContain('/api/videos/start');
    expect(recoveryCardSource).not.toContain('predictLongRunning');
  });

  it('explains fail-closed outcomes instead of suggesting regeneration', () => {
    expect(recoveryCardSource).toContain("payload?.failureReason === 'provider_operation_linkage_not_proven'");
    expect(recoveryCardSource).toContain("payload?.linkageReason === 'operation_still_running'");
    expect(recoveryCardSource).toContain("payload?.failureReason === 'provider_operation_not_verified'");
    expect(recoveryCardSource).toContain('当前任务继续锁定');
    expect(recoveryCardSource).toContain('没有发起新的 Veo 生成');
  });
});
