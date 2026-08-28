// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KeyframeBlueprintPage } from '../pages/KeyframeBlueprintPage';
import {
  DIRECTOR_DRAFT_KEY,
  KEYFRAME_BLUEPRINT_APPROVAL_KEY,
  KEYFRAME_BLUEPRINT_KEY,
  STORYBOARD_APPROVAL_KEY,
  STORYBOARD_KEY,
} from '../services/director/keyframeBlueprint';

function seedStoryboardPass() {
  window.localStorage.setItem(DIRECTOR_DRAFT_KEY, JSON.stringify({
    version: 'director-brief-v0.1',
    title: '第01集｜窗边那阵风',
    productionNotes: '《风从那年教室吹过》系列，青春校园写实，校服连续。',
  }));
  window.localStorage.setItem(STORYBOARD_KEY, JSON.stringify({
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
  }));
  window.localStorage.setItem(STORYBOARD_APPROVAL_KEY, JSON.stringify({
    version: 'storyboard-approval-v0.2.3',
    approvedAt: 300,
    shotCount: 2,
    storyboardSavedAt: 200,
  }));
}

describe('KeyframeBlueprintPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('automatically creates S01–Sn blueprints from the current Storyboard PASS', () => {
    seedStoryboardPass();
    render(<KeyframeBlueprintPage />);

    expect(screen.getByText(/系统自动创建 2 个 Keyframe Blueprint/)).toBeTruthy();
    expect(screen.getByTestId('keyframe-blueprint-count').textContent).toBe('2');
    expect(screen.getByText('《风从那年教室吹过》系列')).toBeTruthy();

    const saved = JSON.parse(window.localStorage.getItem(KEYFRAME_BLUEPRINT_KEY) || '{}');
    expect(saved.blueprints).toHaveLength(2);
    expect(saved.blueprints[0].shotUid).toBe('shot-a');
    expect(saved.blueprints[1].shotUid).toBe('shot-b');
  });

  it('saves human edits and restores them after remount', () => {
    seedStoryboardPass();
    const first = render(<KeyframeBlueprintPage />);

    fireEvent.change(screen.getByLabelText('S01 图片生成 Prompt'), {
      target: { value: '人工确认后的 S01 图片 Prompt。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存 Blueprint 修改' }));
    expect(screen.getByText(/Step 3.1 已保存：2 个 Keyframe Blueprint/)).toBeTruthy();

    first.unmount();
    render(<KeyframeBlueprintPage />);
    expect((screen.getByLabelText('S01 图片生成 Prompt') as HTMLTextAreaElement).value).toBe('人工确认后的 S01 图片 Prompt。');
  });

  it('requires explicit human confirmation and invalidates PASS after any edit', () => {
    seedStoryboardPass();
    render(<KeyframeBlueprintPage />);

    expect(screen.getByTestId('keyframe-blueprint-approval-status').textContent).toBe('待确认');
    fireEvent.click(screen.getByRole('button', { name: '确认 Keyframe Blueprint' }));
    expect(screen.getByTestId('keyframe-blueprint-approval-status').textContent).toBe('PASS');
    expect(window.localStorage.getItem(KEYFRAME_BLUEPRINT_APPROVAL_KEY)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('S01 关键帧画面描述'), {
      target: { value: '人工修改后的关键帧静态瞬间。' },
    });
    expect(screen.getByTestId('keyframe-blueprint-approval-status').textContent).toBe('待确认');
    expect(window.localStorage.getItem(KEYFRAME_BLUEPRINT_APPROVAL_KEY)).toBeNull();
  });

  it('stays locked and creates nothing when Storyboard has no current PASS', () => {
    window.localStorage.setItem(STORYBOARD_KEY, JSON.stringify({
      version: 'manual-storyboard-v0.2',
      savedAt: 200,
      shots: [{ uid: 'shot-a', title: '未验收镜头' }],
    }));

    render(<KeyframeBlueprintPage />);
    expect(screen.getByText('Step 3.1 尚未解锁')).toBeTruthy();
    expect(window.localStorage.getItem(KEYFRAME_BLUEPRINT_KEY)).toBeNull();
  });
});
