from pathlib import Path
import re

TYPES = Path('src/types/index.ts')
STATE = Path('src/server/services/taskStateMachineService.ts')
SERVER = Path('server.ts')
STUDIO = Path('src/pages/StudioPage.tsx')

types = TYPES.read_text()
state = STATE.read_text()
server = SERVER.read_text()
studio = STUDIO.read_text()

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------
artifact_history_anchor = """export interface VideoArtifactHistoryRecord {
  providerAttempt: number;
  outputBucket: string;
  outputObjectPath: string;
  videoUri: string;
  sizeBytes?: number;
  persistedAt?: number;
  qaStatus?: VideoIdentityQaStatus;
  diagnosisCode?: string;
  archivedAt: number;
}
"""
if 'export type HumanReviewDecision' not in types:
    review_types = artifact_history_anchor + """

export type HumanReviewDecision = 'accepted' | 'rejected';

export interface HumanReviewRecord {
  decision: HumanReviewDecision;
  reviewerId: string;
  note?: string;
  reviewedAt: number;
  sourceQaStatus: 'review';
  sourceStateVersion: number;
  qaSummary?: string;
  worstFrameTimestamp?: number | null;
}
"""
    if artifact_history_anchor not in types:
        raise SystemExit('types human review anchor missing')
    types = types.replace(artifact_history_anchor, review_types, 1)

server_fields_anchor = """  retryHistory?: VideoRetryHistoryRecord[];
  artifactHistory?: VideoArtifactHistoryRecord[];
  attempts?: AttemptRecord[];
"""
if 'humanReviewDecision?: HumanReviewDecision;' not in types:
    server_fields = """  retryHistory?: VideoRetryHistoryRecord[];
  artifactHistory?: VideoArtifactHistoryRecord[];
  humanReviewDecision?: HumanReviewDecision;
  humanReviewRecord?: HumanReviewRecord;
  attempts?: AttemptRecord[];
"""
    if server_fields_anchor not in types:
        raise SystemExit('server human review fields anchor missing')
    types = types.replace(server_fields_anchor, server_fields, 1)

client_fields_anchor = """  identityQaStatus?: VideoIdentityQaStatus;
  identityFrameScores?: number[];
  identityDriftDetected?: boolean;
  worstFrameTimestamp?: number | null;
  retryCount: number;
"""
if '  humanReviewDecision?: HumanReviewDecision;\n  humanReviewRecord?: HumanReviewRecord;\n  retryCount: number;' not in types:
    client_fields = """  identityQaStatus?: VideoIdentityQaStatus;
  identityFrameScores?: number[];
  identityDriftDetected?: boolean;
  worstFrameTimestamp?: number | null;
  humanReviewDecision?: HumanReviewDecision;
  humanReviewRecord?: HumanReviewRecord;
  retryCount: number;
"""
    if client_fields_anchor not in types:
        raise SystemExit('client human review fields anchor missing')
    types = types.replace(client_fields_anchor, client_fields, 1)

# ---------------------------------------------------------------------------
# State machine completion invariant + atomic review decision.
# ---------------------------------------------------------------------------
qa_invariant_anchor = """        const qaValid =
          updatedRecord.identityQaStatus === 'pass' &&
          qaReport?.pass === true &&
          qaReport?.gateStatus === 'pass';
        if (!artifactValid || !qaValid) {
          throw new Error(
            `[VIDEO_QA_COMPLETION_INVARIANT] Task ${taskId} cannot become completed without persisted artifact authority and PASS video identity QA.`
          );
        }
"""
if 'humanReviewValid' not in state:
    qa_invariant_replacement = """        const qaValid =
          updatedRecord.identityQaStatus === 'pass' &&
          qaReport?.pass === true &&
          qaReport?.gateStatus === 'pass';
        const humanReviewValid =
          updatedRecord.identityQaStatus === 'review' &&
          qaReport?.gateStatus === 'review' &&
          updatedRecord.humanReviewDecision === 'accepted' &&
          updatedRecord.humanReviewRecord?.decision === 'accepted' &&
          updatedRecord.humanReviewRecord?.sourceQaStatus === 'review' &&
          Boolean(updatedRecord.humanReviewRecord?.reviewedAt);
        if (!artifactValid || (!qaValid && !humanReviewValid)) {
          throw new Error(
            `[VIDEO_QA_COMPLETION_INVARIANT] Task ${taskId} cannot become completed without persisted artifact authority and either PASS video identity QA or a durable accepted human review of QA REVIEW.`
          );
        }
"""
    if qa_invariant_anchor not in state:
        raise SystemExit('completion invariant anchor missing')
    state = state.replace(qa_invariant_anchor, qa_invariant_replacement, 1)

