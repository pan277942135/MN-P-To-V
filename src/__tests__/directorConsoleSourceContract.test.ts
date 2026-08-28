import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Director Console source contract', () => {
  it('keeps Step 3.3 as the final keyframe PASS gate and adds Step 4.1 video blueprint without Veo execution', () => {
    const app = read('src/App.tsx');
    const sidebar = read('src/components/Sidebar.tsx');
    const geminiDirector = read('src/pages/GeminiStoryboardDirectorPage.tsx');
    const keyframePage = read('src/pages/KeyframeBlueprintPage.tsx');
    const keyframeModel = read('src/services/director/keyframeBlueprint.ts');
    const assetPage = read('src/pages/KeyframeAssetPage.tsx');
    const assetModel = read('src/services/director/keyframeAsset.ts');
    const assetClient = read('src/services/director/geminiKeyframeImageClient.ts');
    const assetServer = read('src/server/services/geminiKeyframeImageService.ts');
    const qaPage = read('src/pages/KeyframeQaPage.tsx');
    const qaModel = read('src/services/director/keyframeQa.ts');
    const qaClient = read('src/services/director/geminiKeyframeQaClient.ts');
    const qaServer = read('src/server/services/geminiKeyframeQaService.ts');
    const videoBlueprintPage = read('src/pages/VideoBlueprintPage.tsx');
    const videoBlueprintModel = read('src/services/director/videoBlueprint.ts');
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
    expect(app).toContain("activeTab === 'keyframe-qa'");
    expect(app).toContain('<KeyframeQaPage />');
    expect(app).toContain("activeTab === 'video-blueprint'");
    expect(app).toContain('<VideoBlueprintPage />');
    expect(app).toContain("activeTab === 'monitor'");
    expect(app).toContain('<DirectorConsolePage />');
    expect(app).toContain('<StudioPage');

    expect(sidebar).toContain("label: '导演台'");
    expect(sidebar).toContain("label: '关键帧蓝图'");
    expect(sidebar).toContain("label: '关键帧图片'");
    expect(sidebar).toContain("label: '关键帧 QA'");
    expect(sidebar).toContain("label: '视频蓝图'");
    expect(sidebar).toContain("label: '生产监控'");
    expect(sidebar).toContain("'director' | 'keyframes' | 'keyframe-assets' | 'keyframe-qa' | 'video-blueprint' | 'monitor' | 'studio'");

    expect(geminiDirector).toContain('导演台｜Script / ChatGPT → Storyboard');
    expect(geminiDirector).toContain('Gemini 生成分镜');
    expect(geminiDirector).toContain('手动录入分镜');
    expect(geminiDirector).toContain('导入并拆分 Shot');
    expect(geminiDirector).toContain('使用本地备用拆镜');
    expect(geminiDirector).toContain('确认分镜');
    expect(geminiDirector).toContain('GEMINI + CHATGPT IMPORT');

    expect(keyframePage).toContain('关键帧蓝图｜Storyboard → Keyframe Blueprint');
    expect(keyframePage).toContain('确认 Keyframe Blueprint');
    expect(keyframePage).toContain('NO IMAGE / NO VEO');
    expect(keyframeModel).toContain("'zaojing_director_v031_keyframe_blueprints'");
    expect(keyframeModel).toContain("'zaojing_director_v031_keyframe_approval'");
    expect(keyframeModel).toContain('shotUid: shot.uid');

    expect(assetPage).toContain('关键帧图片｜生成 / 上传');
    expect(assetPage).toContain('生成关键帧');
    expect(assetPage).toContain('上传 9:16 图片');
    expect(assetPage).toContain('Step 3.2 只负责准备逐镜图片资产');
    expect(assetPage).not.toContain('确认该镜 PASS');
    expect(assetPage).toContain('最终关键帧门禁统一由 Step 3.3');
    expect(assetModel).toContain("'zaojing_director_v032_keyframe_assets'");
    expect(assetModel).toContain('revokeKeyframeAssetPass');
    expect(assetClient).toContain("'/api/director/keyframes/generate'");
    expect(assetServer).toContain("'gemini-3.1-flash-image'");

    expect(qaPage).toContain('关键帧自动 QA｜身份一致性 / 连续性 / 画面质量');
    expect(qaPage).toContain('批量自动 QA');
    expect(qaPage).toContain('人工确认 PASS');
    expect(qaPage).toContain('AUTO QA PASS');
    expect(qaModel).toContain("'zaojing_director_v033_keyframe_qa'");
    expect(qaModel).toContain("item.autoStatus === 'PASS'");
    expect(qaModel).toContain("item.humanDecision === 'APPROVED'");
    expect(qaClient).toContain("'/api/director/keyframes/qa'");
    expect(qaServer).toContain("'gemini-2.5-flash'");
    expect(qaServer).not.toContain('callWithRetry');

    expect(videoBlueprintPage).toContain('视频蓝图｜Keyframe PASS → Video Blueprint');
    expect(videoBlueprintPage).toContain('NO VEO CALL');
    expect(videoBlueprintPage).toContain('保存 Video Blueprint');
    expect(videoBlueprintPage).toContain('确认 Video Blueprint');
    expect(videoBlueprintModel).toContain("'zaojing_director_v041_video_blueprints'");
    expect(videoBlueprintModel).toContain("'zaojing_director_v041_video_blueprint_approval'");
    expect(videoBlueprintModel).toContain('normalizeVeoDuration');
    expect(videoBlueprintModel).toContain("return 'slow_push'");
    expect(videoBlueprintModel).toContain('keyframeQaGateMatchesAssets');
    expect(videoBlueprintModel).toContain('sourceAssetBlobKey');
    expect(videoBlueprintModel).toContain('PromptCompiler.classifyIdentityDriftRisk');
    expect(videoBlueprintModel).not.toContain('generateVideos');
    expect(videoBlueprintModel).not.toContain('predictLongRunning');

    expect(geminiClient).toContain("'/api/director/storyboard/generate'");
    expect(geminiClient).toContain("'X-Director-Generation-Intent'");
    expect(geminiServer).toContain("import { GoogleGenAI } from '@google/genai'");
    expect(geminiServer).toContain('vertexai: true');
    expect(geminiServer).toContain("responseMimeType: 'application/json'");

    expect(chatgptImport).toContain("'zaojing.storyboard.v1'");
    expect(localGenerator).toContain('generateLocalStoryboard');
    expect(autoDirectorCheckpoint).toContain('LOCAL DIRECTOR ENGINE');
    expect(legacyManualDirector).toContain('导演台｜人工分镜拆解');
    expect(monitor).toContain('整集导演控制台');
    expect(monitor).toContain('S01–S06 Production Board');
    expect(monitor).toContain('Durable GCS');
    expect(monitor).toContain('Preview 已锁定执行');
  });

  it('deploys Director UAT while keeping Episode/Veo production disabled and every paid Director call explicit', () => {
    const workflow = read('.github/workflows/director-console-uat-deploy.yml');

    expect(workflow).toContain('docker build -f Dockerfile');
    expect(workflow).not.toContain('Dockerfile.mvp');
    expect(workflow).toContain('PUBLIC_PREVIEW_READ_ONLY=1');
    expect(workflow).toContain('DIRECTOR_PRODUCTION_RUN_ENABLED=0');
    expect(workflow).toContain('DIRECTOR_STORYBOARD_GEMINI_ENABLED=1');
    expect(workflow).toContain('DIRECTOR_KEYFRAME_IMAGE_ENABLED=1');
    expect(workflow).toContain('DIRECTOR_KEYFRAME_QA_ENABLED=1');
    expect(workflow).toContain('P0_DISABLE_STARTUP_RECOVERY=1');
    expect(workflow).toContain('/api/director/capabilities');
    expect(workflow).not.toContain('/api/director/storyboard/generate" | tee');
    expect(workflow).not.toContain('/api/director/keyframes/generate" | tee');
    expect(workflow).not.toContain('/api/director/keyframes/qa" | tee');
    expect(workflow).not.toContain('/api/director/videos/generate" | tee');
  });
});
