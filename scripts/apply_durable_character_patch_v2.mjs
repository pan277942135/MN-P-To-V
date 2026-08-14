import fs from 'node:fs';

const filePath = 'server.ts';
let source = fs.readFileSync(filePath, 'utf8');
let changed = false;
const block = (lines) => lines.join('\n');

function replaceOnce(label, before, after) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`[durable-character-migration] missing anchor: ${label}`);
  source = source.replace(before, after);
  changed = true;
}

function replaceRegex(label, regex, replacement, marker) {
  if (marker && source.includes(marker)) return;
  if (!regex.test(source)) throw new Error(`[durable-character-migration] missing regex anchor: ${label}`);
  source = source.replace(regex, replacement);
  changed = true;
}

replaceOnce(
  'durable service import',
  "import { firestoreTaskRepository } from './src/server/repositories/firestoreTaskRepository';",
  "import { firestoreTaskRepository } from './src/server/repositories/firestoreTaskRepository';\nimport { durableCharacterService } from './src/server/services/durableCharacterService';"
);

replaceRegex(
  'character list and reference routes',
  /  \/\/ List all characters endpoint for client hydration[\s\S]*?\n  \/\/ Store character profile endpoint/,
  block([
    "  // Durable Character Library: Firestore metadata + GCS master-image authority.",
    "  app.get('/api/characters/list', async (_req, res) => {",
    "    try {",
    "      if (!durableCharacterService.isAvailable()) {",
    "        return res.status(503).json({ characters: [], storageAuthority: 'unavailable', error: '角色云端存储不可用' });",
    "      }",
    "      const records = await durableCharacterService.listMetadata();",
    "      const characters = records.map((record) => ({",
    "        id: record.id,",
    "        name: record.name,",
    "        description: record.description,",
    "        identitySpec: record.identitySpec,",
    "        status: 'ready' as const,",
    "        adultConfirmed: record.adultConfirmed,",
    "        rightsConfirmed: record.rightsConfirmed,",
    "        referenceImages: [...(record.referenceImages || [])]",
    "          .sort((a, b) => a.sortOrder - b.sortOrder)",
    "          .map((ref) => ({",
    "            id: ref.id,",
    "            url: '/api/characters/' + encodeURIComponent(record.id) + '/reference/' + encodeURIComponent(ref.id),",
    "            width: ref.width || 1080,",
    "            height: ref.height || 1080,",
    "            angle: ref.angle || 'other',",
    "            mimeType: ref.mimeType || 'image/jpeg',",
    "          })),",
    "        createdAt: new Date(record.createdAt).toISOString(),",
    "        updatedAt: new Date(record.updatedAt).toISOString(),",
    "        evidenceSource: 'firestore',",
    "      }));",
    "      return res.json({ characters, storageAuthority: 'firestore', artifactAuthority: 'gcs' });",
    "    } catch (err: any) {",
    "      console.error('[Durable Character List Error]:', err);",
    "      return res.status(503).json({ characters: [], storageAuthority: 'firestore', error: err?.message || '读取角色库失败' });",
    "    }",
    "  });",
    "",
    "  app.get('/api/characters/:id/reference/:referenceId', async (req, res) => {",
    "    try {",
    "      if (!durableCharacterService.isAvailable()) {",
    "        return res.status(503).json({ error: '角色云端存储不可用', storageAuthority: 'unavailable' });",
    "      }",
    "      const artifact = await durableCharacterService.getReferenceBuffer(req.params.id, req.params.referenceId);",
    "      if (!artifact) return res.status(404).json({ error: '角色母板不存在', storageAuthority: 'firestore' });",
    "      res.setHeader('Content-Type', artifact.mimeType);",
    "      res.setHeader('Cache-Control', 'private, max-age=300');",
    "      return res.send(artifact.buffer);",
    "    } catch (err: any) {",
    "      return res.status(503).json({ error: err?.message || '读取角色母板失败', storageAuthority: 'gcs' });",
    "    }",
    "  });",
    "",
    "  // Store character profile endpoint",
  ]),
  'Durable Character Library: Firestore metadata + GCS master-image authority.'
);

