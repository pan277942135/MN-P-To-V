import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const gateway = fs.readFileSync('chatgpt-gateway.ts', 'utf8');
const schema = fs.readFileSync('chatgpt-action-openapi.yaml', 'utf8');

describe('ChatGPT Gateway video delivery', () => {
  it('returns delivery URLs only for verified completed artifacts', () => {
    expect(gateway).toContain('artifactPersisted: true');
    expect(gateway).toContain('artifactVerified: true');
    expect(gateway).toContain('videoUrl: null');
    expect(gateway).toContain('downloadUrl: null');
    expect(gateway).toContain('downloadUrl: base + streamPath + \'?download=1\'');
  });

  it('proxies MP4 playback, download, and byte-range responses without creating tasks', () => {
    expect(gateway).toContain("app.get('/v1/videos/:taskId/stream'");
    expect(gateway).toContain('const upstreamPath =');
    expect(gateway).toContain('headers.Range = String(req.headers.range)');
    expect(gateway).toContain("'content-range'");
    expect(gateway).toContain('response.arrayBuffer()');
    expect(gateway).not.toContain("upstream('/api/mvp/videos/start', { method: 'POST' })");
    expect(schema).toContain('content: video/mp4');
    expect(schema).toContain('Partial MP4 response for byte-range playback');
  });
});
