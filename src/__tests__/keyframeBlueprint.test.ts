import { describe, expect, it } from 'vitest';
import {
  CURRENT_SERIES_TITLE,
  buildKeyframeBlueprintDraft,
  findIncompleteBlueprintIndex,
  isStoryboardApprovalCurrent,
} from '../services/director/keyframeBlueprint';

const storyboard = {
  version: 'manual-storyboard-v0.2',
  savedAt: 200,
  shots: [
    {
      uid: 'shot-a',
      title: '教室里的风',
      durationSeconds: 4,
      scene: '高中教室，午后',
      camera: '中景，窗边侧逆光',
      action: '风吹动白色窗帘，女生回头看向后排。',
      dialogue: '',
      notes: '校服与发型保持一致。',
    },
    {
      uid: 'shot-b',
      title: '走廊擦肩',
      durationSeconds: 5,
      scene: '教学楼走廊，放学前',
      camera: '中近景，平视固定机位',
      action: '两人在走廊擦肩，男生停顿半秒。',
      dialogue: '等一下。',
      notes: '书包位置与上一镜连续。',
    },
  ],
};

const approval = {
  approvedAt: 300,
  shotCount: 2,
  storyboardSavedAt: 200,
};

describe('Step 3.1 keyframe blueprint model', () => {
  it('requires a current Storyboard PASS and rejects stale approvals', () => {
    expect(isStoryboardApprovalCurrent(storyboard, approval)).toBe(true);
    expect(isStoryboardApprovalCurrent(storyboard, { ...approval, storyboardSavedAt: 199 })).toBe(false);
    expect(isStoryboardApprovalCurrent(storyboard, { ...approval, shotCount: 3 })).toBe(false);
  });

  it('creates one production blueprint per stable Shot uid', () => {
    const result = buildKeyframeBlueprintDraft({
      projectTitle: '第01集｜窗边那阵风',
      productionNotes: '青春校园写实风格，人物身份与校服连续。',
      storyboard,
      approval,
      now: 400,
    });

    expect(result.seriesTitle).toBe(CURRENT_SERIES_TITLE);
    expect(result.projectTitle).toBe('第01集｜窗边那阵风');
    expect(result.blueprints).toHaveLength(2);
    expect(result.blueprints[0].shotUid).toBe('shot-a');
    expect(result.blueprints[0].shotLabel).toBe('S01');
    expect(result.blueprints[1].shotUid).toBe('shot-b');
    expect(result.blueprints[1].shotLabel).toBe('S02');
    expect(result.blueprints[0].imagePrompt).toContain('高中教室，午后');
    expect(result.blueprints[0].imagePrompt).toContain('风吹动白色窗帘');
    expect(result.blueprints[0].continuity).toContain('校服');
    expect(findIncompleteBlueprintIndex(result)).toBe(-1);
  });
});
