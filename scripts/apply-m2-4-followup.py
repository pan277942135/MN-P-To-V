from pathlib import Path

ORCH = Path('src/services/tasks/taskOrchestrator.ts')
STATE = Path('src/server/services/taskStateMachineService.ts')

orch = ORCH.read_text()
state = STATE.read_text()

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

if "if (retryDecision.action === 'REGENERATE_VIDEO') {" not in orch:
    if blind_retry_anchor not in orch:
        raise SystemExit('M2-4 blind retry branch anchor not found')
    orch = orch.replace(blind_retry_anchor, blind_retry_replacement, 1)

# TypeScript otherwise infers the first literal branch as { reserved: false },
# making the later { reserved: true } branch incompatible. Keep the durable API
# explicitly boolean because both transaction outcomes are intentional.
reserve_method_anchor = """  public async reserveAutomaticProviderRetry(params: {
    taskId: string;
    decision: any;
    diagnosisCode?: string;
  }): Promise<{ reserved: boolean; task: ServerVideoTaskRecord }> {
    const { taskId, decision, diagnosisCode } = params;
    if (decision?.action !== 'REGENERATE_VIDEO' || !decision?.idempotencyKey) {
      throw new Error('[M2_4_RETRY_RESERVATION_INVALID] REGENERATE_VIDEO decision with idempotency key is required.');
    }

    return await firestoreTaskRepository.runTaskTransaction(taskId, (currentTask) => {
"""
reserve_method_replacement = reserve_method_anchor.replace(
    "runTaskTransaction(taskId,",
    "runTaskTransaction<{ reserved: boolean; task: ServerVideoTaskRecord }>(taskId,",
)

if "runTaskTransaction<{ reserved: boolean; task: ServerVideoTaskRecord }>(taskId" not in state:
    if reserve_method_anchor not in state:
        raise SystemExit('M2-4 retry reservation transaction anchor not found')
    state = state.replace(reserve_method_anchor, reserve_method_replacement, 1)

ORCH.write_text(orch)
STATE.write_text(state)
print('Applied M2-4 follow-up patches')
