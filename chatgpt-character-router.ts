import express from 'express';
import { getFirestoreInstance } from './src/server/db/firestore';
import {
  CharacterReferenceInputError,
  resolveCharacterReferenceInput,
} from './src/server/services/chatgptCharacterInputResolver';

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

async function getCharacterRecord(characterId: string): Promise<any | null> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('FIRESTORE_UNAVAILABLE');
  const snap = await db.collection(CHARACTER_COLLECTION).doc(characterId).get();
  if (!snap.exists) return null;
  return { ...(snap.data() || {}), id: snap.id, evidenceSource: 'firestore' };
}

function characterReferenceHttpStatus(error: CharacterReferenceInputError): number {
  switch (error.code) {
    case 'CHARACTER_NOT_FOUND':
    case 'CHARACTER_REFERENCE_NOT_FOUND':
      return 404;
    case 'CHARACTER_REFERENCE_TOO_LARGE':
      return 413;
    case 'CHARACTER_NOT_READY':
      return 409;
    case 'CHARACTER_RIGHTS_NOT_CONFIRMED':
      return 403;
    default:
      return 502;
  }
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
        // This is catalog metadata only. The reference byte endpoint normalizes Content-Type
        // from the actual GCS magic bytes through resolveCharacterReferenceInput().
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
      const resolved = await resolveCharacterReferenceInput(characterId, referenceId);
      res.setHeader('Content-Type', resolved.mimeType);
      res.setHeader('Content-Length', String(resolved.bytes.length));
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('Content-Disposition', `inline; filename="${resolved.name}"`);
      res.setHeader('X-Zaojing-Mime-Authority', 'magic-bytes');
      if (resolved.diagnostics.metadataMimeMismatch) {
        res.setHeader('X-Zaojing-Metadata-Mime-Mismatch', 'true');
      }
      return res.status(200).send(resolved.bytes);
    } catch (error: any) {
      if (error instanceof CharacterReferenceInputError) {
        return res.status(characterReferenceHttpStatus(error)).json({
          error: error.code.toLowerCase(),
          characterId,
          referenceId,
          diagnostics: error.diagnostics,
        });
      }
      return res.status(502).json({
        error: 'character_reference_read_failed',
        detail: String(error?.message || error),
      });
    }
  });

  return router;
}