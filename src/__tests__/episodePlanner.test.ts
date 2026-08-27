import { describe, expect, it, vi } from 'vitest';
import { EpisodePlanner, fitShotDurations, normalizeShotDuration, type EpisodePlanRequest } from '../services/episode/episodePlanner';

function requestFixture(overrides: Partial<EpisodePlanRequest> = {}): EpisodePlanRequest {
  return {
    episodeId: 'MN-COS-001',
    title: '押金扣光的第七天，我在出租屋手搓法杖',
    storyText: '梅凝在出租屋制作法杖，雨夜登上天台，短暂进入幻想角色状态，最后回到真实世界。',
    characterId: 'meining',
    characterVersion: 'v3',
    characterSnapshot: {
      characterId: 'meining',
      characterVersion: 'v3',
      characterUpdatedAt: 1_800_000_000_000,
      identitySpecHash: 'b'.repeat(64),
      referenceImageIds: ['ref_0', 'ref_1'],
    },
    durationTargetSeconds: 24,
    shotCount: 6,
    budgetLimitUsd: 8,
    ...overrides,
  };
}

function sixDrafts() {
  return [
    {
      title: '切泡棉', durationSeconds: 5, sceneLocation: 'rental_room', sceneTime: 'night', sceneDescription: '桌面工作区',
      action: '梅凝低头切割 EVA 泡棉。', camera: 'close_static', emotion: 'focused', props: ['EVA foam'], voiceover: '第七天。', keyframeProvider: 'CHATGPT_UPLOAD' as const,
    },
    {
      title: '组装', durationSeconds: 6, sceneLocation: 'rental_room', sceneTime: 'night', sceneDescription: '胶枪和材料散落',
      action: '梅凝把泡棉部件粘到法杖骨架。', camera: 'medium_slow_push', emotion: 'tired', props: ['hot glue gun', 'staff'], voiceover: '', keyframeProvider: 'CHATGPT_UPLOAD' as const,
    },
    {
      title: '推门', durationSeconds: 7, sceneLocation: 'rooftop_door', sceneTime: 'rainy night', sceneDescription: '生锈金属门',
      action: '梅凝推开天台门走入雨夜。', camera: 'low_angle_follow', emotion: 'determined', props: ['staff'], voiceover: '', keyframeProvider: 'CHATGPT_UPLOAD' as const,
    },
    {
      title: '幻想', durationSeconds: 8, sceneLocation: 'rooftop', sceneTime: 'rainy night', sceneDescription: '城市灯光和雨幕',
      action: '法杖亮起，幻想造型短暂覆盖现实形象。', camera: 'medium_wide_static', emotion: 'surprised', props: ['glowing staff'], voiceover: '', keyframeProvider: 'GEMINI_GENERATED' as const,
    },
    {
      title: '回落', durationSeconds: 6, sceneLocation: 'rooftop', sceneTime: 'rainy night', sceneDescription: '魔法效果消散',
      action: '光效消失，梅凝低头看手里的胶带法杖。', camera: 'medium_static', emotion: 'relieved', props: ['taped staff'], voiceover: '也就帅了三秒。', keyframeProvider: 'CHATGPT_UPLOAD' as const,
    },
    {
      title: '自拍收束', durationSeconds: 4, sceneLocation: 'rooftop', sceneTime: 'rainy night', sceneDescription: '城市散景',
      action: '梅凝举起法杖看向手机镜头，疲惫地笑一下。', camera: 'selfie_fixed', emotion: 'tired_smile', props: ['taped staff'], voiceover: '', keyframeProvider: 'CHATGPT_UPLOAD' as const,
    },
  ];
}

describe('EpisodePlanner duration normalization', () => {
  it('maps arbitrary draft durations to Veo legal durations', () => {
    expect(normalizeShotDuration(3)).toBe(4);
    expect(normalizeShotDuration(5.9)).toBe(6);
    expect(normalizeShotDuration(9)).toBe(8);
  });

  it('fits legal durations to the exact episode target', () => {
    const fitted = fitShotDurations([5, 6, 7, 8, 6, 4], 24);
    expect(fitted.every((value) => [4, 6, 8].includes(value))).toBe(true);
    expect(fitted.reduce((sum, value) => sum + value, 0)).toBe(24);
  });

  it('rejects impossible odd or out-of-range targets', () => {
    expect(() => fitShotDurations([4, 4, 4, 4, 4, 4], 25)).toThrow();
    expect(() => fitShotDurations([4, 4, 4, 4, 4, 4], 50)).toThrow();
  });
});

describe('EpisodePlanner deterministic domain build', () => {
  it('builds S01-S06 ShotSpecs and preserves keyframe provider decisions', () => {
    const result = EpisodePlanner.buildFromDraftsForTest(
      requestFixture(),
      sixDrafts(),
      1_800_000_010_000
    );

    expect(result.episode.status).toBe('PLANNED');
    expect(result.episode.shotIds).toEqual(['S01', 'S02', 'S03', 'S04', 'S05', 'S06']);
    expect(result.shots.map((shot) => shot.shotId)).toEqual(result.episode.shotIds);
    expect(result.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)).toBe(24);
    expect(result.shots[3].keyframe.provider).toBe('GEMINI_GENERATED');
    expect(result.shots.every((shot) => shot.video.provider === 'VEO')).toBe(true);
  });

  it('rejects model output with the wrong number of shots', () => {
    expect(() => EpisodePlanner.buildFromDraftsForTest(
      requestFixture(),
      sixDrafts().slice(0, 5),
      1_800_000_010_000
    )).toThrow(/PLANNER_SHOT_COUNT_MISMATCH/);
  });

  it('repairs one malformed planner result with a bounded second model call', async () => {
    const generateContent = vi.fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ shots: sixDrafts().slice(0, 5) }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ shots: sixDrafts() }) });
    const fakeAi = { models: { generateContent } } as any;

    const result = await EpisodePlanner.plan(fakeAi, requestFixture(), 'gemini-test-model');

    expect(result.repairAttempted).toBe(true);
    expect(result.shots).toHaveLength(6);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });
});
