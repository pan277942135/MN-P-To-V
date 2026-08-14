import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getExplicitTaskFailureReason } from '../utils/taskHelper';

describe('RAI failure UX guard', () => {
  it('renders genuine output_rai_filtered evidence without literal undefined', () => {
    const task = {
      id: 'task_rai',
      status: 'failed',
      createdAt: Date.now(),
      error: '视频生成结果被 Google Vertex AI 安全策略过滤，未生成可下载的视频。',
      failureReason: 'output_rai_filtered',
      retryMode: 'REWRITE_INPUT_THEN_REGENERATE',
      raiStatus: 'filtered',
      raiMediaFilteredCount: 1,
      raiMediaFilteredReasons: [],
    } as any;

    const info = getExplicitTaskFailureReason(task);

    expect(info.errorCode).toBe('OUTPUT_RAI_FILTERED');
    expect(info.primaryReason).toContain('Google Veo 安全策略过滤');
    expect(info.technicalDetails).toContain('RAI filtered count: 1');
    expect(info.technicalDetails).toContain('Google 未返回具体过滤原因');
    expect(info.recommendedAction).toContain('不要原样一键重试');
    expect(JSON.stringify(info)).not.toContain('undefined');
  });

  it('shows provider RAI reason when the provider supplied one', () => {
    const task = {
      id: 'task_rai_reason',
      status: 'failed',
      createdAt: Date.now(),
      error: 'filtered',
      failureReason: 'output_rai_filtered',
      retryMode: 'REWRITE_INPUT_THEN_REGENERATE',
      raiMediaFilteredCount: 1,
      raiMediaFilteredReasons: ['provider reason'],
    } as any;

    const info = getExplicitTaskFailureReason(task);
    expect(info.technicalDetails).toContain('provider reason');
  });

  it('TaskHistory never treats REWRITE_INPUT_THEN_REGENERATE as one-click resubmission', () => {
    const source = readFileSync('src/pages/TaskHistoryPage.tsx', 'utf8');

    expect(source).toContain('const isTaskInputRewriteRequired');
    expect(source).toContain("failureReason === 'output_rai_filtered'");
    expect(source).toContain("retryMode === 'REWRITE_INPUT_THEN_REGENERATE'");
    expect(source).toContain('if (isTaskInputRewriteRequired(task))');
    expect(source).toContain('返回工作台调整输入');
    expect(source).not.toContain("task.retryMode !== 'SAFE_TO_REGENERATE' && task.retryMode !== 'REWRITE_INPUT_THEN_REGENERATE'");
  });

  it('copies durable RAI semantics from status response into the local task projection', () => {
    const source = readFileSync('src/pages/TaskHistoryPage.tsx', 'utf8');

    expect(source).toContain('(task as any).failureReason = data.failureReason');
    expect(source).toContain('(task as any).retryMode = data.retryMode');
    expect(source).toContain('(task as any).raiStatus = data.raiStatus');
    expect(source).toContain('(task as any).raiMediaFilteredCount = data.raiMediaFilteredCount');
    expect(source).toContain('(task as any).raiMediaFilteredReasons = data.raiMediaFilteredReasons');
  });
});
