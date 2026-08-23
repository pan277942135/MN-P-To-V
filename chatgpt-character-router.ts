import express from 'express';
import { Storage } from '@google-cloud/storage';
import { getFirestoreInstance } from './src/server/db/firestore';

type UpstreamCall = (path: string, init?: RequestInit) => Promise<Response>;

type CharacterRouterDeps = {
  // Retained in the dependency contract because the gateway already owns this private
  // upstream channel. Character reads intentionally use the shared durable authorities
  // directly so PRD-001 does not depend on the video-only MVP upstream exposing UI routes.
  upstream: UpstreamCall;
  publicUrl?: string;
};

type DurableCharacterReference = {
  id?: string;
  outputBucket?: string;
  outputObjectPath?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  angle?: string;
  sortOrder?: number;
  sizeBytes?: number;
};

const CHARACTER_COLLECTION = 'characters';
const CHARACTER_LIMIT = 100;
const CHARACTER_REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
const CHARACTER_REFERENCE_DOWNLOAD_TIMEOUT_MS = 10_000;
const storage = new Storage();

function normalizeQuery(value: unknown): string {
  return String(value || '').trim().toLocaleLowerCase();
}

function requestOrigin(req: express.Request, configuredPublicUrl?: string): string {
  const configured = String(configuredPublicUrl || '').replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

function registryUnavailable(error: string, diagnostics?: Record<string, unknown>) {
  return {
    ok: false,
    status: 'CHARACTER_REGISTRY_UNAVAILABLE',
    error,
    stage: 'character_registry',
    retryable: true,
    diagnostics: diagnostics || null,
  };
}

function notFound(characterId: string) {
  return {
    ok: false,
    status: 'CHARACTER_NOT_FOUND',
    error: 'character_not_found',
    stage: 'character_registry',
    retryable: false,
    characterId,
  };
}

function compactCharacter(record: any) {
  const refs = Array.isArray(record?.referenceImages) ? record.referenceImages : [];
  return {
    characterId: String(record?.id || ''),
    name: String(record?.name || ''),
    description: String(record?.description || ''),
    status: String(record?.status || 'ready'),
    referenceCount: refs.length,
    lockedTraitCount: Array.isArray(record?.identitySpec?.lockedTraits) ? record.identitySpec.lockedTraits.length : 0,
    updatedAt: record?.updatedAt || null,
    evidenceSource: 'firestore',
  };
}

function orderedReferences(record: any): DurableCharacterReference[] {
  return [...(Array.isArray(record?.referenceImages) ? record.referenceImages : [])]
    .sort((a: DurableCharacterReference, b: DurableCharacterReference) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
}

function detectImageMime(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function getCharacterRecord(characterId: string): Promise<any | null> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('FIRESTORE_UNAVAILABLE');
  const snap = await db.collection(CHARACTER_COLLECTION).doc(characterId).get();
  if (!snap.exists) return null;
  return { ...(snap.data() || {}), id: snap.id, evidenceSource: 'firestore' };
}

export function createChatGptCharacterRouter(deps: CharacterRouterDeps): express.Router {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const q = normalizeQuery(req.query.q);
    try {
      const db = getFirestoreInstance();
      if (!db) {
        return res.status(200).json(registryUnavailable('firestore_unavailable'));
      }

      const snapshot = await db.collection(CHARACTER_COLLECTION).limit(CHARACTER_LIMIT).get();
      const all: any[] = [];
      snapshot.forEach((docSnap) => all.push({ ...(docSnap.data() || {}), id: docSnap.id, evidenceSource: 'firestore' }));
      all.sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));

      const filtered = q
        ? all.filter((record: any) => {
            const haystack = [record?.id, record?.name, record?.description]
              .map((value) => normalizeQuery(value))
              .join('\n');
            return haystack.includes(q);
          })
        : all;

      return res.status(200).json({
        ok: true,
        status: 'CHARACTER_LIST_OK',
        stage: 'character_registry',
        query: q || null,
        count: filtered.length,
        characters: filtered.map(compactCharacter),
        storageAuthority: 'firestore',
        artifactAuthority: 'gcs',
      });
    } catch (error: any) {
      return res.status(200).json(registryUnavailable('character_list_read_failed', {
        message: String(error?.message || error),
      }));
    }
  });

  router.get('/:characterId', async (req, res) => {
    const characterId = String(req.params.characterId || '').trim();
    if (!characterId) return res.status(200).json(notFound(characterId));

    try {
      const record = await getCharacterRecord(characterId);
      if (!record) return res.status(200).json(notFound(characterId));

      const origin = requestOrigin(req, deps.publicUrl);
      const references = orderedReferences(record).map((ref) => ({
        referenceId: String(ref?.id || ''),
        angle: ref?.angle || 'other',
        mimeType: ref?.mimeType || 'image/jpeg',
        width: Number(ref?.width || 0) || null,
        height: Number(ref?.height || 0) || null,
        sizeBytes: Number(ref?.sizeBytes || 0) || null,
        assetUrl: `${origin}/v1/characters/${encodeURIComponent(characterId)}/references/${encodeURIComponent(String(ref?.id || ''))}`,
      }));

      return res.status(200).json({
        ok: true,
        status: 'CHARACTER_PACKAGE_OK',
        stage: 'character_registry',
        rolePackage: {
          characterId: String(record?.id || characterId),
          name: String(record?.name || ''),
          description: String(record?.description || ''),
          identitySpec: record?.identitySpec || { lockedTraits: [] },
          adultConfirmed: record?.adultConfirmed !== false,
          rightsConfirmed: record?.rightsConfirmed !== false,
          status: record?.status || 'ready',
          references,
          referenceCount: references.length,
          createdAt: record?.createdAt || null,
          updatedAt: record?.updatedAt || null,
          evidenceSource: 'firestore',
          storageAuthority: 'firestore',
          artifactAuthority: 'gcs',
        },
      });
    } catch (error: any) {
      return res.status(200).json(registryUnavailable('character_get_read_failed', {
        message: String(error?.message || error),
        characterId,
      }));
    }
  });

  router.get('/:characterId/references/:referenceId', async (req, res) => {
    const characterId = String(req.params.characterId || '').trim();
    const referenceId = String(req.params.referenceId || '').trim();
    try {
      const record = await getCharacterRecord(characterId);
      if (!record) return res.status(404).json({ error: 'character_not_found', characterId });
      const ref = orderedReferences(record).find((item) => String(item.id || '') === referenceId);
      if (!ref) return res.status(404).json({ error: 'character_reference_not_found', characterId, referenceId });

      const bucket = String(ref.outputBucket || '').trim();
      const objectPath = String(ref.outputObjectPath || '').trim();
      const declaredMimeType = String(ref.mimeType || 'image/jpeg').split(';')[0].toLowerCase();
      if (!bucket || !objectPath) return res.status(502).json({ error: 'character_reference_storage_pointer_missing' });
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(declaredMimeType)) {
        return res.status(502).json({ error: 'character_reference_invalid_mime', mimeType: declaredMimeType });
      }
      if (Number(ref.sizeBytes || 0) > CHARACTER_REFERENCE_MAX_BYTES) {
        return res.status(413).json({ error: 'character_reference_too_large' });
      }

      const [downloaded] = await storage.bucket(bucket).file(objectPath).download({
        timeout: CHARACTER_REFERENCE_DOWNLOAD_TIMEOUT_MS,
      } as any);
      const bytes = Buffer.from(downloaded);
      if (!bytes.length) return res.status(502).json({ error: 'character_reference_empty' });
      if (bytes.length > CHARACTER_REFERENCE_MAX_BYTES) return res.status(413).json({ error: 'character_reference_too_large' });

      // Durable metadata may contain a historical MIME value. The bytes are authoritative
      // so ChatGPT always receives a decodable image with the correct content type.
      const mimeType = detectImageMime(bytes);
      if (!mimeType) return res.status(502).json({ error: 'character_reference_invalid_image_bytes' });

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('Content-Disposition', `inline; filename="${characterId}_${referenceId}"`);
      return res.status(200).send(bytes);
    } catch (error: any) {
      return res.status(502).json({
        error: 'character_reference_read_failed',
        detail: String(error?.message || error),
      });
    }
  });

  return router;
}
