import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('shot-centric Director workflow source contract', () => {
  it('exposes Shot List insertion/order and manual keyframe review in primary navigation', () => {
    const sidebar = read('src/components/Sidebar.tsx');
    expect(sidebar).toContain("label: 'Shot List'");
    expect(sidebar).toContain('前插 / 后插 / 调整 order');
    expect(sidebar).toContain("label: '关键帧'");
    expect(sidebar).toContain('人工确认 PASS');
    expect(sidebar).not.toContain("label: '关键帧 QA'");
  });

  it('routes current keyframe/video production through manual per-shot workspaces', () => {
    const app = read('src/App.tsx');
    expect(app).toContain("import { ShotListPage } from './pages/ShotListPage'");
    expect(app).toContain("import { ManualKeyframePage } from './pages/ManualKeyframePage'");
    expect(app).toContain("import { ShotVideoBlueprintPage } from './pages/ShotVideoBlueprintPage'");
    expect(app).not.toContain("import { KeyframeQaPage }");
    expect(app).not.toContain('<KeyframeQaPage />');
  });

  it('does not require aggregate keyframe completion before creating per-shot video blueprints', () => {
    const workflow = read('src/services/director/shotProductionWorkflow.ts');
    expect(workflow).toContain("asset.status !== 'PASS'");
    expect(workflow).toContain('videoItems.push');
    expect(workflow).not.toContain('isKeyframeQaComplete(');
    expect(workflow).not.toContain('isKeyframeQaApprovalCurrent(');
  });
});