replaceRegex(
  'character store route',
  /  \/\/ Store character profile endpoint\n  app\.post\('\/api\/characters\/store'[\s\S]*?\n  \}\);\n\n  \/\/ Delete character endpoint/,
  block([
    "  // Store character profile endpoint",
    "  app.post('/api/characters/store', upload.array('masterPhotos', 8), async (req, res) => {",
    "    try {",
    "      if (!durableCharacterService.isAvailable()) {",
    "        return res.status(503).json({ success: false, storageAuthority: 'unavailable', error: '角色云端存储不可用' });",
    "      }",
    "      const id = req.body.id || ('char_' + crypto.randomUUID().slice(0, 8));",
    "      const name = req.body.name || '未命名角色';",
    "      const description = req.body.description || '';",
    "      const identitySpec = req.body.identitySpec ? JSON.parse(req.body.identitySpec) : { lockedTraits: [] };",
    "      const files = (req.files as Express.Multer.File[]) || [];",
    "      const images = files.map((file, index) => ({",
    "        buffer: file.buffer,",
    "        mimeType: file.mimetype || 'image/jpeg',",
    "        width: 1080,",
    "        height: 1080,",
    "        angle: index === 0 ? 'front' : 'other',",
    "      }));",
    "",
    "      const record = await durableCharacterService.save({",
    "        id, name, description, identitySpec,",
    "        images: images.length ? images : undefined,",
    "        adultConfirmed: req.body.adultConfirmed !== 'false',",
    "        rightsConfirmed: req.body.rightsConfirmed !== 'false',",
    "      });",
    "      const hydrated = await durableCharacterService.hydrate(record);",
    "      serverCharacterStore.set(id, hydrated);",
    "      return res.json({",
    "        success: true,",
    "        storageAuthority: 'firestore',",
    "        artifactAuthority: 'gcs',",
    "        character: { ...record, referenceImages: record.referenceImages.length },",
    "      });",
    "    } catch (err: any) {",
    "      console.error('[Durable Character Store Error]:', err);",
    "      return res.status(503).json({ success: false, storageAuthority: 'firestore', error: err?.message || '角色云端持久化失败' });",
    "    }",
    "  });",
    "",
    "  // Delete character endpoint",
  ]),
  "console.error('[Durable Character Store Error]:'"
);

replaceRegex(
  'character delete route',
  /  \/\/ Delete character endpoint\n  app\.delete\('\/api\/characters\/:id'[\s\S]*?\n  \}\);\n\n  \/\/ Get character profile endpoint/,
  block([
    "  // Delete character endpoint",
    "  app.delete('/api/characters/:id', async (req, res) => {",
    "    try {",
    "      if (!durableCharacterService.isAvailable()) {",
    "        return res.status(503).json({ success: false, storageAuthority: 'unavailable', error: '角色云端存储不可用' });",
    "      }",
    "      const deleted = await durableCharacterService.delete(req.params.id);",
    "      serverCharacterStore.delete(req.params.id);",
    "      return res.json({ success: deleted, storageAuthority: 'firestore', artifactAuthority: 'gcs' });",
    "    } catch (err: any) {",
    "      return res.status(503).json({ success: false, storageAuthority: 'firestore', error: err?.message || '删除角色失败' });",
    "    }",
    "  });",
    "",
    "  // Get character profile endpoint",
  ]),
  "const deleted = await durableCharacterService.delete(req.params.id);"
);

replaceRegex(
  'character get route',
  /  \/\/ Get character profile endpoint\n  app\.get\('\/api\/characters\/:id'[\s\S]*?\n  \}\);\n\n  \/\/ Update character profile description/,
  block([
    "  // Get character profile endpoint",
    "  app.get('/api/characters/:id', async (req, res) => {",
    "    try {",
    "      if (!durableCharacterService.isAvailable()) {",
    "        return res.status(503).json({ error: '角色云端存储不可用', storageAuthority: 'unavailable' });",
    "      }",
    "      const record = await durableCharacterService.getMetadata(req.params.id);",
    "      if (!record) {",
    "        const errObj = createStructuredError({",
    "          source: 'character_api', failureStage: 'internal_api', httpStatus: 404,",
    "          customUserMessage: '角色资料不存在或已被删除。',",
    "          endpointPathRedacted: '/api/characters/' + req.params.id,",
    "        });",
    "        return res.status(404).json(errObj);",
    "      }",
    "      return res.json({",
    "        id: record.id, name: record.name, description: record.description, identitySpec: record.identitySpec,",
    "        adultConfirmed: record.adultConfirmed, rightsConfirmed: record.rightsConfirmed, status: record.status,",
    "        referenceImages: [...(record.referenceImages || [])].sort((a, b) => a.sortOrder - b.sortOrder).map((ref) => ({",
    "          id: ref.id,",
    "          url: '/api/characters/' + encodeURIComponent(record.id) + '/reference/' + encodeURIComponent(ref.id),",
    "          width: ref.width || 1080, height: ref.height || 1080, angle: ref.angle || 'other', mimeType: ref.mimeType || 'image/jpeg',",
    "        })),",
    "        createdAt: new Date(record.createdAt).toISOString(), updatedAt: new Date(record.updatedAt).toISOString(),",
    "        evidenceSource: 'firestore',",
    "      });",
    "    } catch (err: any) {",
    "      return res.status(503).json({ error: err?.message || '读取角色资料失败', storageAuthority: 'firestore' });",
    "    }",
    "  });",
    "",
    "  // Update character profile description",
  ]),
  "const record = await durableCharacterService.getMetadata(req.params.id);"
);

