// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VideoBlueprintPage } from '../pages/VideoBlueprintPage';
import { KEYFRAME_BLUEPRINT_KEY, STORYBOARD_KEY } from '../services/director/keyframeBlueprint';
import { KEYFRAME_ASSET_KEY } from '../services/director/keyframeAsset';
import { KEYFRAME_QA_APPROVAL_KEY, KEYFRAME_QA_KEY } from '../services/director/keyframeQa';
import { VIDEO_BLUEPRINT_APPROVAL_KEY, VIDEO_BLUEPRINT_KEY } from '../services/director/videoBlueprint';

function seedStep33Pass() {
  window.localStorage.setItem(STORYBOARD_KEY, JSON.stringify({
    version: 'manual-storyboard-v0.2',
    savedAt: 100,
    shots: [{ uid: 'shot-a', title: '窗边回头', durationSeconds: 5, scene: '教室午后', camera: '中景，缓慢推进', action: '风吹窗帘，女生轻轻回头。', dialogue: '', notes: '' }],
  }));
  window.localStorage.setItem(KEYFRAME_BLUEPRINT_KEY, JSON.stringify({
    version: 'keyframe-blueprint-v0.3.1',
    seriesTitle: '《风从那年教室吹过》系列',
    projectTitle: '第01集',
    sourceStoryboardSavedAt: 100,
    sourceStoryboardApprovedAt: 110,
    blueprints: [{ uid: 'keyframe-shot-a', shotUid: 'shot-a', shotLabel: 'S01', shotTitle: '窗边回头', visualDescription: '', characterReference: '', characterState: '', scene: '教室午后', composition: '中景，缓慢推进', keyMoment: '风吹窗帘，女生轻轻回头。', props: '', lighting: '', continuity: '校服与发型保持一致。', imagePrompt: '', negativePrompt: '' }],
    createdAt: 120,
    savedAt: 130,
  }));
  window.localStorage.setItem(KEYFRAME_ASSET_KEY, JSON.stringify({
    version: 'keyframe-asset-v0.3.2',
    sourceBlueprintSavedAt: 130,
    sourceBlueprintApprovedAt: 135,
    sourceStoryboardSavedAt: 100,
    assets: [{ uid: 'asset-a', shotUid: 'shot-a', shotLabel: 'S01', blueprintUid: 'keyframe-shot-a', blueprintPrompt: '', status: 'PASS', source: 'upload', blobKey: 'blob-a', fileName: 'a.png', mimeType: 'image/png', sizeBytes: 1, characterId: 'char-a', provider: '', model: '', createdAt: 140, approvedAt: 160, qaNote: '' }],
    createdAt: 140,
    savedAt: 160,
  }));
  window.localStorage.setItem(KEYFRAME_QA_KEY, JSON.stringify({
    version: 'keyframe-qa-v0.3.3',
    sourceBlueprintSavedAt: 130,
    items: [{ uid: 'qa-a', shotUid: 'shot-a', shotLabel: 'S01', blueprintUid: 'keyframe-shot-a', assetBlobKey: 'blob-a', previousAssetBlobKey: '', characterId: 'char-a', autoStatus: 'PASS', report: { provider: 'vertex-gemini', model: 'gemini-2.5-flash', analyzedAt: 150, pass: true, identityAssessed: true, continuityAssessed: false, scores: { identityScore: 98, promptComplianceScore: 95, anatomyScore: 96, visualQualityScore: 94, compositionScore: 92, continuityScore: null }, issues: [], warnings: [], summary: 'pass', repairInstruction: '' }, humanDecision: 'APPROVED', humanReviewedAt: 160, humanNote: '' }],
    createdAt: 150,
    savedAt: 160,
  }));
  window.localStorage.setItem(KEYFRAME_QA_APPROVAL_KEY, JSON.stringify({
    version: 'keyframe-qa-approval-v0.3.3',
    approvedAt: 161,
    sourceBlueprintSavedAt: 130,
    itemCount: 1,
    assetSignatures: [{ shotUid: 'shot-a', assetBlobKey: 'blob-a', characterId: 'char-a' }],
  }));
}

describe('VideoBlueprintPage', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => cleanup());

  it('auto creates S01–Sn from current Step 3.3 PASS and normalizes production duration', () => {
    seedStep33Pass();
    render(<VideoBlueprintPage />);
    expect(screen.getByText(/自动创建 1 个 Video Blueprint/)).toBeTruthy();
    expect(screen.getByTestId('video-blueprint-count').textContent).toBe('1');
    expect((screen.getByLabelText('S01 Veo 生产时长') as HTMLSelectElement).value).toBe('6');
    const saved = JSON.parse(window.localStorage.getItem(VIDEO_BLUEPRINT_KEY) || '{}');
    expect(saved.items[0].shotUid).toBe('shot-a');
    expect(saved.items[0].productionDurationSeconds).toBe(6);
  });

  it('saves edits, restores them after remount, and requires explicit human PASS', () => {
    seedStep33Pass();
    const first = render(<VideoBlueprintPage />);
    fireEvent.change(screen.getByLabelText('S01 主体动作'), { target: { value: '女生只做轻微呼吸，窗帘继续摆动。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 Video Blueprint' }));
    expect(screen.getByText(/Step 4.1 已保存：1 个 Video Blueprint/)).toBeTruthy();
    first.unmount();

    render(<VideoBlueprintPage />);
    expect((screen.getByLabelText('S01 主体动作') as HTMLTextAreaElement).value).toBe('女生只做轻微呼吸，窗帘继续摆动。');
    expect(screen.getByTestId('video-blueprint-approval-status').textContent).toContain('待确认');
    fireEvent.click(screen.getByRole('button', { name: '确认 Video Blueprint' }));
    expect(screen.getByTestId('video-blueprint-approval-status').textContent).toContain('PASS');
    expect(window.localStorage.getItem(VIDEO_BLUEPRINT_APPROVAL_KEY)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('S01 连续性约束'), { target: { value: '保持同一教室和人物方向。' } });
    expect(screen.getByTestId('video-blueprint-approval-status').textContent).toContain('待确认');
    expect(window.localStorage.getItem(VIDEO_BLUEPRINT_APPROVAL_KEY)).toBeNull();
  });

  it('stays locked when Step 3.3 has not formed a current PASS', () => {
    render(<VideoBlueprintPage />);
    expect(screen.getByText('Step 4.1 尚未解锁')).toBeTruthy();
    expect(window.localStorage.getItem(VIDEO_BLUEPRINT_KEY)).toBeNull();
  });
});
