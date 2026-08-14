import fs from 'node:fs';

const path = 'server.ts';
let source = fs.readFileSync(path, 'utf8');
let changed = false;

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
  'character list and reference streaming routes',
  /  \/\/ List all characters endpoint for client hydration[\s\S]*?\n  \/\/ Store character profile endpoint/,
  `  // Durable Character Library: Firestore metadata + GCS master-image authority.\n  app.get('/api/characters/list', async (_req, res) => {\n    try {\n      if (!durableCharacterService.isAvailable()) {\n        return res.status(503).json({ characters: [], storageAuthority: 'unavailable', error: '角色云端存储不可用' });\n      }\n      const records = await durableCharacterService.listMetadata();\n      const characters = records.map((record) => ({\n        id: record.id,\n        name: record.name,\n        description: record.description,\n        identitySpec: record.identitySpec,\n        status: 'ready' as const,\n        adultConfirmed: record.adultConfirmed,\n        rightsConfirmed: record.rightsConfirmed,\n        referenceImages: [...(record.referenceImages || [])]\n          .sort((a, b) => a.sortOrder - b.sortOrder)\n          .map((ref) => ({\n            id: ref.id,\n            url: \\`/api/characters/\\${encodeURIComponent(record.id)}/reference/\\${encodeURIComponent(ref.id)}\\`,\n            width: ref.width || 1080,\n            height: ref.height || 1080,\n            angle: ref.angle || 'other',\n            mimeType: ref.mimeType || 'image/jpeg',\n          })),\n        createdAt: new Date(record.createdAt).toISOString(),\n        updatedAt: new Date(record.updatedAt).toISOString(),\n        evidenceSource: 'firestore',\n      }));\n      return res.json({ characters, storageAuthority: 'firestore', artifactAuthority: 'gcs' });\n    } catch (err: any) {\n      console.error('[Durable Character List Error]:', err);\n      return res.status(503).json({ characters: [], storageAuthority: 'firestore', error: err?.message || '读取角色库失败' });\n    }\n  });\n\n  app.get('/api/characters/:id/reference/:referenceId', async (req, res) => {\n    try {\n      if (!durableCharacterService.isAvailable()) {\n        return res.status(503).json({ error: '角色云端存储不可用', storageAuthority: 'unavailable' });\n      }\n      const artifact = await durableCharacterService.getReferenceBuffer(req.params.id, req.params.referenceId);\n      if (!artifact) return res.status(404).json({ error: '角色母板不存在', storageAuthority: 'firestore' });\n      res.setHeader('Content-Type', artifact.mimeType);\n      res.setHeader('Cache-Control', 'private, max-age=300');\n      return res.send(artifact.buffer);\n    } catch (err: any) {\n      return res.status(503).json({ error: err?.message || '读取角色母板失败', storageAuthority: 'gcs' });\n    }\n  });\n\n  // Store character profile endpoint`,
  'Durable Character Library: Firestore metadata + GCS master-image authority.'
);

