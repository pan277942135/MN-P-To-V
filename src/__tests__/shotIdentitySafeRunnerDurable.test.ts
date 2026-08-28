import { describe, expect, it, vi } from 'vitest';
import {
  ShotIdentitySafeRunner,
  type ApprovedKeyframeInput,
} from '../services/episode/shotIdentitySafeRunner';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ShotIdentitySafeRunner durable keyframe path P0-7', () => {
  it('uploads the verified durable bytes through the internal gateway route without conversation preflight', async () => {
    const keyframeInput: ApprovedKeyframeInput = {
      source: 'durable_gcs_asset',
      buffer: PNG,
      mimeType: 'image/png',
      fileName: 'S02-keyframe-v1.png',
      assetId: 'kf_MN-EP001_S02_v1_test',
      contentSha256: 'a'.repeat(64),
      version: 1,
      outputBucket: 'ai-studio-bucket-89614354864-asia-south1',
      outputObjectPath: 'episodes/MN-EP001/shots/S02/keyframes/v1_test.png',
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/v1/videos/durable')) {
        return jsonResponse({
          ok: true,
          taskId: 'task_s02_001',
          status: 'COMPLETED',
          videoReady: true,
          providerAttempt: 1,
          artifactPersisted: true,
          artifactVerified: true,
        });
      }
      if (url.endsWith('/v1/videos/task_s02_001/artifact')) {
        return jsonResponse({
          ok: true,
          videoUrl: 'https://example.test/S02.mp4',
          downloadUrl: 'https://example.test/S02-download.mp4',
          expiresAt: null,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const runner = new ShotIdentitySafeRunner(
      { gatewayBaseUrl: 'https://gateway.example.test', pollIntervalMs: 0, maxPolls: 1 },
      { fetchImpl },
    );

    const result = await runner.run({
      episodeId: 'MN-EP001',
      shotId: 'S02',
      keyframeInput,
      idempotencyKey: 'mn-ep001-s02-intent-0001',
      durationSeconds: 4,
      prompt: 'stable shot',
    });

    expect(result).toMatchObject({ taskId: 'task_s02_001', status: 'COMPLETED' });
    expect(requests.map((request) => request.url)).toEqual([
      'https://gateway.example.test/v1/videos/durable',
      'https://gateway.example.test/v1/videos/task_s02_001/artifact',
    ]);
    const createBody = requests[0].init?.body;
    expect(createBody).toBeInstanceOf(FormData);
    const form = createBody as FormData;
    expect(form.get('inputSource')).toBe('durable_gcs_asset');
    expect(form.get('assetId')).toBe(keyframeInput.assetId);
    expect(form.get('contentSha256')).toBe(keyframeInput.contentSha256);
    expect(form.get('keyframeVersion')).toBe('1');
  });
});
