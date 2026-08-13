import { describe, expect, it } from 'vitest';
import fs from 'fs';

const serverSource = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const studioSource = fs.readFileSync(new URL('../pages/StudioPage.tsx', import.meta.url), 'utf8');
const stateSource = fs.readFileSync(new URL('../server/services/taskStateMachineService.ts', import.meta.url), 'utf8');

describe('M2-5 human review production contract', () => {
  it('wires a durable server review endpoint into the state machine', () => {
    expect(serverSource).toContain("app.post('/api/videos/review/:taskId'");
    expect(serverSource).toContain('resolveHumanReview');
    expect(serverSource).toContain("reviewActions: ['accepted', 'rejected']");
    expect(stateSource).toContain('public async resolveHumanReview');
    expect(stateSource).toContain('HUMAN_REVIEW_NOT_ELIGIBLE');
  });

  it('allows completed through accepted REVIEW evidence but does not weaken hard FAIL eligibility', () => {
    expect(stateSource).toContain('humanReviewValid');
    expect(stateSource).toContain("updatedRecord.identityQaStatus === 'review'");
    expect(stateSource).toContain("updatedRecord.humanReviewDecision === 'accepted'");
    expect(stateSource).toContain("currentTask.identityQaStatus === 'review'");
    expect(stateSource).not.toContain("currentTask.identityQaStatus === 'fail' &&");
  });

  it('stops Studio polling when server requests manual video review', () => {
    expect(studioSource).toContain("statusData.status === 'qa_pending' && statusData.requiresManualApproval");
    expect(studioSource).toContain("handleVideoHumanReview('accepted')");
    expect(studioSource).toContain("handleVideoHumanReview('rejected')");
    expect(studioSource).toContain('视频身份质检进入人工复核');
  });

  it('does not treat ambiguous provider submission as a human video acceptance case', () => {
    expect(studioSource).toContain("statusData.status === 'submission_outcome_unknown'");
    expect(studioSource).toContain('自动重试提交结果未知');
    expect(studioSource).toContain('该状态不能通过“接受视频”解除');
  });
});
