import { describe, expect, it } from 'vitest';
import { generateLocalStoryboard } from '../services/director/localStoryboardGenerator';

const meiNingStory = '梅凝连续收到工作拒信。失业后的第七天，她窝在出租屋里用 EVA 材料手搓芙莉莲法杖。雨夜，她拿着粗糙的法杖来到阳台，在雨里幻想自己变成了芙莉莲。最后幻想消失，她又变回穿旧卫衣的梅凝。';

describe('local storyboard generator', () => {
  it('turns the accepted Mei Ning story into a complete dynamic shot list', () => {
    const shots = generateLocalStoryboard({
      title: '押金扣光的第七天，我在出租屋手搓法杖',
      creativeBrief: meiNingStory,
      targetDurationSeconds: 30,
      targetFormat: 'story_short',
    });

    expect(shots.length).toBeGreaterThanOrEqual(5);
    expect(shots.length).toBeLessThanOrEqual(12);
    expect(shots.map((shot) => shot.title).join('|')).toMatch(/拒信/);
    expect(shots.map((shot) => shot.title).join('|')).toMatch(/法杖|手作/);
    expect(shots.map((shot) => shot.title).join('|')).toMatch(/幻想/);
    expect(shots.map((shot) => shot.title).join('|')).toMatch(/现实/);
    expect(shots.some((shot) => shot.scene.includes('雨夜阳台'))).toBe(true);
    expect(shots.every((shot) => shot.title && shot.scene && shot.action && shot.camera && shot.notes)).toBe(true);
    expect(shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)).toBe(30);
  });

  it('does not hard-code six shots for unrelated shorter stories', () => {
    const shortShots = generateLocalStoryboard({
      title: '清晨出门',
      creativeBrief: '女孩关掉闹钟。她背上包走出家门。公交车到站，她上车看向窗外。',
      targetDurationSeconds: 12,
      targetFormat: 'vlog',
    });
    const longShots = generateLocalStoryboard({
      title: '长剧情',
      creativeBrief: meiNingStory,
      targetDurationSeconds: 36,
      targetFormat: 'story_short',
    });

    expect(shortShots.length).toBeGreaterThanOrEqual(3);
    expect(shortShots.length).not.toBe(longShots.length);
    expect(shortShots.every((shot) => shot.durationSeconds >= 1)).toBe(true);
  });

  it('prefers a full script over the brief when both are supplied', () => {
    const shots = generateLocalStoryboard({
      title: '脚本优先',
      creativeBrief: '这是不会被采用的简短创意。',
      fullScript: '手机屏幕显示工作拒信。梅凝把手机放下。最后她走到阳台。',
      targetDurationSeconds: 12,
    });

    expect(shots.map((shot) => shot.action).join('|')).toMatch(/工作拒信/);
    expect(shots.map((shot) => shot.action).join('|')).not.toMatch(/不会被采用/);
  });
});
