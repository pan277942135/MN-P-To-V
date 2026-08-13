from pathlib import Path

ORCH = Path('src/services/tasks/taskOrchestrator.ts')
orch = ORCH.read_text()

blind_retry_anchor = """      directionalRepair =
        failureDiagnosis?.repairPromptAppend ||
        videoQaReport.repairInstruction ||
        '恢复所有视频帧与 Approved First Frame 和角色母板的一致身份特征';

      if (videoAttempts < maxVideoAttempts) {
        task.progressStage = `Identity QA ${videoQaReport.gateStatus}，按最差帧问题执行定向重试`;
        task.updatedAt = Date.now();
        await onTaskUpdated(task);
        continue;
      }

      if (videoQaReport.gateStatus === 'review') {
"""

blind_retry_replacement = """      directionalRepair =
        retryDecision.repairPromptAppend ||
        failureDiagnosis?.repairPromptAppend ||
        videoQaReport.repairInstruction ||
        '恢复所有视频帧与 Approved First Frame 和角色母板的一致身份特征';

      if (retryDecision.action === 'REGENERATE_VIDEO') {
        task.progressStage = `自动重试策略允许定向重生成：${retryDecision.reasonCode}`;
        task.updatedAt = Date.now();
        await onTaskUpdated(task);
        continue;
      }

      if (retryDecision.action === 'MANUAL_REVIEW' || videoQaReport.gateStatus === 'review') {
"""

if "if (retryDecision.action === 'REGENERATE_VIDEO') {" in orch:
    print('M2-4 orchestrator retry branch already patched')
elif blind_retry_anchor in orch:
    ORCH.write_text(orch.replace(blind_retry_anchor, blind_retry_replacement, 1))
    print('Patched M2-4 orchestrator retry branch')
else:
    raise SystemExit('M2-4 blind retry branch anchor not found')
