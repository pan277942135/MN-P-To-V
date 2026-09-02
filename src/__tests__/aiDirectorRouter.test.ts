import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createAiDirectorRouter, type AiDirectorServiceLike } from '../server/services/aiDirector/aiDirectorRouter';
import { AiTokenService } from '../server/services/aiDirector/aiTokenService';
import type { AiDirectorContext, AiDirectorShot, AiAssetPreviewResponse, AiReviewPackageResponse, DirectorAiTokenRecord } from '../services/aiDirector/aiDirectorTypes';
import type { DirectorAiTokenRepositoryLike } from '../server/repositories/directorAiTokenRepository';

class MemoryTokenRepository implements DirectorAiTokenRepositoryLike {
  readonly records = new Map<string, DirectorAiTokenRecord>();
  isAvailable(): boolean { return true; }
  async createToken(record: DirectorAiTokenRecord): Promise<DirectorAiTokenRecord> { this.records.set(record.tokenId, record); return record; }
  async getToken(tokenId: string): Promise<DirectorAiTokenRecord | null> { return this.records.get(tokenId) || null; }
  async findByHash(tokenHash: string): Promise<DirectorAiTokenRecord | null> { return [...this.records.values()].find((record) => record.tokenHash === tokenHash) || null; }
  async listTokens(projectId: string): Promise<DirectorAiTokenRecord[]> { return [...this.records.values()].filter((record) => record.projectId === projectId); }
  async revokeToken(tokenId: string): Promise<boolean> {
    const record = this.records.get(tokenId);
    if (!record) return false;
    record.status = 'REVOKED';
    return true;
  }
}

function context(): AiDirectorContext {
  return {
    schema: 'zaojing.ai.context.v1',
    project: {
      projectId: 'project-a',
      title: '风从那年教室吹过',
      creativeBrief: '青春怀旧 AI 漫剧',
      targetFormat: 'story_short',
      aspectRatio: '16:9',
      formatPolicy: { defaultAspectRatio: '16:9', allowedAspectRatios: ['16:9'], allowShotOverride: true },
    },
    episodes: [{ episodeId: 'EP01', title: '她转学来的那天下午', summary: '午休掌机风波。', status: 'REVIEW' }],
    shots: [{ projectId: 'project-a', episodeId: 'EP01', shotUid: 'S03-01', order: 1, title: '吕子豪课本下偷偷玩掌机', storyPurpose: '建立调皮角色', visualRequirement: '课本下的掌机。', camera: '中近景', action: '偷偷玩掌机。', dialogue: '', status: 'VIDEO_REVIEW', blueprint: { shotUid: 'S03-01' }, assets: [] }],
    assets: [],
    assetSummary: { total: 0, images: 0, videos: 0, audio: 0 },
  };
}

const shot: AiDirectorShot & { purpose: string } = {
  projectId: 'project-a',
  episodeId: 'EP01',
  shotUid: 'S03-01',
  order: 1,
  title: '吕子豪课本下偷偷玩掌机',
  storyPurpose: '建立调皮角色',
  purpose: '建立调皮角色',
  visualRequirement: '课本下的掌机。',
  camera: '中近景',
  action: '偷偷玩掌机。',
  dialogue: '',
  status: 'VIDEO_REVIEW',
  blueprint: { shotUid: 'S03-01' },
  assets: [],
};

const preview: AiAssetPreviewResponse = {
  assetId: 'asset-1',
  type: 'IMAGE',
  preview: {
    status: 'READY',
    expiresAt: '2026-09-02T00:15:00.000Z',
    thumbnailUrl: 'https://signed.example.test/thumb',
    mediumUrl: 'https://signed.example.test/medium',
    videoUrl: '',
    videoPreviewUrl: '',
    frames: [],
    frameUrls: [],
    audioUrl: '',
  },
};

function service(): AiDirectorServiceLike {
  return {
    getProjectContext: async () => context(),
    getShotContext: async () => shot,
    getAssetPreview: async () => preview,
    generateReviewPackage: async () => ({
      packageId: 'pkg-1',
      projectId: 'project-a',
      generatedAt: '2026-09-02T00:00:00.000Z',
      expiresAt: '2026-09-02T00:15:00.000Z',
      files: {
        project: { path: 'project.json', url: 'https://signed.example.test/project', contentType: 'application/json' },
        context: { path: 'context.json', url: 'https://signed.example.test/context', contentType: 'application/json' },
        assetManifest: { path: 'asset_manifest.json', url: 'https://signed.example.test/manifest', contentType: 'application/json' },
        contactSheet: { path: 'contact_sheet.jpg', url: 'https://signed.example.test/contact-sheet', contentType: 'image/jpeg' },
        imagePreviews: [],
        videoPreviews: [],
      },
      assetCount: 0,
      previewCount: 0,
    } satisfies AiReviewPackageResponse),
  };
}

