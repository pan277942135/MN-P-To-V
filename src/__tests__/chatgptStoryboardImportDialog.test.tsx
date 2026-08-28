// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GeminiStoryboardDirectorPage } from '../pages/GeminiStoryboardDirectorPage';

const DRAFT_KEY = 'zaojing_director_v01_brief';
const STORYBOARD_KEY = 'zaojing_director_v02_storyboard';

const importPayload = {
  schema: 'zaojing.storyboard.v1',
  project: {
    title: '手机端 ChatGPT 分镜导入',
    sourceType: 'script',
    targetFormat: 'story_short',
    targetDurationSeconds: 18,
    aspectRatio: '9:16',
    creativeBrief: '一个已经在 ChatGPT 中讨论完成的短故事。',
    fullScript: '完整故事文本。',
    productionNotes: '保持角色和服装连续。',
  },
  shots: [
    {
      title: '开场',
      durationSeconds: 4,
      scene: '出租屋白天',
      camera: '中景固定机位',
      action: '人物放下手机，停顿两秒。',
      dialogue: '',
      notes: '保持真实世界状态。',
    },
    {
      title: '转折',
      durationSeconds: 5,
      scene: '出租屋夜晚',
      camera: '手部近景',
      action: '人物开始制作道具。',
      dialogue: '',
      notes: '与上一镜服装一致。',
    },
    {
      title: '结尾',
      durationSeconds: 4,
      scene: '雨夜阳台',
      camera: '中近景固定机位',
      action: '人物回到现实，轻轻笑了一下。',
      dialogue: '',
      notes: '回归真实状态。',
    },
  ],
};

describe('manual ChatGPT storyboard import dialog', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens a dialog with paste input and format requirements side by side, then splits imported shots', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<GeminiStoryboardDirectorPage />);
    fireEvent.click(screen.getByRole('button', { name: '手动录入分镜' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByLabelText('粘贴分镜内容')).toBeTruthy();
    expect(screen.getByTestId('chatgpt-storyboard-format').textContent).toContain('zaojing.storyboard.v1');
    expect(screen.getByTestId('chatgpt-storyboard-format').textContent).toContain('shots 数量根据剧情动态决定');

    fireEvent.change(screen.getByLabelText('粘贴分镜内容'), {
      target: { value: JSON.stringify(importPayload) },
    });
    fireEvent.click(screen.getByRole('button', { name: '导入并拆分 Shot' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('gemini-shot-count').textContent).toBe('3');
    expect(screen.getByTestId('generation-engine').textContent).toContain('ChatGPT 手动导入');
    expect((screen.getByLabelText('S01 标题') as HTMLInputElement).value).toBe('开场');
    expect((screen.getByLabelText('S03 标题') as HTMLInputElement).value).toBe('结尾');

    const savedDraft = JSON.parse(window.localStorage.getItem(DRAFT_KEY) || '{}');
    const savedStoryboard = JSON.parse(window.localStorage.getItem(STORYBOARD_KEY) || '{}');
    expect(savedDraft.title).toBe('手机端 ChatGPT 分镜导入');
    expect(savedDraft.targetDurationSeconds).toBe(18);
    expect(savedStoryboard.generationEngine).toBe('chatgpt-import');
    expect(savedStoryboard.shots).toHaveLength(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and shows a clear format error for invalid input', () => {
    render(<GeminiStoryboardDirectorPage />);
    fireEvent.click(screen.getByRole('button', { name: '手动录入分镜' }));
    fireEvent.change(screen.getByLabelText('粘贴分镜内容'), {
      target: { value: '这里不是标准 JSON' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导入并拆分 Shot' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/没有识别到有效的 zaojing.storyboard.v1 JSON/)).toBeTruthy();
    expect(screen.getByTestId('gemini-shot-count').textContent).toBe('0');
  });
});
