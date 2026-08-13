from pathlib import Path

STUDIO = Path('src/pages/StudioPage.tsx')
studio = STUDIO.read_text()

# Start response may already be a durable QA REVIEW. Do not force it back into polling.
studio = studio.replace(
    "task.status = startData.status === 'completed' ? 'completed' : 'polling_video';",
    "task.status = startData.status === 'completed' || startData.status === 'qa_pending' ? startData.status : 'polling_video';",
    1,
)

studio = studio.replace(
    """      if (startData.status === 'completed' && (startData.videoDataUrl || startData.resultVideoUrl)) {
        videoData = startData;
      } else {
""",
    """      if (
        (startData.status === 'completed' || (startData.status === 'qa_pending' && startData.requiresManualApproval)) &&
        (startData.videoDataUrl || startData.resultVideoUrl)
      ) {
        videoData = startData;
      } else {
""",
    1,
)

poll_anchor = """            if (statusData.status === 'completed') {
              if (!statusData.videoDataUrl && !statusData.resultVideoUrl) {
                throw new Error('视频渲染完成，但未能成功传输视频播放地址，请重新生成');
              }
              pollDone = true;
              videoData = statusData;
            } else if (statusData.status === 'polling_timeout') {
"""
poll_replacement = """            if (statusData.status === 'completed') {
              if (!statusData.videoDataUrl && !statusData.resultVideoUrl) {
                throw new Error('视频渲染完成，但未能成功传输视频播放地址，请重新生成');
              }
              pollDone = true;
              videoData = statusData;
            } else if (statusData.status === 'qa_pending' && statusData.requiresManualApproval) {
              if (!statusData.videoDataUrl && !statusData.resultVideoUrl) {
                throw new Error('视频已进入人工复核，但服务端未提供持久化视频播放地址');
              }
              pollDone = true;
              videoData = statusData;
            } else if (statusData.status === 'submission_outcome_unknown') {
              pollDone = true;
              throw new Error(statusData.error || '自动重试提交结果未知，已停止自动重提，请人工核对。');
            } else if (statusData.status === 'polling_timeout') {
"""
if "statusData.status === 'qa_pending' && statusData.requiresManualApproval" not in studio:
    if poll_anchor not in studio:
        raise SystemExit('current Studio polling branch anchor not found')
    studio = studio.replace(poll_anchor, poll_replacement, 1)

studio = studio.replace(
    """            if (msg.includes('未能成功传输') || msg.includes('异常中断') || msg.includes('多次查询视频')) {
              throw pollErr;
            }
""",
    """            if (
              msg.includes('未能成功传输') ||
              msg.includes('人工复核') ||
              msg.includes('自动重试提交结果未知') ||
              msg.includes('异常中断') ||
              msg.includes('多次查询视频')
            ) {
              throw pollErr;
            }
""",
    1,
)

STUDIO.write_text(studio)
print('Applied current Studio durable review polling patch')
