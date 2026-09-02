import { describe, expect, it } from 'vitest';
import {
  AiTokenService,
  hashToken,
} from '../server/services/aiDirector/aiTokenService';
import type {
  DirectorAiTokenRecord,
} from '../services/aiDirector/aiDirectorTypes';
import type { DirectorAiTokenRepositoryLike } from '../server/repositories/directorAiTokenRepository';

class MemoryTokenRepository implements DirectorAiTokenRepositoryLike {
  readonly records = new Map<string, DirectorAiTokenRecord>();

  isAvailable(): boolean { return true; }

  async createToken(record: DirectorAiTokenRecord): Promise<DirectorAiTokenRecord> {
    this.records.set(record.tokenId, record);
    return record;
  }

  async getToken(tokenId: string): Promise<DirectorAiTokenRecord | null> {
    return this.records.get(tokenId) || null;
  }

  async findByHash(tokenHash: string): Promise<DirectorAiTokenRecord | null> {
    return [...this.records.values()].find((record) => record.tokenHash === tokenHash) || null;
  }

  async listTokens(projectId: string): Promise<DirectorAiTokenRecord[]> {
    return [...this.records.values()].filter((record) => record.projectId === projectId);
  }

  async revokeToken(tokenId: string): Promise<boolean> {
    const record = this.records.get(tokenId);
    if (!record) return false;
    record.status = 'REVOKED';
    return true;
  }
}

function bindingResolver(projectId = 'project-a') {
  return {
    resolveBinding: async (code: string) => code === 'ZJ-Ab12-3Cd4' ? projectId : null,
  };
}

describe('AiTokenService', () => {
  it('returns the plaintext once while persisting only its SHA-256 hash', async () => {
    const repository = new MemoryTokenRepository();
    const service = new AiTokenService(repository, bindingResolver(), () => Date.parse('2026-09-02T00:00:00.000Z'));

    const created = await service.createToken({
      projectId: 'project-a',
      name: 'ChatGPT Director',
      scope: ['context', 'preview'],
    }, 'ZJ-Ab12-3Cd4');

    expect(created.token).toMatch(/^ZJ-AI-/);
    expect(created.scope).toEqual(['context', 'preview']);
    const stored = repository.records.get(created.tokenId);
    expect(stored?.tokenHash).toBe(hashToken(created.token));
    expect(stored?.tokenHash).not.toBe(created.token);
    expect(stored).not.toHaveProperty('token');

    const authenticated = await service.authenticate(created.token);
    expect(authenticated?.tokenId).toBe(created.tokenId);
    expect(await service.authenticate('ZJ-AI-wrong')).toBeNull();
  });

  it('rejects expired/revoked tokens and prevents cross-project management', async () => {
    const repository = new MemoryTokenRepository();
    let now = Date.parse('2026-09-02T00:00:00.000Z');
    const service = new AiTokenService(repository, bindingResolver(), () => now);
    const created = await service.createToken({
      projectId: 'project-a',
      name: 'Expiring Director',
      scope: ['context'],
      expiresAt: '2026-09-02T00:05:00.000Z',
    }, 'ZJ-Ab12-3Cd4');

    now += 10 * 60 * 1000;
    expect(await service.authenticate(created.token)).toBeNull();

    await expect(service.createToken({ projectId: 'project-b', name: 'Nope', scope: ['context'] }, 'ZJ-Ab12-3Cd4'))
      .rejects.toMatchObject({ code: 'AI_PROJECT_ACCESS_DENIED', statusCode: 403 });

    const active = await service.createToken({ projectId: 'project-a', name: 'Revocable', scope: ['context'] }, 'ZJ-Ab12-3Cd4');
    expect(await service.revokeToken(active.tokenId, 'ZJ-Ab12-3Cd4')).toBe(true);
    expect(await service.authenticate(active.token)).toBeNull();
  });

  it('requires an existing project binding for token administration', async () => {
    const service = new AiTokenService(new MemoryTokenRepository(), bindingResolver(), () => Date.now());

    await expect(service.createToken({ projectId: 'project-a', name: 'Director', scope: ['context'] }, 'bad-code'))
      .rejects.toMatchObject({ code: 'AI_MANAGEMENT_UNAUTHORIZED', statusCode: 401 });
  });
});
