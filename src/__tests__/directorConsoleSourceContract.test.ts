import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Director Console source contract', () => {
  it('makes Vertex Gemini Script → Storyboard the Director surface while preserving local/manual fallback and production monitor', () => {
    const app = read('src/App.tsx');
    const sidebar = read('src/components/Sidebar.tsx');
    const geminiDirector = read('src/pages/GeminiStoryboardDirectorPage.tsx');
    const geminiClient = read('src/services/director/geminiStoryboardClient.ts');
    const geminiServer = read('src/server/services/geminiStoryboardService.ts');
    const localGenerator = read('src/services/director/localStoryboardGenerator.ts');
    const autoDirectorCheckpoint = read('src/pages/AutoStoryboardDirectorPage.tsx');
    const legacyManualDirector = read('src/pages/ScriptDirectorPage.tsx');
    const monitor = read('src/pages/DirectorConsolePage.tsx');

    expect(app).toContain("useState<NavTab>('director')");
    expect(app).toContain('<GeminiStoryboardDirectorPage />');
    expect(app).toContain("activeTab === 'monitor'");
    expect(app).toContain('<DirectorConsolePage />');
    expect(app).toContain('<StudioPage');

    expect(sidebar).toContain("label: '导演台'");
    expect(sidebar).toContain("label: '生产监控'");
    expect(sidebar).toContain("'director' | 'monitor' | 'studio'");

    expect(geminiDirector).toContain('导演台｜Gemini Script → Storyboard');
    expect(geminiDirector).toContain('Gemini 生成分镜');
    expect(geminiDirector).toContain('使用本地备用拆镜');
    expect(geminiDirector).toContain('确认分镜');
    expect(geminiDirector).toContain('GEMINI DIRECTOR');
    expect(geminiDirector).toContain("const DRAFT_KEY = 'zaojing_director_v01_brief'");
    expect(geminiDirector).toContain("const STORYBOARD_KEY = 'zaojing_director_v02_storyboard'");
    expect(geminiDirector).toContain('保存分镜修改');

    expect(geminiClient).toContain("'/api/director/storyboard/generate'");
    expect(geminiClient).toContain("'X-Director-Generation-Intent'");
    expect(geminiServer).toContain("import { GoogleGenAI } from '@google/genai'");
    expect(geminiServer).toContain('vertexai: true');
    expect(geminiServer).toContain("responseMimeType: 'application/json'");
    expect(geminiServer).toContain('responseJsonSchema');
    expect(localGenerator).toContain('generateLocalStoryboard');

    expect(autoDirectorCheckpoint).toContain('LOCAL DIRECTOR ENGINE');
    expect(legacyManualDirector).toContain('导演台｜人工分镜拆解');
    expect(monitor).toContain('整集导演控制台');
    expect(monitor).toContain('S01–S06 Production Board');
    expect(monitor).toContain('Durable GCS');
    expect(monitor).toContain('Preview 已锁定执行');
  });

  it('deploys Gemini Storyboard while keeping Episode/Veo production disabled in public preview', () => {
    const workflow = read('.github/workflows/director-console-uat-deploy.yml');

    expect(workflow).toContain('docker build -f Dockerfile');
    expect(workflow).not.toContain('Dockerfile.mvp');
    expect(workflow).toContain('PUBLIC_PREVIEW_READ_ONLY=1');
    expect(workflow).toContain('DIRECTOR_PRODUCTION_RUN_ENABLED=0');
    expect(workflow).toContain('DIRECTOR_STORYBOARD_GEMINI_ENABLED=1');
    expect(workflow).toContain('DIRECTOR_STORYBOARD_MODEL=gemini-2.5-flash');
    expect(workflow).toContain('P0_DISABLE_STARTUP_RECOVERY=1');
    expect(workflow).toContain('/api/director/capabilities');
    expect(workflow).not.toContain('/api/director/storyboard/generate" | tee');
  });
});
