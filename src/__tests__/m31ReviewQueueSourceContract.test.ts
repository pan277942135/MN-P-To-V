import { describe, expect, it } from 'vitest';
import fs from 'fs';

const appSource = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const sidebarSource = fs.readFileSync(new URL('../components/Sidebar.tsx', import.meta.url), 'utf8');
const pageSource = fs.readFileSync(new URL('../pages/HumanReviewQueuePage.tsx', import.meta.url), 'utf8');
const selectorSource = fs.readFileSync(new URL('../services/review/humanReviewQueueService.ts', import.meta.url), 'utf8');

describe('M3-1 durable review queue product contract', () => {
  it('adds a first-class review queue navigation surface', () => {
    expect(appSource).toContain('HumanReviewQueuePage');
    expect(appSource).toContain("activeTab === 'review'");
    expect(sidebarSource).toContain("'review'");
    expect(sidebarSource).toContain('待我审核');
  });

  it('derives queue membership from durable QA and artifact authority fields', () => {
    expect(selectorSource).toContain("task.status === 'qa_pending'");
    expect(selectorSource).toContain("task.identityQaStatus === 'review'");
    expect(selectorSource).toContain("qaReport?.gateStatus === 'review'");
    expect(selectorSource).toContain('task.artifactPersisted === true');
    expect(selectorSource).toContain('task.outputObjectPath');
    expect(selectorSource).toContain('task.videoUri');
  });

  it('keeps provider ambiguity outside the acceptable review queue', () => {
    expect(selectorSource).toContain("task?.status === 'submission_outcome_unknown'");
    expect(pageSource).toContain('这些任务不会进入可接受的 Review Queue');
    expect(pageSource).toContain('避免重复扣费或伪完成');
  });

  it('hands selected tasks to the already-certified Studio review workflow', () => {
    expect(pageSource).toContain("sessionStorage.setItem('zaojing_bring_task_id'");
    expect(pageSource).toContain('onNavigateToStudio');
    expect(pageSource).toContain('打开审核工作台');
  });
});
