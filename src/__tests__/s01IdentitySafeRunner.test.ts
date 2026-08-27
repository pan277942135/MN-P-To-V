import { describe, expect, it, vi } from 'vitest';
import { S01IdentitySafeRunner } from '../services/episode/s01IdentitySafeRunner';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fileRef = {
  id: 'file_s01',
  name: 's01.png',
  mime_type: 'image/png',
  download_link: 'https://files.oaiusercontent.com/s01.png',
};

const baseInput = {
  openaiFileRef: fileRef,
  idempotencyKey: 'mn-ep001-s01-intent-0001',
  durationSeconds: 4 as const,
};

describe('S01IdentitySafeRunner', () => {
  it('runs preflight -> create -> poll -> artifact without calling paid providers in the test', async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request) => {
      const url = String(rawUrl);
      if (url.endsWith('/v1/images/preflight')) {
        return jsonResponse({ ok: true, status: 'PREFLIGHT_OK' });
      }
      if (url.endsWith('/v1/videos')) {
        return jsonResponse({ ok: true, taskId: 'mvp_s01', status: 'SUBMITTED', providerAttempt: 1 });
      }
      if (url.endsWith('/v1/videos/mvp_s01')) {
        const taskPollCount = fetchMock.mock.calls.filter(([called]) => String(called).endsWith('/v1/videos/mvp_s01')).length;
        if (taskPollCount === 1) {
          return jsonResponse({ taskId: 'mvp_s01', status: 'RUNNING', videoReady: false }, 202);
        }
        return jsonResponse({
          taskId: 'mvp_s01',
          status: 'COMPLETED',
          videoReady: true,
          providerAttempt: 1,
          artifactPersisted: true,
          artifactVerified: true,
          identityReport: { pass: true, averageIdentityScore: 97.2 },
        });
      }
      if (url.endsWith('/v1/videos/mvp_s01/artifact')) {
        return jsonResponse({
          videoUrl: 'https://example.test/play.mp4',
          downloadUrl: 'https://example.test/download.mp4',
          expiresAt: '2026-08-28T00:00:00Z',
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as any;

    const runner = new S01IdentitySafeRunner(
      { gatewayBaseUrl: 'https://gateway.test', pollIntervalMs: 0, maxPolls: 4 },
      { fetchImpl: fetchMock, sleep: async () => undefined }
    );

    const result = await runner.run(baseInput);

    expect(result).toMatchObject({
      episodeId: 'MN-EP001',
      shotId: 'S01',
      taskId: 'mvp_s01',
      status: 'COMPLETED',
      videoUrl: 'https://example.test/play.mp4',
      artifactPersisted: true,
      artifactVerified: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('stops before create when the ChatGPT file bridge preflight fails', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: false, status: 'FILE_BRIDGE_FAILED', error: 'OPENAI_FILE_CONTENT_INVALID' })
    ) as any;

    const runner = new S01IdentitySafeRunner(
      { gatewayBaseUrl: 'https://gateway.test', pollIntervalMs: 0 },
      { fetchImpl: fetchMock, sleep: async () => undefined }
    );

    await expect(runner.run(baseInput)).rejects.toThrow(
      'S01_PREFLIGHT_FAILED:OPENAI_FILE_CONTENT_INVALID'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers a create transport failure through the durable idempotency resolver', async () => {
    let createAttempted = false;
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request) => {
      const url = String(rawUrl);
      if (url.endsWith('/v1/images/preflight')) {
        return jsonResponse({ ok: true, status: 'PREFLIGHT_OK' });
      }
      if (url.endsWith('/v1/videos') && !url.endsWith('/resolve')) {
        createAttempted = true;
        throw new Error('socket reset after durable create');
      }
      if (url.endsWith('/v1/videos/resolve')) {
        expect(createAttempted).toBe(true);
        return jsonResponse({ ok: true, taskId: 'mvp_recovered', status: 'RUNNING' });
      }
      if (url.endsWith('/v1/videos/mvp_recovered')) {
        return jsonResponse({
          taskId: 'mvp_recovered',
          status: 'COMPLETED',
          videoReady: true,
          artifactPersisted: true,
          artifactVerified: true,
        });
      }
      if (url.endsWith('/v1/videos/mvp_recovered/artifact')) {
        return jsonResponse({
          videoUrl: 'https://example.test/recovered.mp4',
          downloadUrl: 'https://example.test/recovered-download.mp4',
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as any;

    const runner = new S01IdentitySafeRunner(
      { gatewayBaseUrl: 'https://gateway.test', pollIntervalMs: 0 },
      { fetchImpl: fetchMock, sleep: async () => undefined }
    );

    const result = await runner.run(baseInput);
    expect(result.taskId).toBe('mvp_recovered');
    expect(result.status).toBe('COMPLETED');
  });

  it('fails closed when the real video task reaches a terminal failure', async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request) => {
      const url = String(rawUrl);
      if (url.endsWith('/v1/images/preflight')) {
        return jsonResponse({ ok: true, status: 'PREFLIGHT_OK' });
      }
      if (url.endsWith('/v1/videos')) {
        return jsonResponse({ ok: true, taskId: 'mvp_failed', status: 'SUBMITTED' });
      }
      if (url.endsWith('/v1/videos/mvp_failed')) {
        return jsonResponse({
          taskId: 'mvp_failed',
          status: 'FAILED',
          error: { code: 'IDENTITY_QA_FAILED' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as any;

    const runner = new S01IdentitySafeRunner(
      { gatewayBaseUrl: 'https://gateway.test', pollIntervalMs: 0 },
      { fetchImpl: fetchMock, sleep: async () => undefined }
    );

    await expect(runner.run(baseInput)).rejects.toThrow('S01_VIDEO_FAILED:FAILED');
  });
});
