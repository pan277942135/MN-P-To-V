from pathlib import Path

SERVER = Path('server.ts')
server = SERVER.read_text()

# 1) Durable retry history must record what happened after provider submission,
# not stop forever at `submitted`.
catch_anchor = """  } catch (qaErr: any) {
    const currentQaAttempt = qaPendingTask.qaAttempt || 1;
    const canReQa = currentQaAttempt < 2;
    const qaError = {
"""
catch_replacement = """  } catch (qaErr: any) {
    const currentQaAttempt = qaPendingTask.qaAttempt || 1;
    const canReQa = currentQaAttempt < 2;
    const retryHistoryForQaError = [...(qaPendingTask.retryHistory || [])];
    if ((qaPendingTask.providerAttempt || 1) > 1) {
      for (let i = retryHistoryForQaError.length - 1; i >= 0; i--) {
        if (retryHistoryForQaError[i].providerAttempt === (qaPendingTask.providerAttempt || 1)) {
          retryHistoryForQaError[i] = {
            ...retryHistoryForQaError[i],
            state: canReQa ? 'qa_retry' : 'manual_review',
          };
          break;
        }
      }
    }
    const qaError = {
"""
if 'retryHistoryForQaError' not in server:
    if catch_anchor not in server:
        raise SystemExit('M2-4 QA catch history anchor not found')
    server = server.replace(catch_anchor, catch_replacement, 1)

qa_catch_patch_anchor = """        automaticRetryPlan: {
          version: 'm2-4-v1',
          action: canReQa ? 'REQA_SAME_ARTIFACT' : 'MANUAL_REVIEW',
"""
if 'retryHistory: retryHistoryForQaError' not in server:
    qa_catch_patch_replacement = """        retryHistory: retryHistoryForQaError,
        automaticRetryPlan: {
          version: 'm2-4-v1',
          action: canReQa ? 'REQA_SAME_ARTIFACT' : 'MANUAL_REVIEW',
"""
    if qa_catch_patch_anchor not in server:
        raise SystemExit('M2-4 QA catch patch anchor not found')
    server = server.replace(qa_catch_patch_anchor, qa_catch_patch_replacement, 1)

# Normal QA result: close the current provider retry-history row deterministically.
diag_anchor = """  const diagnosedQaReport = failureDiagnosis
    ? { ...qaReport, failureDiagnosis, retryDecision }
    : { ...qaReport, retryDecision };

  if (qaReport.gateStatus === 'pass') {
"""
diag_replacement = """  const diagnosedQaReport = failureDiagnosis
    ? { ...qaReport, failureDiagnosis, retryDecision }
    : { ...qaReport, retryDecision };

  const retryHistoryForOutcome = [...(qaPendingTask.retryHistory || [])];
  if ((qaPendingTask.providerAttempt || 1) > 1) {
    const retryOutcomeState =
      qaReport.gateStatus === 'pass'
        ? 'completed'
        : retryDecision.action === 'REQA_SAME_ARTIFACT'
          ? 'qa_retry'
          : (qaReport.gateStatus === 'review' || retryDecision.action === 'MANUAL_REVIEW')
            ? 'manual_review'
            : 'failed';
    for (let i = retryHistoryForOutcome.length - 1; i >= 0; i--) {
      if (retryHistoryForOutcome[i].providerAttempt === (qaPendingTask.providerAttempt || 1)) {
        retryHistoryForOutcome[i] = {
          ...retryHistoryForOutcome[i],
          state: retryOutcomeState,
        };
        break;
      }
    }
  }

  if (qaReport.gateStatus === 'pass') {
"""
if 'const retryHistoryForOutcome' not in server:
    if diag_anchor not in server:
        raise SystemExit('M2-4 retry outcome history anchor not found')
    server = server.replace(diag_anchor, diag_replacement, 1)

complete_anchor = """    return await taskStateMachineService.completeAfterQa({
      taskId,
      qaReport: diagnosedQaReport,
      patch,
    });
"""
complete_replacement = """    return await taskStateMachineService.completeAfterQa({
      taskId,
      qaReport: diagnosedQaReport,
      patch: {
        ...patch,
        retryHistory: retryHistoryForOutcome,
      },
    });
"""
if 'retryHistory: retryHistoryForOutcome' not in server:
    if complete_anchor not in server:
        raise SystemExit('M2-4 complete retry history anchor not found')
    server = server.replace(complete_anchor, complete_replacement, 1)

common_anchor = """  const commonQaPatch: Partial<ServerVideoTaskRecord> = {
    ...patch,
    qaReport: diagnosedQaReport,
"""
common_replacement = """  const commonQaPatch: Partial<ServerVideoTaskRecord> = {
    ...patch,
    retryHistory: retryHistoryForOutcome,
    qaReport: diagnosedQaReport,
"""
if common_replacement not in server:
    if common_anchor not in server:
        raise SystemExit('M2-4 common QA retry history anchor not found')
    server = server.replace(common_anchor, common_replacement, 1)

# 2) submission_outcome_unknown is a terminal automatic-retry safety boundary.
# It must not be swallowed by the generic `!operationName => submitting` response.
submitting_anchor = """      if (record.status === 'submitting' || !record.operationName) {
        return res.json({
"""
unknown_branch = """      if (record.status === 'submission_outcome_unknown') {
        return res.json({
          status: 'submission_outcome_unknown',
          error: record.error,
          structuredError: record.structuredError,
          providerAttempt: record.providerAttempt,
          automaticRetryPlan: record.automaticRetryPlan,
          retryHistory: record.retryHistory,
          requiresManualReview: true,
        });
      }

      if (record.status === 'submitting' || !record.operationName) {
        return res.json({
"""
if "status: 'submission_outcome_unknown',\n          error: record.error" not in server:
    if submitting_anchor not in server:
        raise SystemExit('M2-4 submission outcome status anchor not found')
    server = server.replace(submitting_anchor, unknown_branch, 1)

SERVER.write_text(server)
print('Applied M2-4 post-audit safety fixes')
