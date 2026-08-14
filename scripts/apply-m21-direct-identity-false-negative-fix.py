from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, got {count}')
    return text.replace(old, new, 1)


# 1) Multi-master first-frame QA + deterministic preservation for DIRECT_CHARACTER_IMAGE.
lock_path = Path('src/services/character/identityLockService.ts')
lock = lock_path.read_text()
lock = replace_once(
    lock,
    "  masterImageBuffer?: Buffer;\n  masterMimeType?: string;",
    "  masterImageBuffer?: Buffer;\n  masterMimeType?: string;\n  masterImageBuffers?: Buffer[];\n  masterMimeTypes?: string[];",
    'identity lock QA input arrays',
)
lock = replace_once(
    lock,
    "    const isTestMode = process.env.NODE_ENV === 'test';\n\n    if (input.ai && input.masterImageBuffer && input.masterImageBuffer.length > 0) {\n      report = await VisualQaService.qaFirstFrame(\n        input.ai,\n        input.analysisModel || 'gemini-3.6-flash',\n        input.masterImageBuffer,\n        input.masterMimeType || 'image/jpeg',",
    "    const isTestMode = process.env.NODE_ENV === 'test';\n\n    const qaMasterBuffers = (input.masterImageBuffers || []).filter((buf) => buf && buf.length > 0);\n    if (qaMasterBuffers.length === 0 && input.masterImageBuffer && input.masterImageBuffer.length > 0) {\n      qaMasterBuffers.push(input.masterImageBuffer);\n    }\n    const qaMasterMimeTypes = qaMasterBuffers.map((_, index) =>\n      input.masterMimeTypes?.[index] || (index === 0 ? input.masterMimeType : undefined) || 'image/jpeg'\n    );\n\n    if (input.ai && qaMasterBuffers.length > 0) {\n      report = await VisualQaService.qaFirstFrame(\n        input.ai,\n        input.analysisModel || 'gemini-3.6-flash',\n        qaMasterBuffers,\n        qaMasterMimeTypes,",
    'multi master gate call',
)
lock = replace_once(
    lock,
    "    } else if (isTestMode && !input.ai && input.masterImageBuffer && input.masterImageBuffer.length > 0) {",
    "    } else if (isTestMode && !input.ai && qaMasterBuffers.length > 0) {",
    'test master evidence check',
)
lock = replace_once(
    lock,
    "    const criticalIssues = (report.issues || [])",
    "    // DIRECT_CHARACTER_IMAGE uses the uploaded scene bytes as the candidate first frame.\n    // Scene / pose / outfit preservation are therefore deterministic, not model-estimated.\n    if (input.imageIsTargetCharacter === true) {\n      report = {\n        ...report,\n        scenePreservationScore: 100,\n        posePreservationScore: 100,\n        outfitPreservationScore: 100,\n      };\n    }\n\n    const criticalIssues = (report.issues || [])",
    'direct preservation normalization',
)
lock = replace_once(
    lock,
    "    const canStartVeo =\n      status === 'pass' || (status === 'review' && Boolean(input.manualApproved));\n\n    return {\n      status,\n      identityQaReport: report,",
    "    const canStartVeo =\n      status === 'pass' || (status === 'review' && Boolean(input.manualApproved));\n\n    report = { ...report, pass: strictPass };\n\n    return {\n      status,\n      identityQaReport: report,",
    'recompute report pass after deterministic normalization',
)
lock_path.write_text(lock)

