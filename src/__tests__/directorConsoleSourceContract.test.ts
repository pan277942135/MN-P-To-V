import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Director Console source contract', () => {
  it('uses a Shot-centric non-linear workflow with manual keyframe review and per-shot video blueprint readiness', () => {
    const app = read('src/App.tsx');
    const sidebar = read('src/components/Sidebar.tsx');
    const geminiDirector = read('src/pages/GeminiStoryboardDirectorPage.tsx');
    const shotList = read('src/pages/ShotListPage.tsx');
    const shotOrder = read('src/services/director/storyboardShotOrder.ts');
    const manualKeyframes = read('src/pages/ManualKeyframePage.tsx');
    const shotVideos = read('src/pages/ShotVideoBlueprintPage.tsx');
    const shotWorkflow = read('src/services/director/shotProductionWorkflow.ts');
    const assetModel = read('src/services/director/keyframeAsset.ts');
    const assetClient = read('src/services/director/geminiKeyframeImageClient.ts');
    const assetServer = read('src/server/services/geminiKeyframeImageService.ts');
    const geminiClient = read('src/services/director/geminiStoryboardClient.ts');
    const geminiServer = read('src/server/services/geminiStoryboardService.ts');
    const chatgptImport = read('src/services/director/chatgptStoryboardImport.ts');
    const localGenerator = read('src/services/director/localStoryboardGenerator.ts');
    const monitor = read('src/pages/DirectorConsolePage.tsx');

    expect(app).toContain("useState<NavTab>('director')");
    expect(app).toContain('<GeminiStoryboardDirectorPage />');
    expect(app).toContain("activeTab === 'shot-list'");
    expect(app).toContain('<ShotListPage />');
    expect(app).toContain("activeTab === 'keyframe-assets'");
    expect(app).toContain('<ManualKeyframePage />');
    expect(app).toContain("activeTab === 'video-blueprint'");
    expect(app).toContain('<ShotVideoBlueprintPage />');
    expect(app).not.toContain('<KeyframeQaPage />');
    expect(app).toContain("activeTab === 'monitor'");
    expect(app).toContain('<DirectorConsolePage />');
    expect(app).toContain('<StudioPage');

    expect(sidebar).toContain("label: '导演台'");
    expect(sidebar).toContain("label: 'Shot List'");
    expect(sidebar).toContain('前插 / 后插 / 调整 order');
    expect(sidebar).toContain("label: '关键帧'");
    expect(sidebar).toContain('人工确认 PASS');
    expect(sidebar).not.toContain("label: '关键帧 QA'");
    expect(sidebar).toContain("label: '视频蓝图'");
    expect(sidebar).toContain("label: '生产监控'");

    expect(geminiDirector).toContain('导演台｜Script / ChatGPT → Storyboard');
    expect(geminiDirector).toContain('Gemini 生成分镜');
    expect(geminiDirector).toContain('手动录入分镜');
    expect(geminiDirector).toContain('导入并拆分 Shot');

    expect(shotList).toContain('Shot List｜编排 / 插入 / 调整 Order');
    expect(shotList).toContain('前插');
    expect(shotList).toContain('后插');
    expect(shotList).toContain('ORDER');
    expect(shotList).toContain('shot.uid');
    expect(shotOrder).toContain('insertStoryboardShot');
    expect(shotOrder).toContain('moveStoryboardShotToOrder');

    expect(manualKeyframes).toContain('关键帧｜生成 / 上传 / 人工确认');
    expect(manualKeyframes).toContain('人工确认 PASS');
    expect(manualKeyframes).toContain('系统不会自动 QA');
    expect(manualKeyframes).toContain('不等待其他关键帧');
    expect(manualKeyframes).not.toContain('runKeyframeQa');
    expect(assetModel).toContain('approveKeyframeAsset');
    expect(assetModel).toContain('revokeKeyframeAssetPass');
    expect(assetClient).toContain("'/api/director/keyframes/generate'");
    expect(assetServer).toContain("'gemini-3.1-flash-image'");

    expect(shotVideos).toContain('视频蓝图｜逐 Shot 并行准备');
    expect(shotVideos).toContain('不再等待“全量关键帧 PASS”');
    expect(shotVideos).toContain('NO VEO CALL');
    expect(shotVideos).toContain('确认本镜 Video Blueprint');
    expect(shotWorkflow).toContain("asset.status !== 'PASS'");
    expect(shotWorkflow).toContain("status: 'DRAFT'");
    expect(shotWorkflow).toContain('sourcePreviousShotUid');
    expect(shotWorkflow).not.toContain('isKeyframeQaComplete(');
    expect(shotWorkflow).not.toContain('isKeyframeQaApprovalCurrent(');

    expect(geminiClient).toContain("'/api/director/storyboard/generate'");
    expect(geminiClient).toContain("'X-Director-Generation-Intent'");
    expect(geminiServer).toContain("import { GoogleGenAI } from '@google/genai'");
    expect(geminiServer).toContain('vertexai: true');
    expect(geminiServer).toContain("responseMimeType: 'application/json'");

    expect(chatgptImport).toContain("'zaojing.storyboard.v1'");
    expect(localGenerator).toContain('generateLocalStoryboard');
    expect(monitor).toContain('整集导演控制台');
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
    // Automatic keyframe QA is not part of the active UI flow. The dormant backend
    // capability may remain available for a future explicit opt-in, but deploy smoke
    // must never invoke it or any other paid Director provider.
    expect(workflow).toContain('P0_DISABLE_STARTUP_RECOVERY=1');
    expect(workflow).toContain('/api/director/capabilities');
    expect(workflow).not.toContain('/api/director/storyboard/generate" | tee');
    expect(workflow).not.toContain('/api/director/keyframes/generate" | tee');
    expect(workflow).not.toContain('/api/director/keyframes/qa" | tee');
    expect(workflow).not.toContain('/api/director/videos/generate" | tee');
  });
});
