import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Director Console source contract', () => {
  it('makes manual creative/script intake the default Director surface while preserving production monitor and single-shot Studio', () => {
    const app = read('src/App.tsx');
    const sidebar = read('src/components/Sidebar.tsx');
    const scriptDirector = read('src/pages/ScriptDirectorPage.tsx');
    const monitor = read('src/pages/DirectorConsolePage.tsx');

    expect(app).toContain("useState<NavTab>('director')");
    expect(app).toContain('<ScriptDirectorPage />');
    expect(app).toContain("activeTab === 'monitor'");
    expect(app).toContain('<DirectorConsolePage />');
    expect(app).toContain('<StudioPage');

    expect(sidebar).toContain("label: '导演台'");
    expect(sidebar).toContain("label: '生产监控'");
    expect(sidebar).toContain("'director' | 'monitor' | 'studio'");

    expect(scriptDirector).toContain('导演台｜创意与脚本录入');
    expect(scriptDirector).toContain('STEP 1 · 可独立验收');
    expect(scriptDirector).toContain('当前不做 AI 拆镜、不生成图片、不调用 Veo，也不自动创建 Episode');

    expect(monitor).toContain('整集导演控制台');
    expect(monitor).toContain('S01–S06 Production Board');
    expect(monitor).toContain('Durable GCS');
    expect(monitor).toContain('Preview 已锁定执行');
  });

  it('deploys the React/Episode server with the formal Dockerfile in a read-only public preview', () => {
    const workflow = read('.github/workflows/director-console-uat-deploy.yml');

    expect(workflow).toContain('docker build -f Dockerfile');
    expect(workflow).not.toContain('Dockerfile.mvp');
    expect(workflow).toContain('PUBLIC_PREVIEW_READ_ONLY=1');
    expect(workflow).toContain('DIRECTOR_PRODUCTION_RUN_ENABLED=0');
    expect(workflow).toContain('P0_DISABLE_STARTUP_RECOVERY=1');
    expect(workflow).toContain('/api/director/capabilities');
  });
});