qa_path = Path('src/services/qa/visualQaService.ts')
qa = qa_path.read_text()
qa = replace_once(
    qa,
    "    masterImageBuffer: Buffer,\n    masterMimeType: string,",
    "    masterImageBuffer: Buffer | Buffer[],\n    masterMimeType: string | string[],",
    'visual QA multi-master signature',
)
qa = replace_once(
    qa,
    "1. [MASTER_REFERENCE]: 目标角色母板照片。",
    "1. [MASTER_REFERENCE_1..N]: 同一目标角色的多角度母板照片；应综合整组母板判断身份，不得要求候选图机械复制某一张母板的拍摄角度或瞬时表情。",
    'multi-master prompt label',
)
qa = replace_once(
    qa,
    "- identityScore: 生成首帧与角色母板的脸部五官、眼型瞳色、发型发色一致性。合格线 >= 95。",
    "- identityScore: 生成首帧与整组角色母板的脸部五官、眼型瞳色及 IdentitySpec 锁定特征的一致性。需要综合多角度证据，避免因单张母板的角度、光照、表情差异误判。合格线 >= 95。",
    'multi-master identity scoring prompt',
)
qa = replace_once(
    qa,
    "    try {\n      const response = await callWithRetry(",
    "    const masterBuffers = Array.isArray(masterImageBuffer) ? masterImageBuffer : [masterImageBuffer];\n    const masterMimeTypes = Array.isArray(masterMimeType) ? masterMimeType : [masterMimeType];\n    const masterParts: any[] = [];\n    masterBuffers.forEach((buffer, index) => {\n      masterParts.push({\n        inlineData: {\n          mimeType: masterMimeTypes[index] || masterMimeTypes[0] || 'image/jpeg',\n          data: buffer.toString('base64'),\n        },\n      });\n      masterParts.push({ text: `[MASTER_REFERENCE_${index + 1}]: Target character identity reference ${index + 1}` });\n    });\n\n    try {\n      const response = await callWithRetry(",
    'construct multi-master parts',
)
qa = replace_once(
    qa,
    "                parts: [\n                  {\n                    inlineData: {\n                      mimeType: masterMimeType,\n                      data: masterImageBuffer.toString('base64'),\n                    },\n                  },\n                  {\n                    inlineData: {\n                      mimeType: sceneMimeType,",
    "                parts: [\n                  ...masterParts,\n                  {\n                    inlineData: {\n                      mimeType: sceneMimeType,",
    'send all master images to QA model',
)
qa_path.write_text(qa)

# 2) Server sends all already-uploaded masters into preflight QA and returns complete evidence.
server_path = Path('server.ts')
server = server_path.read_text()
server = replace_once(
    server,
    "      // Identity Lock Step 3: Evaluate First Frame Identity Gate\n      const masterBufForQa = masterBuffers[0];\n      const masterMimeForQa = masterMimeTypes[0];\n\n      const gateResult = await IdentityLockService.evaluateIdentityGate({\n        ai,\n        analysisModel: session.analysisModel || 'gemini-3.6-flash',\n        masterImageBuffer: masterBufForQa,\n        masterMimeType: masterMimeForQa,",
    "      // Identity Lock Step 3: Evaluate First Frame Identity Gate\n      // Use the complete uploaded identity pack (up to 4 masters), not only masterBuffers[0].\n      const gateResult = await IdentityLockService.evaluateIdentityGate({\n        ai,\n        analysisModel: session.analysisModel || 'gemini-3.6-flash',\n        masterImageBuffer: masterBuffers[0],\n        masterMimeType: masterMimeTypes[0],\n        masterImageBuffers: masterBuffers,\n        masterMimeTypes,",
    'server multi-master gate wiring',
)
server = replace_once(
    server,
    "          qaReport: gateResult.identityQaReport,\n          requiresManualApproval: isReview,",
    "          qaReport: gateResult.identityQaReport,\n          firstFrameIdentityQaStatus: gateResult.status,\n          identityQaScore: gateResult.identityQaScore,\n          identityCriticalIssues: gateResult.identityCriticalIssues,\n          requiresManualApproval: isReview,",
    'server preflight evidence response',
)
server_path.write_text(server)

