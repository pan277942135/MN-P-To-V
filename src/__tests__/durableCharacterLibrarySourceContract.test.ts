import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const serverSource = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
const clientRepoSource = fs.readFileSync(path.join(root, 'src/repositories/characterRepository.ts'), 'utf8');
const durableRepoSource = fs.readFileSync(path.join(root, 'src/server/repositories/firestoreCharacterRepository.ts'), 'utf8');
const durableServiceSource = fs.readFileSync(path.join(root, 'src/server/services/durableCharacterService.ts'), 'utf8');

describe('durable character library contract', () => {
  it('uses Firestore metadata and GCS artifacts as server authority', () => {
    expect(serverSource).toContain("import { durableCharacterService }");
    expect(serverSource).toContain('Durable Character Library: Firestore metadata + GCS master-image authority.');
    expect(serverSource).toContain('durableCharacterService.listMetadata()');
    expect(serverSource).toContain('durableCharacterService.save({');
    expect(serverSource).toContain("artifactAuthority: 'gcs'");
    expect(durableRepoSource).toContain("collectionName = 'characters'");
    expect(durableServiceSource).toContain('characters/${params.id}/masters/');
  });

  it('keeps the process character store as cache only, never local-disk startup authority', () => {
    expect(serverSource).toContain('const serverCharacterStore = new Map<string, ServerCharacter>();');
    expect(serverSource).not.toContain('const serverCharacterStore = loadCharactersFromDisk();');
  });

  it('streams master images from GCS instead of embedding them in Firestore documents', () => {
    expect(serverSource).toContain("'/api/characters/:id/reference/:referenceId'");
    expect(serverSource).toContain('durableCharacterService.getReferenceBuffer');
    expect(durableRepoSource).toContain('outputObjectPath');
    expect(durableRepoSource).not.toContain('buffer: Buffer');
  });

  it('uses a bounded image-specific GCS fast path for browser master-image reads', () => {
    expect(durableServiceSource).toContain("import { Storage } from '@google-cloud/storage'");
    expect(durableServiceSource).toContain('CHARACTER_REFERENCE_DOWNLOAD_TIMEOUT_MS = 10_000');
    expect(durableServiceSource).toContain('characterReferenceStorage.bucket(ref.outputBucket).file(ref.outputObjectPath)');
    expect(durableServiceSource).toContain('file.download({ timeout: CHARACTER_REFERENCE_DOWNLOAD_TIMEOUT_MS } as any)');
    expect(durableServiceSource).toContain("gcsArtifactStore.useMock || process.env.NODE_ENV === 'test'");
    expect(durableServiceSource).toContain('Never route JPEG/PNG bytes through the generic video artifact downloader');
  });

  it('hydrates durable character masters before prompt suggestion and Veo start', () => {
    const hydrateMatches = serverSource.match(/durableCharacterService\.getHydrated\(characterId\)/g) || [];
    expect(hydrateMatches.length).toBeGreaterThanOrEqual(2);
    expect(serverSource).toContain('masterBuffers = storedChar.referenceImages.slice(0, 3).map((r) => r.buffer)');
  });

  it('self-heals legacy browser-only characters into the durable server store', () => {
    expect(clientRepoSource).toContain('One-time self-healing migration');
    expect(clientRepoSource).toContain('remoteIds.has(local.id)');
    expect(clientRepoSource).toContain('await this.pushToServer(local)');
    expect(clientRepoSource).toContain("throw new Error(payload?.error || `角色云端持久化失败");
  });

  it('does not acknowledge save/delete success when the durable server mutation fails', () => {
    expect(clientRepoSource).toContain('await this.pushToServer(character)');
    expect(clientRepoSource).toContain("if (!res.ok)");
    expect(clientRepoSource).toContain("角色云端删除失败");
  });
});