review_method_anchor = "  public async completeWithPersistedArtifact(params: {"
if 'public async resolveHumanReview(' not in state:
    review_method = r'''  public async resolveHumanReview(params: {
    taskId: string;
    decision: 'accepted' | 'rejected';
    reviewerId: string;
    note?: string;
  }): Promise<ServerVideoTaskRecord> {
    const { taskId, decision, reviewerId, note } = params;
    if (!reviewerId || !reviewerId.trim()) {
      throw new Error('[HUMAN_REVIEW_REVIEWER_REQUIRED] reviewerId is required.');
    }

    return await firestoreTaskRepository.runTaskTransaction<ServerVideoTaskRecord>(taskId, (currentTask) => {
      if (!currentTask) throw new Error(`[TaskStateMachine] Task ${taskId} not found.`);

      if (currentTask.humanReviewRecord) {
        if (currentTask.humanReviewRecord.decision === decision) {
          return { taskPatch: undefined, result: currentTask };
        }
        throw new Error(
          `[HUMAN_REVIEW_DECISION_CONFLICT] Task ${taskId} already has durable decision ${currentTask.humanReviewRecord.decision}.`
        );
      }

      const qaReport = currentTask.qaReport || currentTask.identityQaReport;
      const artifactValid =
        currentTask.artifactPersisted === true &&
        Boolean(currentTask.outputBucket) &&
        Boolean(currentTask.outputObjectPath) &&
        Boolean(currentTask.videoUri);
      const reviewEligible =
        currentTask.status === 'qa_pending' &&
        currentTask.identityQaStatus === 'review' &&
        qaReport?.gateStatus === 'review' &&
        artifactValid;

      if (!reviewEligible) {
        throw new Error(
          `[HUMAN_REVIEW_NOT_ELIGIBLE] Task ${taskId} must be qa_pending with persisted artifact and QA REVIEW; current status=${currentTask.status}, identityQaStatus=${currentTask.identityQaStatus || 'unset'}.`
        );
      }

      const now = Date.now();
      const version = currentVersion(currentTask);
      const reviewRecord = {
        decision,
        reviewerId: reviewerId.trim().slice(0, 128),
        note: note?.trim().slice(0, 1000) || undefined,
        reviewedAt: now,
        sourceQaStatus: 'review' as const,
        sourceStateVersion: version,
        qaSummary: typeof qaReport?.summary === 'string' ? qaReport.summary : undefined,
        worstFrameTimestamp: currentTask.worstFrameTimestamp ?? qaReport?.worstFrameTimestamp ?? null,
      };

      if (decision === 'accepted') {
        const patch: Partial<ServerVideoTaskRecord> = {
          status: 'completed',
          stateVersion: version + 1,
          statusVersion: version + 1,
          humanReviewDecision: 'accepted',
          humanReviewRecord: reviewRecord,
          completedAt: now,
          error: '',
          structuredError: null,
          automaticRetryPlan: {
            version: 'm2-5-v1',
            action: 'HUMAN_ACCEPTED_REVIEW',
            reasonCode: 'HUMAN_ACCEPTED_QA_REVIEW',
            automatic: false,
            requiresHumanReview: false,
          },
          updatedAt: now,
        };
        return { taskPatch: patch, result: { ...currentTask, ...patch } as ServerVideoTaskRecord };
      }

      const patch: Partial<ServerVideoTaskRecord> = {
        status: 'failed',
        stateVersion: version + 1,
        statusVersion: version + 1,
        humanReviewDecision: 'rejected',
        humanReviewRecord: reviewRecord,
        retryMode: 'NO_RETRY',
        error: `人工审核拒绝：${reviewRecord.note || '视频未达到人工验收标准'}`,
        structuredError: buildStructuredError({
          code: 'HUMAN_REVIEW_REJECTED',
          message: reviewRecord.note || 'Video was rejected during human review.',
          stage: 'human_review',
          retryable: false,
          attempt: currentTask.providerAttempt,
        }),
        automaticRetryPlan: {
          version: 'm2-5-v1',
          action: 'HUMAN_REJECTED_REVIEW',
          reasonCode: 'HUMAN_REJECTED_QA_REVIEW',
          automatic: false,
          requiresHumanReview: false,
        },
        updatedAt: now,
      };
      return { taskPatch: patch, result: { ...currentTask, ...patch } as ServerVideoTaskRecord };
    });
  }

'''
    if review_method_anchor not in state:
        raise SystemExit('review method anchor missing')
    state = state.replace(review_method_anchor, review_method + review_method_anchor, 1)