# 3) Keep preflight QA evidence in IndexedDB instead of throwing it away.
studio_path = Path('src/pages/StudioPage.tsx')
studio = studio_path.read_text()
studio = replace_once(
    studio,
    "      if (!startRes.ok || !startData.accepted || !startData.serverPersisted || !startData.taskId) {\n        throw new Error(startData?.error || '启动视频生成任务失败：服务端未接收或未持久化记录');\n      }",
    "      if (!startRes.ok || !startData.accepted || !startData.serverPersisted || !startData.taskId) {\n        const pipelineError = new Error(startData?.error || '启动视频生成任务失败：服务端未接收或未持久化记录');\n        (pipelineError as any).startData = startData;\n        (pipelineError as any).structuredError = startData?.structuredError;\n        throw pipelineError;\n      }",
    'preserve start rejection payload',
)
studio = replace_once(
    studio,
    "    } catch (pipelineErr: any) {\n      console.error('Video pipeline error:', pipelineErr);\n      const errMsg = pipelineErr.message || String(pipelineErr);\n      task.status = 'failed';\n      task.progressStage = '生成失败';\n      task.error = {\n        code: 'PIPELINE_ERROR',\n        stage: '视频生成阶段',\n        messageChinese: `生成失败: ${errMsg}`,\n        technicalMessageRedacted: errMsg,\n        httpStatus: null,\n        retryable: true,\n        recommendedAction: '请在【任务记录】页面检查算力或重试',\n      };",
    "    } catch (pipelineErr: any) {\n      console.error('Video pipeline error:', pipelineErr);\n      const errMsg = pipelineErr.message || String(pipelineErr);\n      const rejectionData = pipelineErr?.startData;\n      const rejectionReason = typeof rejectionData?.failureReason === 'string' ? rejectionData.failureReason : '';\n      const isIdentityGateRejection = rejectionReason === 'identity_qa_failed' || rejectionReason === 'identity_qa_review_required';\n      const rejectionQa = rejectionData?.qaReport;\n\n      task.status = 'failed';\n      task.progressStage = '生成失败';\n      if (isIdentityGateRejection) {\n        task.failureReason = rejectionReason as any;\n        task.retryMode = 'NO_RETRY';\n        (task as any).firstFrameQaReport = rejectionQa;\n        (task as any).firstFrameIdentityQaStatus = rejectionData?.firstFrameIdentityQaStatus || (rejectionReason === 'identity_qa_review_required' ? 'review' : 'fail');\n        (task as any).identityQaScore = rejectionData?.identityQaScore ?? rejectionQa?.identityScore;\n        (task as any).identityCriticalIssues = rejectionData?.identityCriticalIssues || [];\n      }\n      const structured = rejectionData?.structuredError || pipelineErr?.structuredError;\n      const scoreDetails = rejectionQa\n        ? `identity=${rejectionQa.identityScore}; scene=${rejectionQa.scenePreservationScore}; pose=${rejectionQa.posePreservationScore}; outfit=${rejectionQa.outfitPreservationScore}; anatomy=${rejectionQa.anatomyScore}; summary=${rejectionQa.summary || ''}`\n        : errMsg;\n      task.error = {\n        code: isIdentityGateRejection\n          ? (rejectionReason === 'identity_qa_review_required' ? 'IDENTITY_QA_REVIEW_REQUIRED' : 'IDENTITY_QA_FAILED')\n          : 'PIPELINE_ERROR',\n        stage: '视频生成阶段',\n        messageChinese: isIdentityGateRejection ? (rejectionData?.error || errMsg) : `生成失败: ${errMsg}`,\n        technicalMessageRedacted: isIdentityGateRejection ? scoreDetails : errMsg,\n        httpStatus: structured?.httpStatus ?? (isIdentityGateRejection ? (rejectionReason === 'identity_qa_review_required' ? 422 : 400) : null),\n        retryable: !isIdentityGateRejection,\n        recommendedAction: isIdentityGateRejection\n          ? '请返回创作工作台核对所选角色、母板与输入图；系统将显示本次首帧 QA 分数与原因。不要原样一键重试。'\n          : '请在【任务记录】页面检查算力或重试',\n      };",
    'persist preflight QA evidence locally',
)
studio_path.write_text(studio)

