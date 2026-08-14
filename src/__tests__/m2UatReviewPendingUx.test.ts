import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const taskHistorySource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/TaskHistoryPage.tsx'),
  'utf-8'
);
const studioSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/StudioPage.tsx'),
  'utf-8'
);

describe('M2 UAT - QA REVIEW must not look like a stuck generation task', () => {
  it('polls qa_pending from the authoritative status endpoint and preserves REVIEW evidence', () => {
    expect(taskHistorySource).toContain("'polling_timeout', 'qa_pending'");
    expect(taskHistorySource).toContain("else if (data.status === 'qa_pending')");
    expect(taskHistorySource).toContain("t.identityQaStatus = data.identityQaStatus || t.identityQaStatus");
    expect(taskHistorySource).toContain("task.identityQaStatus = data.identityQaStatus || task.identityQaStatus");
    expect(taskHistorySource).toContain("data.requiresManualApproval");
  });

  it('classifies QA REVIEW separately from in-progress generation', () => {
    expect(taskHistorySource).toContain("const isTaskHumanReviewState");
    expect(taskHistorySource).toContain("const reviewTaskCount = tasks.filter(isTaskHumanReviewState).length");
    expect(taskHistorySource).toContain("!isTaskHumanReviewState(t)");
    expect(taskHistorySource).toContain("待审核 ({reviewTaskCount})");
    expect(taskHistorySource).toContain("待人工审核");
  });

  it('routes review tasks into the existing M2-5 Studio review flow instead of duplicating review mutation logic', () => {
    expect(taskHistorySource).toContain("sessionStorage.setItem('zaojing_bring_task_id', task.id)");
    expect(taskHistorySource).toContain('onNavigateToStudio?.()');
    expect(taskHistorySource).toContain('进入人工审核工作台');
    expect(taskHistorySource).not.toContain('/api/videos/review/');

    expect(studioSource).toContain('/api/videos/review/');
    expect(studioSource).toContain("decision: 'accepted' | 'rejected'");
    expect(studioSource).toContain("currentTask.status === 'qa_pending' && currentTask.identityQaStatus === 'review'");
  });

  it('explains that REVIEW is a human decision state, not a render stall', () => {
    expect(taskHistorySource).toContain('视频已生成，等待人工复核');
    expect(taskHistorySource).toContain('这不是生成卡住');
    expect(taskHistorySource).toContain('QA REVIEW 是人工决策状态，不属于“生成中”');
  });
});