# ---------------------------------------------------------------------------
# Server review endpoint + status response review metadata.
# ---------------------------------------------------------------------------
review_endpoint_anchor = "  // Recover Video Artifact Endpoint"
if "app.post('/api/videos/review/:taskId'" not in server:
    review_endpoint = r'''  // M2-5 Durable Human Review Endpoint
  app.post('/api/videos/review/:taskId', async (req, res) => {
    try {
      const taskId = String(req.params.taskId || '').trim();
      const decisionRaw = String(req.body?.decision || '').trim().toLowerCase();
      const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
      if (!taskId) return res.status(400).json({ error: 'taskId is required' });
      if (decisionRaw !== 'accepted' && decisionRaw !== 'rejected') {
        return res.status(400).json({ error: 'decision must be accepted or rejected' });
      }

      const reviewerHeader = String(req.headers['x-reviewer-id'] || 'studio-workbench').trim();
      const reviewedTask = await taskStateMachineService.resolveHumanReview({
        taskId,
        decision: decisionRaw as 'accepted' | 'rejected',
        reviewerId: reviewerHeader || 'studio-workbench',
        note,
      });
      serverVideoTaskStore.set(taskId, reviewedTask);

      return res.json({
        status: reviewedTask.status,
        taskId,
        stateVersion: reviewedTask.stateVersion,
        humanReviewDecision: reviewedTask.humanReviewDecision,
        humanReviewRecord: reviewedTask.humanReviewRecord,
        identityQaStatus: reviewedTask.identityQaStatus,
        qaReport: reviewedTask.qaReport,
        artifactPersisted: reviewedTask.artifactPersisted,
        videoDataUrl: reviewedTask.videoDataUrl || `/api/videos/stream/${taskId}`,
        error: reviewedTask.error,
      });
    } catch (err: any) {
      const message = err?.message || String(err);
      const status = message.includes('HUMAN_REVIEW_DECISION_CONFLICT') ? 409
        : message.includes('HUMAN_REVIEW_NOT_ELIGIBLE') ? 422
        : message.includes('HUMAN_REVIEW_REVIEWER_REQUIRED') ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

'''
    if review_endpoint_anchor not in server:
        raise SystemExit('server review endpoint anchor missing')
    server = server.replace(review_endpoint_anchor, review_endpoint + review_endpoint_anchor, 1)

manual_response_anchor = """            requiresManualApproval: true,
            automaticRetryPlan: record.automaticRetryPlan,
            retryHistory: record.retryHistory,
            artifactPersisted: true,
"""
if 'reviewActions:' not in server:
    manual_response = """            requiresManualApproval: true,
            reviewActions: ['accepted', 'rejected'],
            humanReviewDecision: record.humanReviewDecision,
            humanReviewRecord: record.humanReviewRecord,
            stateVersion: record.stateVersion,
            automaticRetryPlan: record.automaticRetryPlan,
            retryHistory: record.retryHistory,
            artifactPersisted: true,
"""
    if manual_response_anchor not in server:
        raise SystemExit('server manual review status response anchor missing')
    server = server.replace(manual_response_anchor, manual_response, 1)

# ---------------------------------------------------------------------------
# Studio: stop polling at durable REVIEW, expose human decision controls, and
# never locally fake a completed state without server confirmation.
# ---------------------------------------------------------------------------
state_anchor = """  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [isCopiedCurrentTaskParams, setIsCopiedCurrentTaskParams] = useState<boolean>(false);
"""
if 'isResolvingHumanReview' not in studio:
    studio_state = """  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [isCopiedCurrentTaskParams, setIsCopiedCurrentTaskParams] = useState<boolean>(false);
  const [isResolvingHumanReview, setIsResolvingHumanReview] = useState<boolean>(false);
  const [humanReviewNote, setHumanReviewNote] = useState<string>('');
"""
    if state_anchor not in studio:
        raise SystemExit('Studio human review state anchor missing')
    studio = studio.replace(state_anchor, studio_state, 1)

