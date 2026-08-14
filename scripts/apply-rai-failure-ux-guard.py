from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, got {count}')
    return text.replace(old, new, 1)


page_path = Path('src/pages/TaskHistoryPage.tsx')
page = page_path.read_text()

page = replace_once(
    page,
    "const getVideoUrl = (task?: GenerationTask | null): string | null => {",
    "const isTaskInputRewriteRequired = (task?: GenerationTask | null): boolean => {\n"
    "  if (!task) return false;\n"
    "  const failureReason = (task as any).failureReason;\n"
    "  const retryMode = (task as any).retryMode;\n"
    "  return failureReason === 'output_rai_filtered' || retryMode === 'REWRITE_INPUT_THEN_REGENERATE';\n"
    "};\n\n"
    "const getVideoUrl = (task?: GenerationTask | null): string | null => {",
    'insert RAI rewrite predicate',
)

page = replace_once(
    page,
    "  const handleClearFailedTasks = async () => {",
    "  const handleOpenInputRewrite = (task: GenerationTask) => {\n"
    "    if (!task?.id) return;\n"
    "    sessionStorage.setItem('zaojing_bring_task_id', task.id);\n"
    "    setSelectedTask(null);\n"
    "    onNavigateToStudio?.();\n"
    "  };\n\n"
    "  const handleClearFailedTasks = async () => {",
    'insert input rewrite navigation',
)

page = replace_once(
    page,
    "  const handleRetryTask = async (task: GenerationTask) => {\n"
    "    if (!task || !task.id) {\n"
    "      alert('未选定有效任务 ID，无法重试');\n"
    "      return;\n"
    "    }\n"
    "    setIsRetryingTaskId(task.id);",
    "  const handleRetryTask = async (task: GenerationTask) => {\n"
    "    if (!task || !task.id) {\n"
    "      alert('未选定有效任务 ID，无法重试');\n"
    "      return;\n"
    "    }\n"
    "    if (isTaskInputRewriteRequired(task)) {\n"
    "      alert('该任务已被 Google Veo 安全过滤。原样一键重试已禁用，请返回创作工作台修改提示词或更换图片后重新生成。');\n"
    "      return;\n"
    "    }\n"
    "    setIsRetryingTaskId(task.id);",
    'guard one-click retry',
)

page = replace_once(
    page,
    "      if (!isNotSubmitted && task.retryMode !== 'SAFE_TO_REGENERATE' && task.retryMode !== 'REWRITE_INPUT_THEN_REGENERATE') {",
    "      if (!isNotSubmitted && task.retryMode !== 'SAFE_TO_REGENERATE') {",
    'remove rewrite mode from resubmit allowlist',
)

# Preserve durable RAI semantics in the background status reconciliation path.
page = replace_once(
    page,
    "            } else if (data.status === 'failed') {\n"
    "              t.status = 'failed';\n"
    "              t.progressStage = '视频生成失败';",
    "            } else if (data.status === 'failed') {\n"
    "              t.status = 'failed';\n"
    "              (t as any).failureReason = data.failureReason || (t as any).failureReason;\n"
    "              (t as any).retryMode = data.retryMode || (t as any).retryMode;\n"
    "              (t as any).raiStatus = data.raiStatus || (t as any).raiStatus;\n"
    "              if (data.raiMediaFilteredCount !== undefined && data.raiMediaFilteredCount !== null) {\n"
    "                (t as any).raiMediaFilteredCount = data.raiMediaFilteredCount;\n"
    "              }\n"
    "              if (Array.isArray(data.raiMediaFilteredReasons)) {\n"
    "                (t as any).raiMediaFilteredReasons = data.raiMediaFilteredReasons;\n"
    "              }\n"
    "              t.progressStage = '视频生成失败';",
    'sync RAI metadata in background reconciliation',
)

