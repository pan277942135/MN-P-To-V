import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createStructuredError } from '../utils/redactSecrets';
import { getExplicitTaskFailureReason } from '../utils/taskHelper';

describe('M2 UAT RAI safety-filter semantics', () => {
  it('does not model output RAI filtering as HTTP 500/server failure', () => {
    const error = createStructuredError({
      source: 'vertex_polling',
      failureStage: 'polling',
      httpStatus: 500,
      customUserMessage: '视频生成结果被 Google Vertex AI 安全策略过滤，未生成可下载的视频。请调整输入图片或提示词后重新生成。',
    });

    expect(error.httpStatus).toBeNull();
    expect(error.appHttpStatus).toBeNull();
    expect(error.userMessage).toContain('安全策略过滤');
  });

  it('keeps real polling transport errors as HTTP failures', () => {
    const error = createStructuredError({
      source: 'vertex_polling',
      failureStage: 'polling',
      httpStatus: 500,
      customUserMessage: 'Vertex polling upstream connection failed',
    });

    expect(error.httpStatus).toBe(500);
    expect(error.appHttpStatus).toBe(500);
  });

  it('classifies output RAI filtering as rewrite-input and never recommends raw retry', () => {
    const reason = getExplicitTaskFailureReason({
      id: 'task_rai_filtered',
      createdAt: Date.now(),
      status: 'failed',
      failureReason: 'output_rai_filtered',
      retryMode: 'REWRITE_INPUT_THEN_REGENERATE',
      raiMediaFilteredCount: 1,
      raiMediaFilteredReasons: ['Responsible AI filter'],
    } as any);

    expect(reason.errorCode).toBe('OUTPUT_RAI_FILTERED');
    expect(reason.recommendedAction).toContain('返回创作工作台');
    expect(reason.recommendedAction).toContain('不要原样一键重试');
  });

  it('Task History routes RAI-filtered failures to input rewrite instead of one-click retry', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/TaskHistoryPage.tsx'), 'utf8');
    expect(source).toContain("failureReason === 'output_rai_filtered'");
    expect(source).toContain("retryMode === 'REWRITE_INPUT_THEN_REGENERATE'");
    expect(source).toContain('返回工作台调整输入');
    expect(source).toContain('原样一键重试已禁用');
  });
});
