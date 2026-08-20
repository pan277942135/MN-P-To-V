import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const gateway = fs.readFileSync('chatgpt-gateway.ts', 'utf8');
const router = fs.readFileSync('chatgpt-character-router.ts', 'utf8');
const schema = fs.readFileSync('chatgpt-action-openapi.yaml', 'utf8');
const workbenchServer = fs.readFileSync('server.ts', 'utf8');
const durableCharacterService = fs.readFileSync('src/server/services/durableCharacterService.ts', 'utf8');
const durableCharacterRepository = fs.readFileSync('src/server/repositories/firestoreCharacterRepository.ts', 'utf8');

describe('PRD-001 ChatGPT character registry', () => {
  it('reuses the existing durable character library instead of introducing a second role store', () => {
    expect(workbenchServer).toContain("app.get('/api/characters/list'");
    expect(workbenchServer).toContain("app.get('/api/characters/:id'");
    expect(durableCharacterRepository).toContain("collectionName = 'characters'");
    expect(durableCharacterService).toContain('gcsArtifactStore.uploadImageArtifact');
    expect(durableCharacterService).toContain('characters/${params.id}/masters/');
    expect(router).toContain("CHARACTER_COLLECTION = 'characters'");
  });

  it('mounts a read-only ChatGPT character surface under the existing gateway security boundary', () => {
    expect(gateway).toContain("createChatGptCharacterRouter");
    expect(gateway).toContain("app.use('/v1/characters', createChatGptCharacterRouter({ upstream, publicUrl: PUBLIC_URL }))");
    const authIndex = gateway.indexOf("if (!UAT_DIRECT_MODE) app.use('/v1', authenticateApiKey)");
    const characterIndex = gateway.indexOf("app.use('/v1/characters'");
    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect(characterIndex).toBeGreaterThan(authIndex);
    expect(router).not.toContain("router.post(");
    expect(router).not.toContain("router.put(");
    expect(router).not.toContain("router.delete(");
  });

  it('lets ChatGPT list/search roles and fetch the full identity package without user re-upload', () => {
    expect(router).toContain("router.get('/', async");
    expect(router).toContain("status: 'CHARACTER_LIST_OK'");
    expect(router).toContain('req.query.q');
    expect(router).toContain("router.get('/:characterId', async");
    expect(router).toContain("status: 'CHARACTER_PACKAGE_OK'");
    expect(router).toContain('identitySpec: record?.identitySpec');
    expect(router).toContain('referenceCount: references.length');
    expect(router).toContain("status: 'CHARACTER_NOT_FOUND'");
  });

  it('returns action-safe structured registry failures instead of an opaque non-2xx for list/detail reads', () => {
    expect(router).toContain("status: 'CHARACTER_REGISTRY_UNAVAILABLE'");
    expect(router).toContain("stage: 'character_registry'");
    const listStart = router.indexOf("router.get('/', async");
    const detailStart = router.indexOf("router.get('/:characterId', async");
    const referenceStart = router.indexOf("router.get('/:characterId/references/:referenceId'");
    expect(router.slice(listStart, detailStart)).toContain('res.status(200).json');
    expect(router.slice(detailStart, referenceStart)).toContain('res.status(200).json');
  });

  it('resolves reference images from the existing GCS pointers without exposing bucket/object paths in the role package', () => {
    expect(router).toContain("router.get('/:characterId/references/:referenceId'");
    expect(router).toContain('ref.outputBucket');
    expect(router).toContain('ref.outputObjectPath');
    expect(router).toContain('storage.bucket(bucket).file(objectPath).download');
    expect(router).toContain("artifactAuthority: 'gcs'");
    expect(router).toContain('assetUrl: `${origin}/v1/characters/');
    const packageStart = router.indexOf("status: 'CHARACTER_PACKAGE_OK'");
    const referenceRouteStart = router.indexOf("router.get('/:characterId/references/:referenceId'");
    const packageBlock = router.slice(packageStart, referenceRouteStart);
    expect(packageBlock).not.toContain('outputBucket:');
    expect(packageBlock).not.toContain('outputObjectPath:');
  });

  it('registers non-consequential role lookup actions in the GPT schema', () => {
    expect(schema).toContain('/v1/characters:');
    expect(schema).toContain('operationId: listZaojingCharacters');
    expect(schema).toContain('/v1/characters/{characterId}:');
    expect(schema).toContain('operationId: getZaojingCharacterPackage');
    const listStart = schema.indexOf('operationId: listZaojingCharacters');
    const detailStart = schema.indexOf('operationId: getZaojingCharacterPackage');
    const preflightStart = schema.indexOf('operationId: preflightIdentityImage');
    expect(schema.slice(listStart, detailStart)).toContain('x-openai-isConsequential: false');
    expect(schema.slice(detailStart, preflightStart)).toContain('x-openai-isConsequential: false');
    expect(schema).toContain('Use this before asking the user to upload a character pack.');
  });
});
