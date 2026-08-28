import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Director Console source contract', () => {
  it('keeps Storyboard and Step 3.1 while adding gated Step 3.2 keyframe images and preserving production monitor', () => {
    const app = read('src/App.tsx');
    const sidebar = read('src/components/Sidebar.tsx');
    const geminiDirector = read('src/pages/GeminiStoryboardDirectorPage.tsx');
    const keyframePage = read('src/pages/KeyframeBlueprintPage.tsx');
    const keyframeModel = read('src/services/director/keyframeBlueprint.ts');
    const assetPage = read('src/pages/KeyframeAssetPage.tsx');
    const assetModel = read('src/services/director/keyframeAsset.ts');
    const assetClient = read('src/services/director/geminiKeyframeImageClient.ts');
    const assetServer = read('src/server/services/geminiKeyframeImageService.ts');
    const geminiClient = read('src/services/director/geminiStoryboardClient.ts');
    const geminiServer = read('src/server/services/geminiStoryboardService.ts');
    const chatgptImport = read('src/services/director/chatgptStoryboardImport.ts');
    const localGenerator = read('src/services/director/localStoryboardGenerator.ts');
    const autoDirectorCheckpoint = read('src/pages/AutoStoryboardDirectorPage.tsx');
    const legacyManualDirector = read('src/pages/ScriptDirectorPage.tsx');
    const monitor = read('src/pages/DirectorConsolePage.tsx');

    expect(app).toContain("useState<NavTab>('director')");
    expect(app).toContain('<GeminiStoryboardDirectorPage />');
    expect(app).toContain("activeTab === 'keyframes'");
    expect(app).toContain('<KeyframeBlueprintPage />');
    expect(app).toContain("activeTab === 'keyframe-assets'");
    expect(app).toContain('<KeyframeAssetPage />');
    expect(app).toContain("activeTab === 'monitor'");
    expect(app).toContain('<DirectorConsolePage />');
    expect(app).toContain('<StudioPage');

    expect(sidebar).toContain("label: '导演台'");
    expect(sidebar).toContain("label: '关键帧蓝图'");
    expect(sidebar).toContain("label: '关键帧图片'");
    expect(sidebar).toContain("label: '生产监控'");
    expect(sidebar).toContain("'director' | 'keyframes' | 'keyframe-assets' | 'monitor' | 'studio'");

    expect(geminiDirector).toContain('导演台｜Script / ChatGPT → Storyboard');
    expect(geminiDirector).toContain('Gemini 生成分镜');
    expect(geminiDirector).toContain('手动录入分镜');
    expect(geminiDirector).toContain('导入并拆分 Shot');
    expect(geminiDirector).toContain('使用本地备用拆镜');
    expect(geminiDirector).toContain('确认分镜');
    expect(geminiDirector).toContain('GEMINI + CHATGPT IMPORT');
    expect(geminiDirector).toContain("const DRAFT_KEY = 'zaojing_director_v01_brief'");
    expect(geminiDirector).toContain("const STORYBOARD_KEY = 'zaojing_director_v02_storyboard'");
    expect(geminiDirector).toContain('保存分镜修改');

    expect(keyframePage).toContain('关键帧蓝图｜Storyboard → Keyframe Blueprint');
    expect(keyframePage).toContain('确认 Keyframe Blueprint');
    expect(keyframePage).toContain('保存 Blueprint 修改');
    expect(keyframePage).toContain('NO IMAGE / NO VEO');
    expect(keyframeModel).toContain("'zaojing_director_v031_keyframe_blueprints'");
    expect(keyframeModel).toContain("'zaojing_director_v031_keyframe_approval'");
    expect(keyframeModel).toContain('《风从那年教室吹过》系列');
    expect(keyframeModel).toContain('shotUid: shot.uid');

    expect(assetPage).toContain('关键帧图片｜生成 / 上传 / 人工确认');
    expect(assetPage).toContain('生成关键帧');
    expect(assetPage).toContain('上传 9:16 图片');
    expect(assetPage).toContain('确认该镜 PASS');
    expect(assetModel).toContain("'zaojing_director_v032_keyframe_assets'");
    expect(assetModel).toContain("'zaojing_director_v032_keyframe_asset_approval'");
    expect(assetClient).toContain("'/api/director/keyframes/generate'");
    expect(assetClient).toContain("'keyframe-image-v0.3.2'");
    expect(assetServer).toContain("'gemini-3.1-flash-image'");
    expect(assetServer).toContain("aspectRatio: input.aspectRatio");

    expect(geminiClient).toContain("'/api/director/storyboard/generate'");
    expect(geminiClient).toContain("'X-Director-Generation-Intent'");
    expect(geminiServer).toContain("import { GoogleGenAI } from '@google/genai'");
    expect(geminiServer).toContain('vertexai: true');
    expect(geminiServer).toContain("responseMimeType: 'application/json'");
    expect(geminiServer).toContain('responseJsonSchema');

    expect(chatgptImport).toContain("'zaojing.storyboard.v1'");
    expect(chatgptImport).toContain('parseChatGPTStoryboardImport');
    expect(chatgptImport).toContain('CHATGPT_STORYBOARD_OUTPUT_INSTRUCTION');
    expect(localGenerator).toContain('generateLocalStoryboard');

    expect(autoDirectorCheckpoint).toContain('LOCAL DIRECTOR ENGINE');
    expect(legacyManualDirector).toContain('导演台｜人工分镜拆解');
    expect(monitor).toContain('整集导演控制台');
    expect(monitor).toContain('S01–S06 Production Board');
    expect(monitor).toContain('Durable GCS');
    expect(monitor).toContain('Preview 已锁定执行');
  });

  it('deploys Director UAT while keeping Episode/Veo production disabled and paid image generation explicit', () => {
    const workflow = read('.github/workflows/director-console-uat-deploy.yml');

    expect(workflow).toContain('docker build -f Dockerfile');
    expect(workflow).not.toContain('Dockerfile.mvp');
    expect(workflow).toContain('PUBLIC_PREVIEW_READ_ONLY=1');
    expect(workflow).toContain('DIRECTOR_PRODUCTION_RUN_ENABLED=0');
    expect(workflow).toContain('DIRECTOR_STORYBOARD_GEMINI_ENABLED=1');
    expect(workflow).toContain('DIRECTOR_STORYBOARD_MODEL: gemini-2.5-flash');
    expect(workflow).toContain('DIRECTOR_STORYBOARD_MODEL=$DIRECTOR_STORYBOARD_MODEL');
    expect(workflow).toContain('DIRECTOR_KEYFRAME_IMAGE_ENABLED=1');
    expect(workflow).toContain('DIRECTOR_KEYFRAME_IMAGE_MODEL: gemini-3.1-flash-image');
    expect(workflow).toContain('DIRECTOR_KEYFRAME_IMAGE_LOCATION: global');
    expect(workflow).toContain('P0_DISABLE_STARTUP_RECOVERY=1');
    expect(workflow).toContain('/api/director/capabilities');
    expect(workflow).not.toContain('/api/director/storyboard/generate" | tee');
    expect(workflow).not.toContain('/api/director/keyframes/generate" | tee');
  });
});