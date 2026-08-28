// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ManualStoryboardImportEntry } from '../components/director/ManualStoryboardImportEntry';

const STORYBOARD_KEY = 'zaojing_director_v02_storyboard';
const APPROVAL_KEY = 'zaojing_director_v021_storyboard_approval';

const payload = JSON.stringify({
  projectTitle: '001：押金扣光的第七天',
  shots: [
    {
      title: '拒信特写',
      durationSeconds: 4,
      scene: '出租屋室内',
      camera: '手机极近特写',
      action: '手机屏幕出现中文拒信。',
      dialogue: '失业第七天。',
      notes: '真实梅凝，旧卫衣。',
    },
    {
      title: '雨夜回归现实',
      durationSeconds: 4,
      scene: '雨夜阳台',
      camera: '中近景固定机位',
      action: '幻想消失，梅凝回到真实状态。',
      dialogue: '',
      notes: '明确回到现实。',
    },
  ],
});

describe('ManualStoryboardImportEntry', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens a dialog with the required ChatGPT format beside the paste area', () => {
    render(<ManualStoryboardImportEntry onImported={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '手动录入分镜' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('要求格式')).toBeTruthy();
    expect(screen.getByText(/根对象必须包含 shots 数组/)).toBeTruthy();
    expect(screen.getByLabelText('粘贴完整分镜')).toBeTruthy();
  });

  it('imports one pasted payload and splits it into multiple Shots without Gemini', () => {
    const onImported = vi.fn();
    window.localStorage.setItem(APPROVAL_KEY, JSON.stringify({ approvedAt: 123 }));

    render(<ManualStoryboardImportEntry onImported={onImported} />);
    fireEvent.click(screen.getByRole('button', { name: '手动录入分镜' }));
    fireEvent.change(screen.getByLabelText('粘贴完整分镜'), {
      target: { value: payload },
    });
    fireEvent.click(screen.getByRole('button', { name: '导入并拆分 Shot' }));

    const saved = JSON.parse(window.localStorage.getItem(STORYBOARD_KEY) || '{}');
    expect(saved.generationEngine).toBe('manual');
    expect(saved.generationModel).toBe('chatgpt-manual-import-v0.1');
    expect(saved.shots).toHaveLength(2);
    expect(saved.shots[1].title).toBe('雨夜回归现实');
    expect(window.localStorage.getItem(APPROVAL_KEY)).toBeNull();
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a field-level error and keeps the dialog open for invalid input', () => {
    render(<ManualStoryboardImportEntry onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '手动录入分镜' }));
    fireEvent.change(screen.getByLabelText('粘贴完整分镜'), {
      target: {
        value: JSON.stringify({
          shots: [{
            title: '坏镜头',
            durationSeconds: 4,
            scene: '室内',
            camera: '',
            action: '动作',
            dialogue: '',
            notes: '',
          }],
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '导入并拆分 Shot' }));

    expect(screen.getByText('第 1 个 Shot 缺少 camera（镜头语言）。')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
