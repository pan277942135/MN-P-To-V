from pathlib import Path

path = Path('src/pages/TaskHistoryPage.tsx')
text = path.read_text(encoding='utf-8')

replacements = []

replacements.append((
"""    case 'waiting_first_frame_approval':
      return { text: '待确认首帧', cls: 'bg-amber-950 text-amber-400 border border-amber-800/50' };
    default:
""",
"""    case 'waiting_first_frame_approval':
      return { text: '待确认首帧', cls: 'bg-amber-950 text-amber-400 border border-amber-800/50' };
    case 'qa_pending':
      return { text: '身份质检 / 待审核', cls: 'bg-amber-950 text-amber-300 border border-amber-800/70' };
    default:
"""
))

replacements.append((
"""const getVideoUrl = (task?: GenerationTask | null): string | null => {
""",
"""const isTaskHumanReviewState = (task?: GenerationTask | null): boolean => {
  if (!task) return false;
  return task.status === 'qa_pending' && (
    task.identityQaStatus === 'review' ||
    (typeof task.progressStage === 'string' && task.progressStage.includes('人工复核'))
  );
};

const getVideoUrl = (task?: GenerationTask | null): string | null => {
"""
))

replacements.append((
"""        ['polling', 'polling_video', 'starting_video', 'submitting', 'processing', 'polling_timeout'].includes(t.status) &&
""",
"""        ['polling', 'polling_video', 'starting_video', 'submitting', 'processing', 'polling_timeout', 'qa_pending'].includes(t.status) &&
"""
))

replacements.append((
"""            if (data.status === 'completed' && data.videoDataUrl) {
              t.status = 'completed';
              t.resultVideoUrl = data.videoDataUrl;
              t.progressStage = '合成与全帧视频生成完成';
              t.progressPercent = 100;
              t.error = undefined;
              t.updatedAt = Date.now();
              await taskRepository.save(t);
            } else if (data.status === 'failed') {
""",
"""            if (data.status === 'completed' && data.videoDataUrl) {
              t.status = 'completed';
              t.resultVideoUrl = data.videoDataUrl;
              t.qaReport = data.qaReport || t.qaReport;
              t.identityQaStatus = data.identityQaStatus || t.identityQaStatus;
              t.humanReviewDecision = data.humanReviewDecision || t.humanReviewDecision;
              t.humanReviewRecord = data.humanReviewRecord || t.humanReviewRecord;
              t.progressStage = '合成与全帧视频生成完成';
              t.progressPercent = 100;
              t.error = undefined;
              t.updatedAt = Date.now();
              await taskRepository.save(t);
            } else if (data.status === 'qa_pending') {
              t.status = 'qa_pending';
              t.identityQaStatus = data.identityQaStatus || t.identityQaStatus;
              t.qaReport = data.qaReport || t.qaReport;
              t.humanReviewDecision = data.humanReviewDecision || t.humanReviewDecision;
              t.humanReviewRecord = data.humanReviewRecord || t.humanReviewRecord;
              if (data.videoDataUrl || data.resultVideoUrl) {
                t.resultVideoUrl = data.videoDataUrl || data.resultVideoUrl;
              }
              t.progressStage = data.requiresManualApproval
                ? '视频身份质检需要人工复核'
                : '视频已持久化，等待身份质检';
              t.progressPercent = 95;
              t.error = undefined;
              t.updatedAt = Date.now();
              await taskRepository.save(t);
            } else if (data.status === 'failed') {
"""
))

replacements.append((
"""  const failedTaskCount = tasks.filter(isTaskFailedState).length;
  const completedTaskCount = tasks.filter((t) => t.status === 'completed' || t.status === 'completed_with_warning').length;
  const inProgressTaskCount = tasks.filter((t) => t.status !== 'completed' && t.status !== 'completed_with_warning' && !isTaskFailedState(t)).length;

  const handleClearFailedTasks = async () => {
""",
"""  const failedTaskCount = tasks.filter(isTaskFailedState).length;
  const completedTaskCount = tasks.filter((t) => t.status === 'completed' || t.status === 'completed_with_warning').length;
  const reviewTaskCount = tasks.filter(isTaskHumanReviewState).length;
  const inProgressTaskCount = tasks.filter((t) =>
    t.status !== 'completed' &&
    t.status !== 'completed_with_warning' &&
    !isTaskFailedState(t) &&
    !isTaskHumanReviewState(t)
  ).length;

  const handleOpenHumanReview = (task: GenerationTask) => {
    if (!task?.id) return;
    sessionStorage.setItem('zaojing_bring_task_id', task.id);
    setSelectedTask(null);
    onNavigateToStudio?.();
  };

  const handleClearFailedTasks = async () => {
"""
))

