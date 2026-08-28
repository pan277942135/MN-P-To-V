// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECTOR_CLOUD_EPISODE_ID_KEY,
  DIRECTOR_CLOUD_PROJECT_ID_KEY,
  bootstrapDirectorCloud,
} from '../services/director/directorCloudPersistence';
import {
  CURRENT_SERIES_TITLE,
  DIRECTOR_DRAFT_KEY,
  STORYBOARD_KEY,
} from '../services/director/keyframeBlueprint';

describe('Director cloud client bootstrap', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('migrates an existing local Director project on first cloud bootstrap', async () => {
    window.localStorage.setItem(DIRECTOR_DRAFT_KEY, JSON.stringify({
      version: 'director-brief-v0.1',
      title: 'EP01｜风吹过黑板',
      savedAt: 100,
    }));
    window.localStorage.setItem(STORYBOARD_KEY, JSON.stringify({
      version: 'manual-storyboard-v0.2',
      savedAt: 200,
      shots: [{ uid: 'shot-a', title: '黑板', durationSeconds: 4 }],
    }));

    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({
          ok: true,
          record: { snapshot: body.snapshot, serverUpdatedAt: 300 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

    const result = await bootstrapDirectorCloud();
    expect(result.mode).toBe('migrated');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(DIRECTOR_CLOUD_PROJECT_ID_KEY)).toContain('project-');
    expect(window.localStorage.getItem(DIRECTOR_CLOUD_EPISODE_ID_KEY)).toContain('episode-');
  });

  it('restores the latest Firestore snapshot into a clean browser cache', async () => {
    const cloudSnapshot = {
      schema: 'zaojing.director.cloud.v1',
      projectId: 'project-cloud',
      episodeId: 'episode-cloud',
      seriesTitle: CURRENT_SERIES_TITLE,
      projectTitle: 'EP02｜走廊',
      clientUpdatedAt: 500,
      stages: {
        brief: { version: 'director-brief-v0.1', title: 'EP02｜走廊', savedAt: 400 },
        storyboard: {
          version: 'manual-storyboard-v0.2',
          savedAt: 500,
          shots: [{ uid: 'shot-z', title: '走廊', durationSeconds: 4 }],
        },
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      record: { snapshot: cloudSnapshot, serverUpdatedAt: 600 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await bootstrapDirectorCloud();
    expect(result.mode).toBe('restored');
    expect(JSON.parse(window.localStorage.getItem(DIRECTOR_DRAFT_KEY) || '{}').title).toBe('EP02｜走廊');
    expect(JSON.parse(window.localStorage.getItem(STORYBOARD_KEY) || '{}').shots[0].uid).toBe('shot-z');
    expect(window.localStorage.getItem(DIRECTOR_CLOUD_PROJECT_ID_KEY)).toBe('project-cloud');
  });
});
