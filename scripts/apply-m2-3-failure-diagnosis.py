from pathlib import Path

SERVER = Path('server.ts')
ORCHESTRATOR = Path('src/services/tasks/taskOrchestrator.ts')

server = SERVER.read_text()
orchestrator = ORCHESTRATOR.read_text()

server_import = "import { DurableVideoIdentityQaService } from './src/server/services/durableVideoIdentityQaService';\n"
server_diag_import = "import { VideoFailureDiagnosisService } from './src/services/qa/videoFailureDiagnosisService';\n"
if server_diag_import not in server:
    if server_import not in server:
        raise SystemExit('server diagnosis import anchor not found')
    server = server.replace(server_import, server_import + server_diag_import, 1)

server_anchor = """  if (qaReport.gateStatus === 'pass') {\n    return await taskStateMachineService.completeAfterQa({\n      taskId,\n      qaReport,\n      patch,\n    });\n  }\n\n  const commonQaPatch: Partial<ServerVideoTaskRecord> = {\n    ...patch,\n    qaReport,\n    identityQaReport: qaReport,\n"""
server_replacement = """  const failureDiagnosis = VideoFailureDiagnosisService.diagnose(qaReport);\n  const diagnosedQaReport = failureDiagnosis\n    ? { ...qaReport, failureDiagnosis }\n    : qaReport;\n\n  if (qaReport.gateStatus === 'pass') {\n    return await taskStateMachineService.completeAfterQa({\n      taskId,\n      qaReport: diagnosedQaReport,\n      patch,\n    });\n  }\n\n  const commonQaPatch: Partial<ServerVideoTaskRecord> = {\n    ...patch,\n    qaReport: diagnosedQaReport,\n    identityQaReport: diagnosedQaReport,\n"""
if 'const failureDiagnosis = VideoFailureDiagnosisService.diagnose(qaReport);' not in server:
    if server_anchor not in server:
        raise SystemExit('server diagnosis settlement anchor not found')
    server = server.replace(server_anchor, server_replacement, 1)

server = server.replace(
    """      failureReason: 'artifact_invalid',\n      retryMode: 'SAFE_TO_REGENERATE',\n      error: `视频身份一致性质检失败: ${qaReport.summary}`,\n      structuredError: {\n        code: 'VIDEO_IDENTITY_QA_FAILED',\n        message: qaReport.summary,\n""",
    """      failureReason: 'artifact_invalid',\n      retryMode: failureDiagnosis?.retryRecommended === false ? 'NO_RETRY' : 'SAFE_TO_REGENERATE',\n      error: `视频身份一致性质检失败 [${failureDiagnosis?.primaryCode || 'UNKNOWN_VIDEO_QA_FAILURE'}]: ${qaReport.summary}`,\n      structuredError: {\n        code: `VIDEO_IDENTITY_QA_${failureDiagnosis?.primaryCode || 'UNKNOWN_VIDEO_QA_FAILURE'}`,\n        message: qaReport.summary,\n""",
    1,
)

server = server.replace(
    """          minimumIdentityScore: qaReport.minimumIdentityScore,\n          worstFrameTimestamp: qaReport.worstFrameTimestamp,\n""",
    """          minimumIdentityScore: qaReport.minimumIdentityScore,\n          worstFrameTimestamp: qaReport.worstFrameTimestamp,\n          failureDiagnosis,\n""",
    1,
)

orch_import = "import { VideoIdentityQaService } from '../qa/videoIdentityQaService';\n"
orch_diag_import = "import { VideoFailureDiagnosisService } from '../qa/videoFailureDiagnosisService';\n"
if orch_diag_import not in orchestrator:
    if orch_import not in orchestrator:
        raise SystemExit('orchestrator diagnosis import anchor not found')
    orchestrator = orchestrator.replace(orch_import, orch_import + orch_diag_import, 1)

orch_anchor = """      task.qaReport = videoQaReport;\n      task.identityQaStatus = videoQaReport.gateStatus;\n"""
orch_replacement = """      const failureDiagnosis = VideoFailureDiagnosisService.diagnose(videoQaReport);\n      const diagnosedQaReport = failureDiagnosis\n        ? { ...videoQaReport, failureDiagnosis }\n        : videoQaReport;\n\n      task.qaReport = diagnosedQaReport;\n      task.identityQaStatus = videoQaReport.gateStatus;\n"""
if 'const failureDiagnosis = VideoFailureDiagnosisService.diagnose(videoQaReport);' not in orchestrator:
    if orch_anchor not in orchestrator:
        raise SystemExit('orchestrator QA diagnosis anchor not found')
    orchestrator = orchestrator.replace(orch_anchor, orch_replacement, 1)

orchestrator = orchestrator.replace(
    """        notes: `[${videoQaReport.gateStatus}] ${videoQaReport.summary}`,\n""",
    """        notes: `[${videoQaReport.gateStatus}][${failureDiagnosis?.primaryCode || 'NO_FAILURE_DIAGNOSIS'}] ${videoQaReport.summary}`,\n""",
    1,
)

orchestrator = orchestrator.replace(
    """      directionalRepair =\n        videoQaReport.repairInstruction ||\n        '恢复所有视频帧与 Approved First Frame 和角色母板的一致身份特征';\n""",
    """      directionalRepair =\n        failureDiagnosis?.repairPromptAppend ||\n        videoQaReport.repairInstruction ||\n        '恢复所有视频帧与 Approved First Frame 和角色母板的一致身份特征';\n""",
    1,
)

orchestrator = orchestrator.replace(
    """        messageChinese: `视频身份一致性未通过：${videoQaReport.summary}`,\n        technicalMessageRedacted: 'Video identity QA gate failed after maximum attempts',\n""",
    """        messageChinese: `视频身份一致性未通过 [${failureDiagnosis?.primaryCode || 'UNKNOWN_VIDEO_QA_FAILURE'}]：${videoQaReport.summary}`,\n        technicalMessageRedacted: `Video identity QA failed: ${failureDiagnosis?.primaryCode || 'UNKNOWN_VIDEO_QA_FAILURE'}`,\n""",
    1,
)

SERVER.write_text(server)
ORCHESTRATOR.write_text(orchestrator)
print('Applied M2-3 failure diagnosis integration')
