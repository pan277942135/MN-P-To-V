// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AutoStoryboardDirectorPage } from '../pages/AutoStoryboardDirectorPage';

const DRAFT_KEY = 'zaojing_director_v01_brief';
const STORYBOARD_KEY = 'zaojing_director_v02_storyboard';
const APPROVAL_KEY = 'zaojing_director_v021_storyboard_approval';

const story = '梅凝连续收到工作拒信。失业后的第七天，她窝在出租屋里用 EVA 材料手搓芙莉莲法杖。雨夜，她拿着粗糙的法杖来到阳台，在雨里幻想自己变成了芙莉莲。最后幻想消失，她又变回穿旧卫衣的梅凝。';

function seedStep1() {
  window.localStorage.setItem(DRAFT_KEY, JSON.stringify({
    version: 'director-brief-v0.1',
    title: '押金扣光的第七天，我在出租屋手搓法杖',
    sourceType: 'outline',
    targetFormat: 'story_short',
    targetDurationSeconds: 30,
    aspectRatio: '9:16',
    creativeBrief: story,
    fullScript: '',
    productionNotes: '真实梅凝与幻想形态要有明确区分。',
    savedAt: 123,
  }));
}

describe('AutoStoryboardDirectorPage Step 2.1', () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedStep1();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('automatically generates a complete editable storyboard without network/provider calls', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<AutoStoryboardDirectorPage />);

    fireEvent.click(screen.getByRole('button', { name: '生成分镜' }));

    const saved = JSON.parse(window.localStorage.getItem(STORYBOARD_KEY) || '{}');
    expect(saved.generationEngine).toBe('local-director-v0.1');
    expect(saved.shots.length).toBeGreaterThanOrEqual(5);
    expect(saved.shots.every((shot: any) => shot.title && shot.scene && shot.action && shot.camera && shot.notes)).toBe(true);
    expect(screen.getByTestId('auto-shot-count').textContent).toBe(String(saved.shots.length));
    expect((screen.getByLabelText('S01 标题') as HTMLInputElement).value.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/系统已自动生成/)).toBeTruthy();
  });

  it('keeps manual edit/reorder/delete controls after automatic generation', () => {
    render(<AutoStoryboardDirectorPage />);
    fireEvent.click(screen.getByRole('button', { name: '生成分镜' }));

    fireEvent.change(screen.getByLabelText('S01 标题'), { target: { value: '导演人工改名' } });
    expect((screen.getByLabelText('S01 标题') as HTMLInputElement).value).toBe('导演人工改名');

    fireEvent.click(screen.getByRole('button', { name: 'S02 上移' }));
    expect((screen.getByLabelText('S02 标题') as HTMLInputElement).value).toBe('导演人工改名');

    const beforeDelete = Number(screen.getByTestId('auto-shot-count').textContent);
    fireEvent.click(screen.getByRole('button', { name: 'S02 删除' }));
    expect(Number(screen.getByTestId('auto-shot-count').textContent)).toBe(beforeDelete - 1);

    fireEvent.click(screen.getByRole('button', { name: '新增镜头' }));
    expect(Number(screen.getByTestId('auto-shot-count').textContent)).toBe(beforeDelete);
  });

  it('warns before regeneration would overwrite human edits', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AutoStoryboardDirectorPage />);
    fireEvent.click(screen.getByRole('button', { name: '生成分镜' }));
    fireEvent.change(screen.getByLabelText('S01 标题'), { target: { value: '保留人工修改' } });

    fireEvent.click(screen.getByRole('button', { name: '重新生成分镜' }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/覆盖当前 Shot List/));
    expect((screen.getByLabelText('S01 标题') as HTMLInputElement).value).toBe('保留人工修改');
  });

  it('requires explicit human confirmation and invalidates PASS after edits', () => {
    render(<AutoStoryboardDirectorPage />);
    fireEvent.click(screen.getByRole('button', { name: '生成分镜' }));
    expect(screen.getByTestId('storyboard-approval-status').textContent).toBe('待确认');

    fireEvent.click(screen.getByRole('button', { name: '确认分镜' }));
    expect(screen.getByTestId('storyboard-approval-status').textContent).toBe('PASS');
    expect(JSON.parse(window.localStorage.getItem(APPROVAL_KEY) || '{}').approvedAt).toEqual(expect.any(Number));

    fireEvent.change(screen.getByLabelText('S01 标题'), { target: { value: '确认后又修改' } });
    expect(screen.getByTestId('storyboard-approval-status').textContent).toBe('待确认');
    expect(window.localStorage.getItem(APPROVAL_KEY)).toBeNull();
  });

  it('restores generated shots after remount', () => {
    const first = render(<AutoStoryboardDirectorPage />);
    fireEvent.click(screen.getByRole('button', { name: '生成分镜' }));
    const saved = JSON.parse(window.localStorage.getItem(STORYBOARD_KEY) || '{}');
    first.unmount();

    render(<AutoStoryboardDirectorPage />);
    expect(screen.getByTestId('auto-shot-count').textContent).toBe(String(saved.shots.length));
    expect((screen.getByLabelText('S01 标题') as HTMLInputElement).value).toBe(saved.shots[0].title);
  });
});