# 4) Make identity preflight failures first-class failure reasons.
types_path = Path('src/types/index.ts')
types = types_path.read_text()
types = replace_once(
    types,
    "  | 'input_safety_blocked'\n  | 'output_rai_filtered'",
    "  | 'input_safety_blocked'\n  | 'identity_qa_failed'\n  | 'identity_qa_review_required'\n  | 'output_rai_filtered'",
    'identity failure reason types',
)
types_path.write_text(types)

# 5) Task History: no one-click retry for pre-Veo identity blocks; show actual QA scores.
history_path = Path('src/pages/TaskHistoryPage.tsx')
history = history_path.read_text()
history = replace_once(
    history,
    "  return failureReason === 'output_rai_filtered' || retryMode === 'REWRITE_INPUT_THEN_REGENERATE';",
    "  return (\n    failureReason === 'output_rai_filtered' ||\n    failureReason === 'identity_qa_failed' ||\n    failureReason === 'identity_qa_review_required' ||\n    retryMode === 'REWRITE_INPUT_THEN_REGENERATE'\n  );",
    'identity retry UI guard predicate',
)
history = replace_once(
    history,
    "    if (isTaskInputRewriteRequired(task)) {\n      alert('该任务已被 Google Veo 安全过滤。原样一键重试已禁用，请返回创作工作台修改提示词或更换图片后重新生成。');\n      return;\n    }",
    "    if (isTaskInputRewriteRequired(task)) {\n      const reason = (task as any).failureReason;\n      if (reason === 'identity_qa_failed' || reason === 'identity_qa_review_required') {\n        alert('该任务在提交 Veo 前被首帧角色质检拦截。原样一键重试已禁用，请返回创作工作台核对角色、母板与输入图。');\n      } else {\n        alert('该任务已被 Google Veo 安全过滤。原样一键重试已禁用，请返回创作工作台修改提示词或更换图片后重新生成。');\n      }\n      return;\n    }",
    'identity retry hard guard',
)
history_path.write_text(history)

helper_path = Path('src/utils/taskHelper.ts')
helper = helper_path.read_text()
helper = replace_once(
    helper,
    "  const err = task.error;\n  if (!err) {",
    "  if (failureReason === 'identity_qa_failed' || failureReason === 'identity_qa_review_required') {\n"
    "    const report = (task as any).firstFrameQaReport || null;\n"
    "    const identityScore = Number((task as any).identityQaScore ?? report?.identityScore);\n"
    "    const scoreText = report\n"
    "      ? `身份 ${Number.isFinite(identityScore) ? identityScore : report.identityScore}；场景 ${report.scenePreservationScore}；姿态 ${report.posePreservationScore}；服装 ${report.outfitPreservationScore}；解剖 ${report.anatomyScore}`\n"
    "      : (Number.isFinite(identityScore) ? `身份 ${identityScore}` : '首帧 QA 详细分数未保留');\n"
    "    const issueText = Array.isArray(report?.issues) && report.issues.length > 0\n"
    "      ? `；问题：${report.issues.map((issue: any) => `${issue.code}: ${issue.description}`).join('；')}`\n"
    "      : '';\n"
    "    const isReview = failureReason === 'identity_qa_review_required';\n"
    "    return {\n"
    "      primaryReason: isReview\n"
    "        ? '首帧角色一致性进入 REVIEW 区间，Veo 尚未提交。'\n"
    "        : '首帧角色/画面质检触发硬拦截，Veo 尚未提交。',\n"
    "      technicalDetails: `${scoreText}${issueText}${report?.summary ? `；${report.summary}` : ''}`,\n"
    "      recommendedAction: '请返回创作工作台核对角色、母板与输入图；不要原样一键重试。',\n"
    "      errorCode: isReview ? 'IDENTITY_QA_REVIEW_REQUIRED' : 'IDENTITY_QA_FAILED',\n"
    "    };\n"
    "  }\n\n"
    "  const err = task.error;\n  if (!err) {",
    'identity detailed failure presentation',
)
helper_path.write_text(helper)

print('Applied M2-1 direct identity false-negative hardening')