# Preserve durable RAI semantics in explicit manual status checks.
page = replace_once(
    page,
    "      } else if (data.status === 'failed') {\n"
    "        task.status = 'failed';\n"
    "        const errStr = typeof data.error === 'string'",
    "      } else if (data.status === 'failed') {\n"
    "        task.status = 'failed';\n"
    "        (task as any).failureReason = data.failureReason || (task as any).failureReason;\n"
    "        (task as any).retryMode = data.retryMode || (task as any).retryMode;\n"
    "        (task as any).raiStatus = data.raiStatus || (task as any).raiStatus;\n"
    "        if (data.raiMediaFilteredCount !== undefined && data.raiMediaFilteredCount !== null) {\n"
    "          (task as any).raiMediaFilteredCount = data.raiMediaFilteredCount;\n"
    "        }\n"
    "        if (Array.isArray(data.raiMediaFilteredReasons)) {\n"
    "          (task as any).raiMediaFilteredReasons = data.raiMediaFilteredReasons;\n"
    "        }\n"
    "        const errStr = typeof data.error === 'string'",
    'sync RAI metadata in manual check',
)

page = replace_once(
    page,
    "                    {isTaskFailedState(task) && task.status !== 'orphaned_local_task' && (() => {\n"
    "                      const failInfo = getExplicitTaskFailureReason(task);\n"
    "                      return (",
    "                    {isTaskFailedState(task) && task.status !== 'orphaned_local_task' && (() => {\n"
    "                      const failInfo = getExplicitTaskFailureReason(task);\n"
    "                      const requiresInputRewrite = isTaskInputRewriteRequired(task);\n"
    "                      return (",
    'compute RAI failure action mode',
)

old_button = """                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRetryTask(task);
                                }}
                                disabled={isRetryingTaskId === task.id}
                                className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs flex items-center gap-1 shadow transition disabled:opacity-50 shrink-0 cursor-pointer"
                              >
                                <RefreshCw className={`w-3.5 h-3.5 ${isRetryingTaskId === task.id ? 'animate-spin' : ''}`} />
                                一键重试
                              </button>"""
new_button = """                              {requiresInputRewrite ? (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleOpenInputRewrite(task);
                                  }}
                                  className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs flex items-center gap-1 shadow transition shrink-0 cursor-pointer"
                                  title="安全过滤任务必须先修改提示词或图片；不会从任务记录原样重新提交 Veo"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                  返回工作台调整输入
                                </button>
                              ) : (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRetryTask(task);
                                  }}
                                  disabled={isRetryingTaskId === task.id}
                                  className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs flex items-center gap-1 shadow transition disabled:opacity-50 shrink-0 cursor-pointer"
                                >
                                  <RefreshCw className={`w-3.5 h-3.5 ${isRetryingTaskId === task.id ? 'animate-spin' : ''}`} />
                                  一键重试
                                </button>
                              )}"""
page = replace_once(page, old_button, new_button, 'replace RAI retry button')
page_path.write_text(page)

helper_path = Path('src/utils/taskHelper.ts')
helper = helper_path.read_text()
helper = replace_once(
    helper,
    "} {\n  const err = task.error;\n  if (!err) {",
    "} {\n"
    "  const failureReason = (task as any).failureReason;\n"
    "  const retryMode = (task as any).retryMode;\n"
    "  if (failureReason === 'output_rai_filtered' || retryMode === 'REWRITE_INPUT_THEN_REGENERATE') {\n"
    "    const reasonValues = Array.isArray((task as any).raiMediaFilteredReasons)\n"
    "      ? (task as any).raiMediaFilteredReasons.filter((item: unknown) => typeof item === 'string' && item.trim())\n"
    "      : [];\n"
    "    const rawCount = Number((task as any).raiMediaFilteredCount);\n"
    "    const filteredCount = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 1;\n"
    "    const providerReason = reasonValues.length > 0\n"
    "      ? reasonValues.join('；')\n"
    "      : 'Google 未返回具体过滤原因';\n"
    "    return {\n"
    "      primaryReason: '视频生成结果被 Google Veo 安全策略过滤，未生成可下载的视频。',\n"
    "      technicalDetails: `RAI filtered count: ${filteredCount}；${providerReason}`,\n"
    "      recommendedAction: '请返回创作工作台修改提示词或更换图片后重新生成；不要原样一键重试。',\n"
    "      errorCode: 'OUTPUT_RAI_FILTERED',\n"
    "    };\n"
    "  }\n\n"
    "  const err = task.error;\n"
    "  if (!err) {",
    'add explicit RAI failure presentation',
)
helper_path.write_text(helper)

print('Applied RAI failure UX guard')
