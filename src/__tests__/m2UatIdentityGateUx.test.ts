import { describe, expect, it } from 'vitest';
import type { GenerationTask } from '../types';
import {
  buildExecutionTuningPayload,
  getExplicitTaskFailureReason,
  humanizeErrorMessage,
} from '../utils/taskHelper';

const makeFailedTask = (message: string): GenerationTask => ({
  id: 'task_m2_uat_identity_gate',
  characterId: 'meining',
  characterName: '梅凝',
  sceneMode: 'animate_existing_character',
  userPromptChinese: '轻微自然动作',
  normalizedPromptEnglish: 'subtle natural motion',
  settings: {
    aspectRatio: '9:16',
    durationSeconds: 4,
    resolution: '1080p',
    fps: 24,
    pauseForFirstFrameApproval: false,
    primaryStyle: '照片级写实',
    styleStrength: 0.6,
  },
  status: 'failed',
  progressStage: '生成失败',
  progressPercent: 50,
  firstFrameCandidates: [],
  retryCount: 0,
  attempts: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_050_000,
  error: {
    code: 'PIPELINE_ERROR',
    stage: '视频生成阶段',
    messageChinese: `生成失败: ${message}`,
    technicalMessageRedacted: message,
    httpStatus: null,
    retryable: true,
    recommendedAction: '请在【任务记录】页面检查算力或重试',
  },
} as GenerationTask);

describe('M2 UAT identity-gate UX regression', () => {
  it('treats a first-frame identity QA rejection as an intentional pre-Veo block, not an HTTP 500 compute failure', () => {
    const task = makeFailedTask('角色一致性质检未通过 (Identity QA failed)，拒绝启动 Veo 渲染。');
    const payload = buildExecutionTuningPayload(task);

    expect(payload.outputs.httpStatus).toBe(400);
    expect(payload.outputs.errorCode).toBe('IDENTITY_QA_FAILED');
    expect(payload.outputs.messageChinese).toContain('Veo 已在提交前拦截');
    expect(payload.outputs.recommendedAction).toContain('无需检查算力');
    expect(payload.outputs.recommendedAction).toContain('不要原样一键重试');
  });

  it('shows a corrective identity action in task history instead of telling the user to check compute', () => {
    const task = makeFailedTask('Identity QA failed: uploaded face does not match the selected character master.');
    const failure = getExplicitTaskFailureReason(task);

    expect(failure.errorCode).toBe('IDENTITY_QA_FAILED');
    expect(failure.primaryReason).toContain('Veo 已在提交前拦截');
    expect(failure.recommendedAction).toContain('更换');
    expect(failure.recommendedAction).not.toContain('检查算力');
  });

  it('humanizes the exact UAT error as a successful safety gate outcome', () => {
    const message = humanizeErrorMessage('生成失败: 角色一致性质检未通过 (Identity QA failed)，拒绝启动 Veo 渲染。');

    expect(message).toContain('角色一致性质检未通过');
    expect(message).toContain('未产生 Veo 渲染任务');
  });

  it('keeps first-frame REVIEW distinct from FAIL and maps it to 422', () => {
    const task = makeFailedTask('角色一致性处于人工复核区间 (REVIEW)，需要明确人工批准后方可提交 Veo 渲染。');
    const payload = buildExecutionTuningPayload(task);

    expect(payload.outputs.httpStatus).toBe(422);
    expect(payload.outputs.errorCode).toBe('IDENTITY_QA_REVIEW_REQUIRED');
    expect(payload.outputs.messageChinese).toContain('人工复核区间');
    expect(payload.outputs.recommendedAction).toContain('人工核对');
  });
});