poll_anchor = """            if (statusData.status === 'completed') {
              pollDone = true;
              videoData = statusData;
            } else if (statusData.status === 'polling_timeout') {
"""
if "statusData.status === 'qa_pending' && statusData.requiresManualApproval" not in studio:
    poll_replacement = """            if (statusData.status === 'completed') {
              pollDone = true;
              videoData = statusData;
            } else if (statusData.status === 'qa_pending' && statusData.requiresManualApproval) {
              pollDone = true;
              videoData = statusData;
            } else if (statusData.status === 'submission_outcome_unknown') {
              pollDone = true;
              throw new Error(statusData.error || '自动重试提交结果未知，已停止自动重提，请人工核对。');
            } else if (statusData.status === 'polling_timeout') {
"""
    if poll_anchor not in studio:
        raise SystemExit('Studio polling manual-review anchor missing')
    studio = studio.replace(poll_anchor, poll_replacement, 1)

video_data_anchor = """      task.qaReport = videoData.qaReport;
      task.identityQaStatus = videoData.identityQaStatus || task.identityQaStatus;
      task.status = videoData.status || task.status;
"""
if 'task.humanReviewDecision = videoData.humanReviewDecision' not in studio:
    video_data_replacement = """      task.qaReport = videoData.qaReport;
      task.identityQaStatus = videoData.identityQaStatus || task.identityQaStatus;
      task.humanReviewDecision = videoData.humanReviewDecision || task.humanReviewDecision;
      task.humanReviewRecord = videoData.humanReviewRecord || task.humanReviewRecord;
      task.status = videoData.status || task.status;
"""
    if video_data_anchor not in studio:
        raise SystemExit('Studio video data review anchor missing')
    studio = studio.replace(video_data_anchor, video_data_replacement, 1)

handler_anchor = """  const handleContinueApproval = async () => {
"""
if 'const handleVideoHumanReview = async (' not in studio:
    handler = r'''  const handleVideoHumanReview = async (decision: 'accepted' | 'rejected') => {
    if (!currentTask || isResolvingHumanReview) return;
    const storedConnectionId = localStorage.getItem('zaojing_connection_id') || '';
    setIsResolvingHumanReview(true);
    try {
      const { res, data } = await safeFetchApi<any>(`/api/videos/review/${encodeURIComponent(currentTask.id)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-reviewer-id': 'studio-workbench',
          ...(storedConnectionId ? { 'x-connection-id': storedConnectionId } : {}),
        },
        body: JSON.stringify({
          decision,
          note: humanReviewNote.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(data.error || `人工审核提交失败 (HTTP ${res.status})`);

      const updatedTask: GenerationTask = {
        ...currentTask,
        status: data.status || currentTask.status,
        identityQaStatus: data.identityQaStatus || currentTask.identityQaStatus,
        humanReviewDecision: data.humanReviewDecision,
        humanReviewRecord: data.humanReviewRecord,
        qaReport: data.qaReport || currentTask.qaReport,
        resultVideoUrl: data.videoDataUrl || currentTask.resultVideoUrl,
        progressStage: decision === 'accepted'
          ? '人工复核已接受，视频正式完成'
          : '人工复核已拒绝，视频保留用于诊断',
        progressPercent: 100,
        updatedAt: Date.now(),
        ...(data.error
          ? {
              error: {
                code: decision === 'rejected' ? 'HUMAN_REVIEW_REJECTED' : 'HUMAN_REVIEW_ERROR',
                stage: 'human_review',
                messageChinese: data.error,
                technicalMessageRedacted: data.error,
                httpStatus: null,
                retryable: false,
                recommendedAction: '根据人工审核意见调整后重新生成',
              },
            }
          : {}),
      };
      setCurrentTask(updatedTask);
      await taskRepository.save(updatedTask);
    } catch (err: any) {
      alert(err?.message || '人工审核提交失败');
    } finally {
      setIsResolvingHumanReview(false);
    }
  };

'''
    if handler_anchor not in studio:
        raise SystemExit('Studio review handler anchor missing')
    studio = studio.replace(handler_anchor, handler + handler_anchor, 1)

