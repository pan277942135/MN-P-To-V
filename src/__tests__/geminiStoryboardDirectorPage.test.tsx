// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GeminiStoryboardDirectorPage } from '../pages/GeminiStoryboardDirectorPage';

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
    productionNotes: '现实与幻想必须明确区分。',
    savedAt: 123,
  }));
}

const geminiShots = [
  {
    uid: 'gemini-test-1',
    title: '连续的工作拒信',
    durationSeconds: 4,
    scene: '出租屋室内',
    action: '手机屏幕连续出现中文工作拒信。',
    camera: '手机极近特写 → 人物中近景',
    dialogue: '失业第七天。',
    notes: '真实梅凝，旧卫衣。',
  },
  {
    uid: 'gemini-test-2',
    title: '开始手搓法杖',
    durationSeconds: 5,
    scene: '出租屋手工作业区',
    action: '梅凝用 EVA 开始制作粗糙法杖。',
    camera: '中景 → 手部特写',
    dialogue: '',
    notes: '保留手作瑕疵。',
  },
  {
    uid: 'gemini-test-3',
    title: '雨夜幻想',
    durationSeconds: 5,
    scene: '雨夜阳台',
    action: '她拿着法杖进入雨幕并幻想自己变身。',
    camera: '中广景',
    dialogue: '',
    notes: '幻想段落。',
  },
  {
    uid: 'gemini-test-4',
    title: '回到现实',
    durationSeconds: 4,
    scene: '雨夜阳台',
    action: '幻想消失，她重新变回穿旧卫衣的梅凝。',
    camera: '中近景固定机位',
    dialogue: '',
    notes: '明确回到现实。',
  },
];

describe('GeminiStoryboardDirectorPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedStep1();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the server Gemini endpoint as the normal Storyboard generation path', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        provider: 'vertex-gemini',
        model: 'gemini-2.5-flash',
        generatedAt: 456,
        shots: geminiShots,
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<GeminiStoryboardDirectorPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Gemini 生成分镜' }));

    await screen.findByText(/Gemini 已生成 4 个 Shot/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/director/storyboard/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Director-Generation-Intent': 'storyboard-v0.2.2',
        }),
      }),
    );

    const saved = JSON.parse(window.localStorage.getItem(STORYBOARD_KEY) || '{}');
    expect(saved.generationEngine).toBe('vertex-gemini');
    expect(saved.generationModel).toBe('gemini-2.5-flash');
    expect(saved.shots).toHaveLength(4);
    expect(screen.getByTestId('generation-engine').textContent).toContain('Vertex Gemini');
    expect((screen.getByLabelText('S04 标题') as HTMLInputElement).value).toBe('回到现实');
  });

  it('does not silently replace a failed Gemini request with local output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({
        ok: false,
        error: 'GEMINI_STORYBOARD_REQUEST_FAILED',
        message: 'Gemini 暂时不可用。',
      }),
    }));

    render(<GeminiStoryboardDirectorPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Gemini 生成分镜' }));

    await screen.findByText(/Gemini 暂时不可用/);
    expect(screen.getByTestId('gemini-shot-count').textContent).toBe('0');
    expect(window.localStorage.getItem(STORYBOARD_KEY)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '使用本地备用拆镜' }));
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(STORYBOARD_KEY) || '{}');
      expect(saved.generationEngine).toBe('local-director-v0.1');
      expect(saved.shots.length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/这不是 Gemini 结果/)).toBeTruthy();
  });

  it('keeps human approval mandatory and invalidates PASS after a shot edit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        provider: 'vertex-gemini',
        model: 'gemini-2.5-flash',
        generatedAt: 456,
        shots: geminiShots,
      }),
    }));

    render(<GeminiStoryboardDirectorPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Gemini 生成分镜' }));
    await screen.findByText(/Gemini 已生成/);

    expect(screen.getByTestId('storyboard-approval-status').textContent).toBe('待确认');
    fireEvent.click(screen.getByRole('button', { name: '确认分镜' }));
    expect(screen.getByTestId('storyboard-approval-status').textContent).toBe('PASS');
    expect(window.localStorage.getItem(APPROVAL_KEY)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('S01 标题'), {
      target: { value: '人工修改后的标题' },
    });
    expect(screen.getByTestId('storyboard-approval-status').textContent).toBe('待确认');
    expect(window.localStorage.getItem(APPROVAL_KEY)).toBeNull();
  });
});