function app() {
  const repository = new MemoryTokenRepository();
  const tokenService = new AiTokenService(repository, {
    resolveBinding: async (code: string) => code === 'ZJ-Ab12-3Cd4' ? 'project-a' : null,
  }, () => Date.parse('2026-09-02T00:00:00.000Z'));
  const server = express();
  server.use('/api/ai', createAiDirectorRouter(tokenService, service()));
  return { server, tokenService };
}

async function createToken(scope: string[] = ['context', 'preview', 'review_package']) {
  const target = app();
  const response = await request(target.server)
    .post('/api/ai/tokens')
    .set('X-Director-Binding-Code', 'ZJ-Ab12-3Cd4')
    .send({ projectId: 'project-a', name: 'Test AI', scope });
  return { ...target, response };
}

describe('AI Director Gateway', () => {
  it('requires Bearer authentication and applies scope checks', async () => {
    const target = app();
    const missing = await request(target.server).get('/api/ai/projects/project-a/context');
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');

    const wrong = await request(target.server).get('/api/ai/projects/project-a/context').set('Authorization', 'Bearer wrong');
    expect(wrong.status).toBe(401);

    const contextToken = await createToken(['context']);
    expect(contextToken.response.status).toBe(201);
    const forbiddenPreview = await request(contextToken.server)
      .get('/api/ai/assets/asset-1/preview')
      .set('Authorization', `Bearer ${contextToken.response.body.token}`);
    expect(forbiddenPreview.status).toBe(403);
    expect(forbiddenPreview.body.error).toBe('AI_SCOPE_REQUIRED');
  });

  it('returns project/shot context only for the token project', async () => {
    const target = await createToken(['context']);
    const project = await request(target.server)
      .get('/api/ai/projects/project-a/context')
      .set('Authorization', `Bearer ${target.response.body.token}`);
    expect(project.status).toBe(200);
    expect(project.body.schema).toBe('zaojing.ai.context.v1');
    expect(project.body.project.title).toBe('风从那年教室吹过');

    const shotResponse = await request(target.server)
      .get('/api/ai/shots/S03-01/context')
      .set('Authorization', `Bearer ${target.response.body.token}`);
    expect(shotResponse.status).toBe(200);
    expect(shotResponse.body).toMatchObject({ shotUid: 'S03-01', purpose: '建立调皮角色' });

    const denied = await request(target.server)
      .get('/api/ai/projects/project-b/context')
      .set('Authorization', `Bearer ${target.response.body.token}`);
    expect(denied.status).toBe(403);
  });

  it('returns signed previews and review packages only with their scopes', async () => {
    const target = await createToken(['context', 'preview', 'review_package']);
    const previewResponse = await request(target.server)
      .get('/api/ai/assets/asset-1/preview')
      .set('Authorization', `Bearer ${target.response.body.token}`);
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.body.preview.mediumUrl).toContain('https://signed.example.test');
    expect(JSON.stringify(previewResponse.body)).not.toContain('gs://');

    const packageResponse = await request(target.server)
      .post('/api/ai/projects/project-a/review-package')
      .set('Authorization', `Bearer ${target.response.body.token}`)
      .send({});
    expect(packageResponse.status).toBe(200);
    expect(packageResponse.body.files.context.path).toBe('context.json');
  });

  it('uses an existing binding code to create/list/revoke tokens without exposing hashes', async () => {
    const target = app();
    const created = await request(target.server)
      .post('/api/ai/tokens')
      .set('X-Director-Binding-Code', 'ZJ-Ab12-3Cd4')
      .send({ projectId: 'project-a', name: 'Manage me', scope: ['context'] });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^ZJ-AI-/);

    const list = await request(target.server)
      .get('/api/ai/tokens?projectId=project-a')
      .set('X-Director-Binding-Code', 'ZJ-Ab12-3Cd4');
    expect(list.status).toBe(200);
    expect(list.body.tokens[0]).not.toHaveProperty('tokenHash');
    expect(list.body.tokens[0]).not.toHaveProperty('token');

    const revoked = await request(target.server)
      .delete(`/api/ai/tokens/${created.body.tokenId}`)
      .set('X-Director-Binding-Code', 'ZJ-Ab12-3Cd4');
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('REVOKED');
  });
});