replaceRegex(
  'character store route',
  /  \/\/ Store character profile endpoint\n  app\.post\('\/api\/characters\/store'[\s\S]*?\n  \}\);\n\n  \/\/ Delete character endpoint/,
  `  // Store character profile endpoint\n  app.post('/api/characters/store', upload.array('masterPhotos', 8), async (req, res) => {\n    try {\n      if (!durableCharacterService.isAvailable()) {\n        return res.status(503).json({ success: false, storageAuthority: 'unavailable', error: '角色云端存储不可用' });\n      }\n      const id = req.body.id || \\`char_\\${crypto.randomUUID().slice(0, 8)}\\`;\n      const name = req.body.name || '未命名角色';\n      const description = req.body.description || '';\n      const identitySpec = req.body.identitySpec ? JSON.parse(req.body.identitySpec) : { lockedTraits: [] };\n      const files = (req.files as Express.Multer.File[]) || [];\n      const images = files.map((file, index) => ({\n        buffer: file.buffer,\n        mimeType: file.mimetype || 'image/jpeg',\n        width: 1080,\n        height: 1080,\n        angle: index === 0 ? 'front' : 'other',\n      }));\n\n      const record = await durableCharacterService.save({\n        id,\n        name,\n        description,\n        identitySpec,\n        images: images.length ? images : undefined,\n        adultConfirmed: req.body.adultConfirmed !== 'false',\n        rightsConfirmed: req.body.rightsConfirmed !== 'false',\n      });\n      const hydrated = await durableCharacterService.hydrate(record);\n      serverCharacterStore.set(id, hydrated);\n      return res.json({\n        success: true,\n        storageAuthority: 'firestore',\n        artifactAuthority: 'gcs',\n        character: { ...record, referenceImages: record.referenceImages.length },\n      });\n    } catch (err: any) {\n      console.error('[Durable Character Store Error]:', err);\n      return res.status(503).json({ success: false, storageAuthority: 'firestore', error: err?.message || '角色云端持久化失败' });\n    }\n  });\n\n  // Delete character endpoint`,
  "artifactAuthority: 'gcs',\n        character: { ...record"
);

replaceRegex(
  'character delete route',
  /  \/\/ Delete character endpoint\n  app\.delete\('\/api\/characters\/:id'[\s\S]*?\n  \}\);\n\n  \/\/ Get character profile endpoint/,
  `  // Delete character endpoint\n  app.delete('/api/characters/:id', async (req, res) => {\n    try {\n      if (!durableCharacterService.isAvailable()) {\n        return res.status(503).json({ success: false, storageAuthority: 'unavailable', error: '角色云端存储不可用' });\n      }\n      const deleted = await durableCharacterService.delete(req.params.id);\n      serverCharacterStore.delete(req.params.id);\n      return res.json({ success: deleted, storageAuthority: 'firestore', artifactAuthority: 'gcs' });\n    } catch (err: any) {\n      return res.status(503).json({ success: false, storageAuthority: 'firestore', error: err?.message || '删除角色失败' });\n    }\n  });\n\n  // Get character profile endpoint`,
  "artifactAuthority: 'gcs' });\n    } catch (err: any)"
);

replaceRegex(
  'character profile route',
  /  \/\/ Get character profile endpoint\n  app\.get\('\/api\/characters\/:id'[\s\S]*?\n  \}\);\n\n  \/\/ Update character profile description/,
  `  // Get character profile endpoint\n  app.get('/api/characters/:id', async (req, res) => {\n    try {\n      if (!durableCharacterService.isAvailable()) {\n        return res.status(503).json({ error: '角色云端存储不可用', storageAuthority: 'unavailable' });\n      }\n      const record = await durableCharacterService.getMetadata(req.params.id);\n      if (!record) {\n        const errObj = createStructuredError({\n          source: 'character_api',\n          failureStage: 'internal_api',\n          httpStatus: 404,\n          customUserMessage: '角色资料不存在或已被删除。',\n          endpointPathRedacted: \\`/api/characters/\\${req.params.id}\\`,\n        });\n        return res.status(404).json(errObj);\n      }\n      return res.json({\n        id: record.id,\n        name: record.name,\n        description: record.description,\n        identitySpec: record.identitySpec,\n        adultConfirmed: record.adultConfirmed,\n        rightsConfirmed: record.rightsConfirmed,\n        status: record.status,\n        referenceImages: [...(record.referenceImages || [])].sort((a, b) => a.sortOrder - b.sortOrder).map((ref) => ({\n          id: ref.id,\n          url: \\`/api/characters/\\${encodeURIComponent(record.id)}/reference/\\${encodeURIComponent(ref.id)}\\`,\n          width: ref.width || 1080,\n          height: ref.height || 1080,\n          angle: ref.angle || 'other',\n          mimeType: ref.mimeType || 'image/jpeg',\n        })),\n        createdAt: new Date(record.createdAt).toISOString(),\n        updatedAt: new Date(record.updatedAt).toISOString(),\n        evidenceSource: 'firestore',\n      });\n    } catch (err: any) {\n      return res.status(503).json({ error: err?.message || '读取角色资料失败', storageAuthority: 'firestore' });\n    }\n  });\n\n  // Update character profile description`,
  "evidenceSource: 'firestore',\n      });\n    } catch (err: any)"
);

