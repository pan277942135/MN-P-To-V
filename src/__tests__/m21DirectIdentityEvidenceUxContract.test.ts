import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const server = fs.readFileSync('server.ts', 'utf8');
const studio = fs.readFileSync('src/pages/StudioPage.tsx', 'utf8');
const history = fs.readFileSync('src/pages/TaskHistoryPage.tsx', 'utf8');
const helper = fs.readFileSync('src/utils/taskHelper.ts', 'utf8');

describe('M2-1 preflight identity evidence + retry UX contract', () => {
  it('wires all uploaded masters into the identity gate', () => {
    expect(server).toContain('masterImageBuffers: masterBuffers');
    expect(server).toContain('masterMimeTypes,');
  });

  it('returns first-frame QA evidence even when Veo is intentionally not submitted', () => {
    expect(server).toContain('serverPersisted: false');
    expect(server).toContain('qaReport: gateResult.identityQaReport');
    expect(server).toContain('identityQaScore: gateResult.identityQaScore');
    expect(server).toContain('identityCriticalIssues: gateResult.identityCriticalIssues');
  });

  it('preserves the rejected start payload in the local task instead of throwing away QA evidence', () => {
    expect(studio).toContain('(pipelineError as any).startData = startData');
    expect(studio).toContain('(task as any).firstFrameQaReport = rejectionQa');
    expect(studio).toContain('(task as any).identityQaScore = rejectionData?.identityQaScore ?? rejectionQa?.identityScore');
  });

  it('blocks one-click resubmission for identity preflight failures', () => {
    expect(history).toContain("failureReason === 'identity_qa_failed'");
    expect(history).toContain("failureReason === 'identity_qa_review_required'");
    expect(history).toContain('该任务在提交 Veo 前被首帧角色质检拦截');
  });

  it('surfaces actual preflight QA metrics in failure details', () => {
    expect(helper).toContain('(task as any).firstFrameQaReport');
    expect(helper).toContain('场景 ${report.scenePreservationScore}');
    expect(helper).toContain('姿态 ${report.posePreservationScore}');
    expect(helper).toContain('服装 ${report.outfitPreservationScore}');
    expect(helper).toContain('解剖 ${report.anatomyScore}');
  });
});