replaceOnce(
  'hydrate update target',
  "      let char = serverCharacterStore.get(id);\n\n      const files = (req.files as Express.Multer.File[]) || [];",
  block([
    "      let char = serverCharacterStore.get(id);",
    "      if (!char && durableCharacterService.isAvailable()) {",
    "        const durableChar = await durableCharacterService.getHydrated(id);",
    "        if (durableChar) { char = durableChar; serverCharacterStore.set(id, durableChar); }",
    "      }",
    "",
    "      const files = (req.files as Express.Multer.File[]) || [];",
  ])
);

replaceOnce(
  'persist reanalyzed update',
  "            serverCharacterStore.set(id, newChar);\n            saveCharactersToDisk(serverCharacterStore);\n            return res.json({ success: true, character: { ...newChar, referenceImages: newChar.referenceImages.length } });",
  block([
    "            const durableRecord = await durableCharacterService.save({",
    "              id, name: newChar.name, description: newChar.description, identitySpec: newChar.identitySpec,",
    "              images: imagesInput.length > 0 ? imagesInput : undefined, adultConfirmed: true, rightsConfirmed: true,",
    "            });",
    "            const hydrated = await durableCharacterService.hydrate(durableRecord);",
    "            serverCharacterStore.set(id, hydrated);",
    "            return res.json({ success: true, storageAuthority: 'firestore', character: { ...durableRecord, referenceImages: durableRecord.referenceImages.length } });",
  ])
);

replaceOnce(
  'persist metadata update',
  "        serverCharacterStore.set(id, char);\n        saveCharactersToDisk(serverCharacterStore);\n        return res.json({ success: true, character: { ...char, referenceImages: char.referenceImages.length } });",
  block([
    "        const durableRecord = await durableCharacterService.save({",
    "          id, name: char.name, description: char.description, identitySpec: char.identitySpec, adultConfirmed: true, rightsConfirmed: true,",
    "        });",
    "        const hydrated = await durableCharacterService.hydrate(durableRecord);",
    "        serverCharacterStore.set(id, hydrated);",
    "        return res.json({ success: true, storageAuthority: 'firestore', character: { ...durableRecord, referenceImages: durableRecord.referenceImages.length } });",
  ])
);

replaceOnce(
  'persist analyzed character',
  "        serverCharacterStore.set(charId, serverChar);\n        saveCharactersToDisk(serverCharacterStore);\n        return res.json({ ...result, characterId: charId });",
  block([
    "        const durableRecord = await durableCharacterService.save({",
    "          id: charId, name, description, identitySpec: result.identitySpec, images: imagesInput, adultConfirmed, rightsConfirmed,",
    "        });",
    "        const hydrated = await durableCharacterService.hydrate(durableRecord);",
    "        serverCharacterStore.set(charId, hydrated);",
    "        return res.json({ ...result, characterId: charId, storageAuthority: 'firestore', artifactAuthority: 'gcs' });",
  ])
);

const localLookup = "      const storedChar = serverCharacterStore.get(characterId);";
const durableLookup = block([
  "      let storedChar = serverCharacterStore.get(characterId);",
  "      if (!storedChar && characterId && durableCharacterService.isAvailable()) {",
  "        const durableChar = await durableCharacterService.getHydrated(characterId);",
  "        if (durableChar) { storedChar = durableChar; serverCharacterStore.set(characterId, durableChar); }",
  "      }",
]);
if (!source.includes('durableCharacterService.getHydrated(characterId)')) {
  const matches = source.split(localLookup).length - 1;
  if (matches < 2) throw new Error(`[durable-character-migration] expected >=2 lookup anchors, found ${matches}`);
  source = source.split(localLookup).join(durableLookup);
  changed = true;
}

if (changed) fs.writeFileSync(filePath, source);
console.log(`[durable-character-migration] ${changed ? 'server.ts updated' : 'already applied'}`);