replaceOnce(
  'hydrate missing character in update route',
  "      let char = serverCharacterStore.get(id);\n\n      const files = (req.files as Express.Multer.File[]) || [];",
  "      let char = serverCharacterStore.get(id);\n      if (!char && durableCharacterService.isAvailable()) {\n        const durableChar = await durableCharacterService.getHydrated(id);\n        if (durableChar) {\n          char = durableChar;\n          serverCharacterStore.set(id, durableChar);\n        }\n      }\n\n      const files = (req.files as Express.Multer.File[]) || [];"
);

replaceOnce(
  'persist reanalyzed character update',
  "            serverCharacterStore.set(id, newChar);\n            saveCharactersToDisk(serverCharacterStore);\n            return res.json({ success: true, character: { ...newChar, referenceImages: newChar.referenceImages.length } });",
  "            const durableRecord = await durableCharacterService.save({\n              id,\n              name: newChar.name,\n              description: newChar.description,\n              identitySpec: newChar.identitySpec,\n              images: imagesInput.length > 0 ? imagesInput : undefined,\n              adultConfirmed: true,\n              rightsConfirmed: true,\n            });\n            const hydrated = await durableCharacterService.hydrate(durableRecord);\n            serverCharacterStore.set(id, hydrated);\n            return res.json({ success: true, storageAuthority: 'firestore', character: { ...durableRecord, referenceImages: durableRecord.referenceImages.length } });"
);

replaceOnce(
  'persist metadata-only character update',
  "        serverCharacterStore.set(id, char);\n        saveCharactersToDisk(serverCharacterStore);\n        return res.json({ success: true, character: { ...char, referenceImages: char.referenceImages.length } });",
  "        const durableRecord = await durableCharacterService.save({\n          id,\n          name: char.name,\n          description: char.description,\n          identitySpec: char.identitySpec,\n          adultConfirmed: true,\n          rightsConfirmed: true,\n        });\n        const hydrated = await durableCharacterService.hydrate(durableRecord);\n        serverCharacterStore.set(id, hydrated);\n        return res.json({ success: true, storageAuthority: 'firestore', character: { ...durableRecord, referenceImages: durableRecord.referenceImages.length } });"
);

replaceOnce(
  'persist analyzed character',
  "        serverCharacterStore.set(charId, serverChar);\n        saveCharactersToDisk(serverCharacterStore);\n        return res.json({ ...result, characterId: charId });",
  "        const durableRecord = await durableCharacterService.save({\n          id: charId,\n          name,\n          description,\n          identitySpec: result.identitySpec,\n          images: imagesInput,\n          adultConfirmed,\n          rightsConfirmed,\n        });\n        const hydrated = await durableCharacterService.hydrate(durableRecord);\n        serverCharacterStore.set(charId, hydrated);\n        return res.json({ ...result, characterId: charId, storageAuthority: 'firestore', artifactAuthority: 'gcs' });"
);

const localLookup = "      const storedChar = serverCharacterStore.get(characterId);";
const durableLookup = "      let storedChar = serverCharacterStore.get(characterId);\n      if (!storedChar && characterId && durableCharacterService.isAvailable()) {\n        const durableChar = await durableCharacterService.getHydrated(characterId);\n        if (durableChar) {\n          storedChar = durableChar;\n          serverCharacterStore.set(characterId, durableChar);\n        }\n      }";
if (!source.includes(durableLookup)) {
  const matches = source.split(localLookup).length - 1;
  if (matches < 2) throw new Error(`[durable-character-migration] expected >=2 character lookup anchors, found ${matches}`);
  source = source.split(localLookup).join(durableLookup);
  changed = true;
}

if (changed) fs.writeFileSync(path, source);
console.log(`[durable-character-migration] ${changed ? 'server.ts updated' : 'already applied'}`);