replacements.append((
"""      if (data.status === 'completed' && data.videoDataUrl) {
        task.status = 'completed';
        task.resultVideoUrl = data.videoDataUrl;
        task.qaReport = data.qaReport;
        task.error = undefined;
        task.progressStage = '合成与全帧视频生成完成';
        task.progressPercent = 100;
        await taskRepository.save(task);
        if (selectedTask?.id === task.id) setSelectedTask({ ...task });
        await loadTasks();
      } else if (data.status === 'failed') {
""",
"""      if (data.status === 'completed' && data.videoDataUrl) {
        task.status = 'completed';
        task.resultVideoUrl = data.videoDataUrl;
        task.qaReport = data.qaReport;
        task.identityQaStatus = data.identityQaStatus || task.identityQaStatus;
        task.humanReviewDecision = data.humanReviewDecision || task.humanReviewDecision;
        task.humanReviewRecord = data.humanReviewRecord || task.humanReviewRecord;
        task.error = undefined;
        task.progressStage = '合成与全帧视频生成完成';
        task.progressPercent = 100;
        await taskRepository.save(task);
        if (selectedTask?.id === task.id) setSelectedTask({ ...task });
        await loadTasks();
      } else if (data.status === 'qa_pending') {
        task.status = 'qa_pending';
        task.identityQaStatus = data.identityQaStatus || task.identityQaStatus;
        task.qaReport = data.qaReport || task.qaReport;
        task.humanReviewDecision = data.humanReviewDecision || task.humanReviewDecision;
        task.humanReviewRecord = data.humanReviewRecord || task.humanReviewRecord;
        if (data.videoDataUrl || data.resultVideoUrl) {
          task.resultVideoUrl = data.videoDataUrl || data.resultVideoUrl;
        }
        task.error = undefined;
        task.progressStage = data.requiresManualApproval
          ? '视频身份质检需要人工复核'
          : '视频已持久化，等待身份质检';
        task.progressPercent = 95;
        await taskRepository.save(task);
        if (selectedTask?.id === task.id) setSelectedTask({ ...task });
        await loadTasks();
      } else if (data.status === 'failed') {
"""
))

replacements.append((
"""  const filteredTasks = tasks
    .filter((t) => {
      if (filter === 'completed') return t.status === 'completed' || t.status === 'completed_with_warning';
      if (filter === 'failed') return isTaskFailedState(t);
      if (filter === 'in_progress')
        return (
          t.status !== 'completed' &&
          t.status !== 'completed_with_warning' &&
          !isTaskFailedState(t)
        );
      return true;
    })
""",
"""  const filteredTasks = tasks
    .filter((t) => {
      if (filter === 'completed') return t.status === 'completed' || t.status === 'completed_with_warning';
      if (filter === 'failed') return isTaskFailedState(t);
      if (filter === 'review') return isTaskHumanReviewState(t);
      if (filter === 'in_progress')
        return (
          t.status !== 'completed' &&
          t.status !== 'completed_with_warning' &&
          !isTaskFailedState(t) &&
          !isTaskHumanReviewState(t)
        );
      return true;
    })
"""
))

replacements.append((
"""  const [filter, setFilter] = useState<'all' | 'completed' | 'failed' | 'in_progress'>('all');
""",
"""  const [filter, setFilter] = useState<'all' | 'completed' | 'failed' | 'in_progress' | 'review'>('all');
"""
))

replacements.append((
"""            <button
              onClick={() => setFilter('completed')}
""",
"""            <button
              onClick={() => setFilter('review')}
              className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md font-medium transition whitespace-nowrap ${
                filter === 'review' ? 'bg-amber-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              待审核 ({reviewTaskCount})
            </button>
            <button
              onClick={() => setFilter('completed')}
"""
))

replacements.append((
"""                        const badge = getStatusBadgeInfo(task.status);
""",
"""                        const badge = isTaskHumanReviewState(task)
                          ? { text: '待人工审核', cls: 'bg-amber-950 text-amber-300 border border-amber-700/70' }
                          : getStatusBadgeInfo(task.status);
"""
))

replacements.append((
"""                    {!isFinished && task.progressStage && !isTaskFailedState(task) && (
                      <div className="text-[11px] sm:text-xs text-indigo-400 flex items-center gap-1.5 font-medium animate-pulse">
                        <Clock className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{task.progressStage}</span>
                      </div>
                    )}

                    {isTaskFailedState(task) && task.status !== 'orphaned_local_task' && (() => {
""",
"""                    {!isFinished && task.progressStage && !isTaskFailedState(task) && !isTaskHumanReviewState(task) && (
                      <div className="text-[11px] sm:text-xs text-indigo-400 flex items-center gap-1.5 font-medium animate-pulse">
                        <Clock className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{task.progressStage}</span>
                      </div>
                    )}

                    {isTaskHumanReviewState(task) && (
                      <div className="mt-2.5 p-3 bg-amber-950/35 border border-amber-700/60 rounded-lg text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex items-start gap-2 min-w-0">
                          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                          <div>
                            <div className="font-bold text-amber-200">视频已生成，等待人工复核</div>
                            <div className="text-[11px] text-amber-100/70 mt-1">这不是生成卡住。AI QA 判定为 REVIEW，需要人工接受或拒绝后任务才会结束。</div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenHumanReview(task);
                          }}
                          className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs shrink-0"
                        >
                          进入人工审核
                        </button>
                      </div>
                    )}

                    {isTaskFailedState(task) && task.status !== 'orphaned_local_task' && (() => {
"""
))

replacements.append((
"""            {/* Video preview or Failure Panel */}
            {getVideoUrl(selectedTask) ? (
""",
"""            {isTaskHumanReviewState(selectedTask) && (
              <div className="p-4 rounded-xl bg-amber-950/35 border border-amber-700/60 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold text-amber-200 text-sm">视频已生成，当前等待人工审核</div>
                    <div className="text-[11px] text-amber-100/70 mt-1">QA REVIEW 是人工决策状态，不属于“生成中”。进入创作工作台后可查看 QA 证据并执行接受 / 拒绝。</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleOpenHumanReview(selectedTask)}
                  className="w-full px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs"
                >
                  进入人工审核工作台
                </button>
              </div>
            )}

            {/* Video preview or Failure Panel */}
            {getVideoUrl(selectedTask) ? (
"""
))

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'Expected exactly one match, found {count}: {old[:120]!r}')
    text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
print(f'Applied {len(replacements)} M2 UAT review-pending UX replacements.')
