import express from 'express';

type UpstreamCall = (path: string, init?: RequestInit) => Promise<Response>;

type CharacterRouterDeps = {
  upstream: UpstreamCall;
  publicUrl?: string;
};

function normalizeQuery(value: unknown): string {
  return String(value || '').trim().toLocaleLowerCase();
}

function requestOrigin(req: express.Request, configuredPublicUrl?: string): string {
  const configured = String(configuredPublicUrl || '').replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'upstream_non_json', httpStatus: response.status };
  }
}

function readFailure(error: string, diagnostics?: Record<string, unknown>) {
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
    evidenceSource: record?.evidenceSource || 'firestore',
  };
}

export function createChatGptCharacterRouter(deps: CharacterRouterDeps): express.Router {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const q = normalizeQuery(req.query.q);
    try {
      const response = await deps.upstream('/api/characters/list');
      const body = await readJson(response);
      if (!response.ok) {
        return res.status(200).json(readFailure('upstream_character_list_failed', {
          upstreamHttpStatus: response.status,
          upstreamError: body?.error || null,
        }));
      }

      const all = Array.isArray(body?.characters) ? body.characters : [];
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
        storageAuthority: body?.storageAuthority || 'firestore',
        artifactAuthority: body?.artifactAuthority || 'gcs',
      });
    } catch (error: any) {
      return res.status(200).json(readFailure('character_list_transport_failed', {
        message: String(error?.message || error),
      }));
    }
  });

  router.get('/:characterId', async (req, res) => {
    const characterId = String(req.params.characterId || '').trim();
    if (!characterId) return res.status(200).json(notFound(characterId));

    try {
      const response = await deps.upstream(`/api/characters/${encodeURIComponent(characterId)}`);
      const body = await readJson(response);
      if (response.status === 404) return res.status(200).json(notFound(characterId));
      if (!response.ok) {
        return res.status(200).json(readFailure('upstream_character_get_failed', {
          upstreamHttpStatus: response.status,
          upstreamError: body?.error || null,
          characterId,
        }));
      }

      const origin = requestOrigin(req, deps.publicUrl);
      const references = (Array.isArray(body?.referenceImages) ? body.referenceImages : []).map((ref: any) => ({
        referenceId: String(ref?.id || ''),
        angle: ref?.angle || 'other',
        mimeType: ref?.mimeType || 'image/jpeg',
        width: Number(ref?.width || 0) || null,
        height: Number(ref?.height || 0) || null,
        assetUrl: `${origin}/v1/characters/${encodeURIComponent(characterId)}/references/${encodeURIComponent(String(ref?.id || ''))}`,
      }));

      return res.status(200).json({
        ok: true,
        status: 'CHARACTER_PACKAGE_OK',
        stage: 'character_registry',
        rolePackage: {
          characterId: String(body?.id || characterId),
          name: String(body?.name || ''),
          description: String(body?.description || ''),
          identitySpec: body?.identitySpec || { lockedTraits: [] },
          adultConfirmed: body?.adultConfirmed !== false,
          rightsConfirmed: body?.rightsConfirmed !== false,
          status: body?.status || 'ready',
          references,
          referenceCount: references.length,
          createdAt: body?.createdAt || null,
          updatedAt: body?.updatedAt || null,
          evidenceSource: body?.evidenceSource || 'firestore',
          storageAuthority: 'firestore',
          artifactAuthority: 'gcs',
        },
      });
    } catch (error: any) {
      return res.status(200).json(readFailure('character_get_transport_failed', {
        message: String(error?.message || error),
        characterId,
      }));
    }
  });

  router.get('/:characterId/references/:referenceId', async (req, res) => {
    try {
      const response = await deps.upstream(
        `/api/characters/${encodeURIComponent(req.params.characterId)}/reference/${encodeURIComponent(req.params.referenceId)}`
      );
      if (!response.ok) {
        const body = await readJson(response);
        return res.status(response.status).json({
          error: body?.error || 'character_reference_fetch_failed',
          characterId: req.params.characterId,
          referenceId: req.params.referenceId,
        });
      }
      const mimeType = String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
        return res.status(502).json({ error: 'character_reference_invalid_mime', mimeType });
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) return res.status(502).json({ error: 'character_reference_empty' });
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('Content-Disposition', `inline; filename="${req.params.characterId}_${req.params.referenceId}"`);
      return res.status(200).send(bytes);
    } catch (error: any) {
      return res.status(502).json({
        error: 'character_reference_transport_failed',
        detail: String(error?.message || error),
      });
    }
  });

  return router;
}
