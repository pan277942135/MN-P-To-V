// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ScriptDirectorPage } from '../pages/ScriptDirectorPage';

const DRAFT_KEY = 'zaojing_director_v01_brief';

describe('ScriptDirectorPage manual Step 1 regression inside Step 2', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('still saves the accepted Step 1 creative brief locally without provider execution', () => {
    render(<ScriptDirectorPage />);

    fireEvent.change(screen.getByLabelText('项目标题 *'), {
      target: { value: '测试短片' },
    });
    fireEvent.change(screen.getByLabelText(/创意 \/ 故事梗概/), {
      target: { value: '一个人工录入、逐环节验收的创意。' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存 Step 1 修改/ }));

    const saved = JSON.parse(window.localStorage.getItem(DRAFT_KEY) || '{}');
    expect(saved).toMatchObject({
      version: 'director-brief-v0.1',
      title: '测试短片',
      creativeBrief: '一个人工录入、逐环节验收的创意。',
      aspectRatio: '9:16',
    });
    expect(saved.savedAt).toEqual(expect.any(Number));
    expect(screen.getByText(/Step 1 草稿已保存/)).toBeTruthy();
  });

  it('restores the accepted Step 1 draft after remount while Step 2 is present', () => {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({
      version: 'director-brief-v0.1',
      title: '恢复测试',
      sourceType: 'script',
      targetFormat: 'story_short',
      targetDurationSeconds: 45,
      aspectRatio: '9:16',
      creativeBrief: '刷新后应恢复。',
      fullScript: '完整脚本文本',
      productionNotes: '人工验收',
      savedAt: 123456789,
    }));

    render(<ScriptDirectorPage />);

    expect((screen.getByLabelText('项目标题 *') as HTMLInputElement).value).toBe('恢复测试');
    expect((screen.getByLabelText(/创意 \/ 故事梗概/) as HTMLTextAreaElement).value).toBe('刷新后应恢复。');
    expect((screen.getByLabelText('完整脚本（可选）') as HTMLTextAreaElement).value).toBe('完整脚本文本');
    expect((screen.getByLabelText('目标总时长（秒）') as HTMLInputElement).value).toBe('45');
  });

  it('keeps Step 1 manual while exposing only manual Step 2 controls', () => {
    render(<ScriptDirectorPage />);
    expect(screen.queryByRole('button', { name: /自动拆镜|生成分镜|生成图片|生成视频|Veo/i })).toBeNull();
    expect(screen.getByRole('button', { name: '新增镜头' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存分镜' })).toBeTruthy();
    expect(screen.getByText('导演台｜人工分镜拆解')).toBeTruthy();
  });
});
