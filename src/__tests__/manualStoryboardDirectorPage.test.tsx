// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ScriptDirectorPage } from '../pages/ScriptDirectorPage';

const DRAFT_KEY = 'zaojing_director_v01_brief';
const STORYBOARD_KEY = 'zaojing_director_v02_storyboard';

function seedStep1() {
  window.localStorage.setItem(DRAFT_KEY, JSON.stringify({
    version: 'director-brief-v0.1',
    title: '人工分镜验收项目',
    sourceType: 'outline',
    targetFormat: 'story_short',
    targetDurationSeconds: 12,
    aspectRatio: '9:16',
    creativeBrief: '先人工拆成镜头，再逐环节验收。',
    fullScript: '',
    productionNotes: '',
    savedAt: 123456789,
  }));
}

describe('ScriptDirectorPage manual Step 2 storyboard', () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedStep1();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('adds and saves manually edited shots without provider execution', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<ScriptDirectorPage />);

    fireEvent.click(screen.getByRole('button', { name: '新增镜头' }));
    fireEvent.click(screen.getByRole('button', { name: '新增镜头' }));

    fireEvent.change(screen.getByLabelText('S01 标题'), { target: { value: '拒信特写' } });
    fireEvent.change(screen.getByLabelText('S01 时长（秒）'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('S01 场景'), { target: { value: '出租屋' } });
    fireEvent.change(screen.getByLabelText('S01 画面 / 动作'), { target: { value: '手机屏幕出现拒信。' } });
    fireEvent.change(screen.getByLabelText('S01 镜头语言'), { target: { value: '手机特写' } });

    fireEvent.change(screen.getByLabelText('S02 标题'), { target: { value: '开始制作法杖' } });
    fireEvent.change(screen.getByLabelText('S02 时长（秒）'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('S02 场景'), { target: { value: '地毯手工区' } });

    fireEvent.click(screen.getByRole('button', { name: '保存分镜' }));

    const saved = JSON.parse(window.localStorage.getItem(STORYBOARD_KEY) || '{}');
    expect(saved.version).toBe('manual-storyboard-v0.2');
    expect(saved.shots).toHaveLength(2);
    expect(saved.shots[0]).toMatchObject({
      title: '拒信特写',
      durationSeconds: 4,
      scene: '出租屋',
      action: '手机屏幕出现拒信。',
      camera: '手机特写',
    });
    expect(saved.shots[1]).toMatchObject({ title: '开始制作法杖', durationSeconds: 8 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/Step 2 分镜已保存：2 个镜头，共 12 秒/)).toBeTruthy();
  });

  it('reorders and deletes shots while keeping visible S numbers continuous', () => {
    render(<ScriptDirectorPage />);
    fireEvent.click(screen.getByRole('button', { name: '新增镜头' }));
    fireEvent.click(screen.getByRole('button', { name: '新增镜头' }));

    fireEvent.change(screen.getByLabelText('S01 标题'), { target: { value: 'A镜头' } });
    fireEvent.change(screen.getByLabelText('S02 标题'), { target: { value: 'B镜头' } });

    fireEvent.click(screen.getByRole('button', { name: 'S02 上移' }));
    expect((screen.getByLabelText('S01 标题') as HTMLInputElement).value).toBe('B镜头');
    expect((screen.getByLabelText('S02 标题') as HTMLInputElement).value).toBe('A镜头');

    fireEvent.click(screen.getByRole('button', { name: 'S02 删除' }));
    expect(screen.getByTestId('shot-count').textContent).toBe('1');
    expect((screen.getByLabelText('S01 标题') as HTMLInputElement).value).toBe('B镜头');
    expect(screen.queryByLabelText('S02 标题')).toBeNull();
  });

  it('restores the complete manual storyboard after remount', () => {
    window.localStorage.setItem(STORYBOARD_KEY, JSON.stringify({
      version: 'manual-storyboard-v0.2',
      shots: [
        {
          uid: 'saved-shot-1',
          title: '恢复后的镜头',
          durationSeconds: 6,
          scene: '阳台雨夜',
          action: '人物走向雨幕。',
          camera: '中景',
          dialogue: '没有对白',
          notes: '保持人物一致',
        },
      ],
      savedAt: 999,
    }));

    render(<ScriptDirectorPage />);

    expect((screen.getByLabelText('S01 标题') as HTMLInputElement).value).toBe('恢复后的镜头');
    expect((screen.getByLabelText('S01 场景') as HTMLInputElement).value).toBe('阳台雨夜');
    expect((screen.getByLabelText('S01 画面 / 动作') as HTMLTextAreaElement).value).toBe('人物走向雨幕。');
    expect((screen.getByLabelText('S01 时长（秒）') as HTMLInputElement).value).toBe('6');
  });

  it('does not expose automatic breakdown, image generation, or video generation actions', () => {
    render(<ScriptDirectorPage />);
    expect(screen.queryByRole('button', { name: /AI|自动拆镜|生成分镜|生成图片|生成视频|Veo/i })).toBeNull();
    expect(screen.getByText(/系统不会自动替你生成固定的 S01–S06/)).toBeTruthy();
    expect(screen.getByText(/Step 3｜逐镜关键帧准备与确认/)).toBeTruthy();
  });
});
