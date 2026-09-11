import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const server = fs.readFileSync('server.ts', 'utf8');
const workspace = fs.readFileSync('src/pages/ImageVideoWorkspacePage.tsx', 'utf8');
const studio = fs.readFileSync('src/pages/StudioPage.tsx', 'utf8');
const assets = fs.readFileSync('src/pages/ImageVideoAssetsPage.tsx', 'utf8');

describe('simple image-to-video failure and duplicate-submit UX contract', () => {
  it('uses a client task id and synchronous submission lock', () => {
    expect(workspace).toContain('submissionLockRef');
    expect(workspace).toContain("form.append('taskId', requestTaskId)");
    expect(workspace).toContain('submissionLockRef.current = false');
  });

  it('keeps the legacy studio submission locked until the pipeline is terminal', () => {
    expect(studio).toContain('let pipelineStarted = false;');
    expect(studio).toContain('pipelineStarted = true;');
    expect(studio).toContain('void continueTaskVideoPipeline(');
    expect(studio).toContain('if (!pipelineStarted)');
    expect((studio.match(/safeFetchApi\('\/api\/videos\/start'/g) || []).length).toBe(1);
    expect(studio).not.toContain('isSubmittingRef.current = false;\n      setIsExecuting(false);\n\n      if (onNavigateToHistory)');
  });

  it('uses the dedicated image artifact path and avoids eager count queries in the generator', () => {
    expect(server).toContain('fetchImageArtifactBuffer');
    expect(server).toContain("sourceImageBuffer = await gcsArtifactStore.fetchImageArtifactBuffer");
    expect(server).not.toContain("sourceImageBuffer = await gcsArtifactStore.fetchArtifactBuffer");
    expect(server).toContain('IMAGE_THUMBNAIL_CACHE_TTL_MS = 15 * 60 * 1000');
    expect(server).toContain("private, max-age=900, stale-while-revalidate=60");
    expect(workspace).toContain('includeVideoCounts=false');
    expect(assets).toContain("const query = new URLSearchParams({ limit: '12' });");
    expect(assets).toContain('imageObjectUrlCache');
    expect(assets).toContain('imageObjectUrlInflight');
    expect(assets).toContain('IntersectionObserver');
    expect(assets).toContain("rootMargin: '320px'");
  });

  it('returns detailed failure context with related videos', () => {
    expect(server).toContain('error: record.error || null');
    expect(server).toContain('failureReason: record.failureReason || null');
    expect(server).toContain('structuredError: record.structuredError || null');
  });

  it('renders failure reason and next action instead of a processing placeholder', () => {
    expect(assets).toContain('失败原因：');
    expect(assets).toContain('下一步：');
    expect(assets).toContain('任务处理中…');
    expect(assets).toContain("video.status === 'failed'");
  });

  it('returns and displays the number of videos related to each image', () => {
    expect(server).toContain('videoCount: videoCountByImageId.get(doc.id) || 0');
    expect(assets).toContain('视频 {image.videoCount || 0} 个');
  });
});
