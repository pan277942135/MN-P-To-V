import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Step 4.0.3-C Project Session source contract', () => {
  it('mounts the unified session endpoint without changing the binding contract', () => {
    const server = read('director-server.ts');
    const router = read('src/server/services/projectSessionRouter.ts');
    const client = read('src/services/director/projectSessionClient.ts');
    const provider = read('src/context/ProjectSessionContext.tsx');
    const panel = read('src/components/ProjectBindingPanel.tsx');

    expect(server).toContain("app.use('/api/director/project-session'");
    expect(router).toContain("router.get('/:projectId'");
    expect(router).toContain('getRestoreBundle');
    expect(router).toContain('syncProjectAssets');
    expect(router).toContain('getEpisodeContext');
    expect(client).toContain('/api/director/project-session/');
    expect(provider).toContain('ProjectSessionProvider');
    expect(provider).toContain('useDirectorCloud');
    expect(provider).toContain('applyDirectorCloudSnapshot');
    expect(provider).toContain('syncLocalShotPipeline');
    expect(panel).toContain('useProjectSession');
    expect(panel).toContain('最近项目');
    expect(panel).toContain('打开');
    expect(panel).toContain('清空历史');
  });

  it('keeps browser history limited to binding shortcut metadata', () => {
    const history = read('src/services/director/projectBindingHistory.ts');
    expect(history).toContain('PROJECT_BINDING_HISTORY_KEY');
    expect(history).toContain('bindingCode');
    expect(history).toContain('projectId');
    expect(history).toContain('projectTitle');
    expect(history).toContain('lastOpenedAt');
    expect(history).not.toContain('keyframeAssetStore');
    expect(history).not.toContain('director_assets');
  });

  it('routes Keyframe and Video display through the session Registry projection', () => {
    const keyframes = read('src/pages/ManualKeyframePage.tsx');
    const videos = read('src/pages/ShotVideoBlueprintPage.tsx');
    const library = read('src/pages/AssetLibraryPage.tsx');
    const summary = read('src/components/ProjectAssetSummary.tsx');
    expect(keyframes).toContain('useProjectSession');
    expect(keyframes).toContain("asset.mediaType === 'KEYFRAME'");
    expect(keyframes).toContain('sessionEpisodeId');
    expect(keyframes).toContain("assetPreviewContentUrl(registryAsset.assetId, 'original')");
    expect(videos).toContain('useProjectSession');
    expect(videos).toContain("asset.mediaType === 'GENERATED_VIDEO'");
    expect(videos).toContain('sessionEpisodeId');
    expect(videos).toContain('generated-video-assets');
    expect(keyframes).toContain('syncLocalChanges');
    expect(library).toContain('sessionAssets');
    expect(library).not.toContain('listProjectAssets');
    expect(summary).toContain('sessionAssets');
    expect(summary).not.toContain('listProjectAssets');
  });
});