video_result_end_anchor = """                    {/* Google Cloud Storage Location & Console Link Card */}
                    <GcsLocationCard task={currentTask} />
                  </div>
                );
              })()}

              {/* Error Box */}
"""
if '视频身份质检进入人工复核' not in studio:
    review_ui = """                    {/* Google Cloud Storage Location & Console Link Card */}
                    <GcsLocationCard task={currentTask} />
                  </div>
                );
              })()}

              {/* M2-5 Durable Human Review */}
              {currentTask.status === 'qa_pending' && currentTask.identityQaStatus === 'review' && (
                <div className="p-4 rounded-xl bg-amber-950/35 border border-amber-700/60 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-bold text-amber-200 text-sm flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4" />
                        视频身份质检进入人工复核
                      </div>
                      <div className="text-[11px] text-amber-100/70 mt-1">
                        自动 QA 未达到严格 PASS，但未触发硬 FAIL。只有人工明确接受后，服务端才会将任务置为 completed。
                      </div>
                    </div>
                    <span className="text-[10px] font-mono px-2 py-1 rounded bg-amber-900/60 border border-amber-700 text-amber-200">
                      QA REVIEW
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                    <div className="p-2 rounded bg-black/30 border border-amber-900/40">
                      <div className="text-zinc-500">平均身份分</div>
                      <div className="text-zinc-100 font-bold">{String((currentTask.qaReport as any)?.averageIdentityScore ?? 'N/A')}</div>
                    </div>
                    <div className="p-2 rounded bg-black/30 border border-amber-900/40">
                      <div className="text-zinc-500">最低身份分</div>
                      <div className="text-zinc-100 font-bold">{String((currentTask.qaReport as any)?.minimumIdentityScore ?? 'N/A')}</div>
                    </div>
                    <div className="p-2 rounded bg-black/30 border border-amber-900/40">
                      <div className="text-zinc-500">时序一致性</div>
                      <div className="text-zinc-100 font-bold">{String((currentTask.qaReport as any)?.temporalConsistencyScore ?? 'N/A')}</div>
                    </div>
                    <div className="p-2 rounded bg-black/30 border border-amber-900/40">
                      <div className="text-zinc-500">最差帧时间</div>
                      <div className="text-zinc-100 font-bold">{String((currentTask.qaReport as any)?.worstFrameTimestamp ?? currentTask.worstFrameTimestamp ?? 'N/A')}s</div>
                    </div>
                  </div>

                  {(currentTask.qaReport as any)?.failureDiagnosis && (
                    <div className="p-3 rounded-lg bg-black/35 border border-amber-900/40 text-[11px] space-y-1">
                      <div className="text-zinc-500">结构化诊断</div>
                      <div className="text-amber-200 font-mono font-bold">
                        {String((currentTask.qaReport as any).failureDiagnosis.primaryCode || 'REVIEW')}
                      </div>
                      <div className="text-zinc-300">
                        {String((currentTask.qaReport as any).failureDiagnosis.summary || currentTask.qaReport?.summary || '')}
                      </div>
                    </div>
                  )}

                  <textarea
                    rows={2}
                    value={humanReviewNote}
                    onChange={(e) => setHumanReviewNote(e.target.value)}
                    placeholder="可选：记录接受/拒绝理由，写入 durable review audit（最多 1000 字）"
                    className="w-full bg-black/30 border border-amber-800/50 rounded-lg p-2.5 text-xs text-zinc-200 focus:outline-none focus:border-amber-500"
                  />

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={isResolvingHumanReview}
                      onClick={() => handleVideoHumanReview('accepted')}
                      className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1.5"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      接受并完成
                    </button>
                    <button
                      type="button"
                      disabled={isResolvingHumanReview}
                      onClick={() => handleVideoHumanReview('rejected')}
                      className="px-4 py-2 rounded-lg bg-rose-800 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1.5"
                    >
                      <AlertTriangle className="w-4 h-4" />
                      拒绝该视频
                    </button>
                    {isResolvingHumanReview && (
                      <span className="text-[11px] text-amber-200 flex items-center gap-1">
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        正在写入服务端审核决策…
                      </span>
                    )}
                  </div>
                </div>
              )}

              {currentTask.status === 'submission_outcome_unknown' && (
                <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-700/70 text-xs space-y-2">
                  <div className="font-bold text-rose-200">自动重试提交结果未知</div>
                  <div className="text-rose-100/80">
                    系统已停止自动重提，避免重复消耗 Veo 配额。该状态不能通过“接受视频”解除，需要在任务历史/Provider 侧核对 operation 后再恢复。
                  </div>
                </div>
              )}

              {/* Error Box */}
"""
    if video_result_end_anchor not in studio:
        raise SystemExit('Studio review UI anchor missing')
    studio = studio.replace(video_result_end_anchor, review_ui, 1)

for path, old, new in [
    (TYPES, TYPES.read_text(), types),
    (STATE, STATE.read_text(), state),
    (SERVER, SERVER.read_text(), server),
    (STUDIO, STUDIO.read_text(), studio),
]:
    if old != new:
        path.write_text(new)

print('Applied M2-5 durable human review integration')
