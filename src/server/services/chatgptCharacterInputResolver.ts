import crypto from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { getFirestoreInstance } from '../db/firestore';

const CHARACTER_COLLECTION = 'characters';
const MAX_CHARACTER_REFERENCE_BYTES = 20 * 1024 * 1024;
const CHARACTER_REFERENCE_DOWNLOAD_TIMEOUT_MS = 10_000;
const SUPPORTED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

type SupportedImageMime = typeof SUPPORTED_IMAGE_MIMES[number];

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

export type ResolvedCharacterReferenceInput = {
  bytes: Buffer;
  mimeType: SupportedImageMime;
  name: string;
  characterId: string;
  characterName: string;
  characterUpdatedAt: number | null;
  referenceId: string;
  angle: string;
  identitySpec: Record<string, unknown>;
  identitySpecSha256: string;
  identityLockPrompt: string | null;
  contentSha256: string;
  sizeBytes: number;
  diagnostics: {
    referenceKind: 'character_reference';
    characterId: string;
    characterName: string;
    characterUpdatedAt: number | null;
    referenceId: string;
    angle: string;
    declaredMime: string | null;
    detectedMime: SupportedImageMime;
    sizeBytes: number;
    contentSha256: string;
    identitySpecSha256: string;
    storageAuthority: 'firestore';
    artifactAuthority: 'gcs';
  };
};

export class CharacterReferenceInputError extends Error {
  constructor(public code: string, public diagnostics: Record<string, unknown> = {}) {
    super(code);
  }
}

const storage = new Storage();

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeMime(raw: unknown): string | null {
  const mime = String(raw || '').split(';')[0].trim().toLowerCase();
  return mime || null;
}

function detectImageMime(bytes: Buffer): SupportedImageMime | null {
  if (!bytes || bytes.length < 12) return null;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (jpeg) return 'image/jpeg';
  if (png) return 'image/png';
  if (webp) return 'image/webp';
  return null;
}

function extensionForMime(mime: SupportedImageMime): string {
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
}

function orderedReferences(record: any): DurableCharacterReference[] {
  return [...(Array.isArray(record?.referenceImages) ? record.referenceImages : [])]
    .sort((a: DurableCharacterReference, b: DurableCharacterReference) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
}

function identityPrompt(identitySpec: any): string | null {
  const english = String(identitySpec?.identityLockPromptEnglish || '').trim();
  if (english) return english;
  const chinese = String(identitySpec?.identityLockPromptChinese || '').trim();
  return chinese || null;
}

export async function resolveCharacterReferenceInput(
  characterIdRaw: unknown,
  referenceIdRaw: unknown,
): Promise<ResolvedCharacterReferenceInput> {
  const characterId = String(characterIdRaw || '').trim();
  const referenceId = String(referenceIdRaw || '').trim();
  if (!characterId || !referenceId) {
    throw new CharacterReferenceInputError('CHARACTER_REFERENCE_INVALID', { characterId, referenceId });
  }

  const db = getFirestoreInstance();
  if (!db) throw new CharacterReferenceInputError('CHARACTER_REGISTRY_UNAVAILABLE');

  const snap = await db.collection(CHARACTER_COLLECTION).doc(characterId).get();
  if (!snap.exists) throw new CharacterReferenceInputError('CHARACTER_NOT_FOUND', { characterId });

  const record: any = { ...(snap.data() || {}), id: snap.id };
  if (record.status && String(record.status) !== 'ready') {
    throw new CharacterReferenceInputError('CHARACTER_NOT_READY', { characterId, status: record.status });
  }
  if (record.adultConfirmed === false || record.rightsConfirmed === false) {
    throw new CharacterReferenceInputError('CHARACTER_RIGHTS_NOT_CONFIRMED', {
      characterId,
      adultConfirmed: record.adultConfirmed !== false,
      rightsConfirmed: record.rightsConfirmed !== false,
    });
  }

  const ref = orderedReferences(record).find((item) => String(item.id || '') === referenceId);
  if (!ref) throw new CharacterReferenceInputError('CHARACTER_REFERENCE_NOT_FOUND', { characterId, referenceId });

  const bucket = String(ref.outputBucket || '').trim();
  const objectPath = String(ref.outputObjectPath || '').trim();
  const declaredMime = normalizeMime(ref.mimeType);
  if (!bucket || !objectPath) {
    throw new CharacterReferenceInputError('CHARACTER_REFERENCE_STORAGE_POINTER_MISSING', { characterId, referenceId });
  }
  if (Number(ref.sizeBytes || 0) > MAX_CHARACTER_REFERENCE_BYTES) {
    throw new CharacterReferenceInputError('CHARACTER_REFERENCE_TOO_LARGE', { characterId, referenceId, sizeBytes: ref.sizeBytes });
  }

  let downloaded: Buffer;
  try {
    const [bytes] = await storage.bucket(bucket).file(objectPath).download({
      timeout: CHARACTER_REFERENCE_DOWNLOAD_TIMEOUT_MS,
    } as any);
    downloaded = Buffer.from(bytes);
  } catch (error: any) {
    throw new CharacterReferenceInputError('CHARACTER_REFERENCE_READ_FAILED', {
      characterId,
      referenceId,
      message: String(error?.message || error),
    });
  }

  if (!downloaded.length) throw new CharacterReferenceInputError('CHARACTER_REFERENCE_EMPTY', { characterId, referenceId });
  if (downloaded.length > MAX_CHARACTER_REFERENCE_BYTES) {
    throw new CharacterReferenceInputError('CHARACTER_REFERENCE_TOO_LARGE', { characterId, referenceId, sizeBytes: downloaded.length });
  }

  const detectedMime = detectImageMime(downloaded);
  if (!detectedMime) {
    throw new CharacterReferenceInputError('CHARACTER_REFERENCE_CONTENT_INVALID', { characterId, referenceId, declaredMime });
  }
  if (declaredMime && SUPPORTED_IMAGE_MIMES.includes(declaredMime as SupportedImageMime) && declaredMime !== detectedMime) {
    throw new CharacterReferenceInputError('CHARACTER_REFERENCE_MIME_MISMATCH', {
      characterId,
      referenceId,
      declaredMime,
      detectedMime,
    });
  }

  const identitySpec = (record.identitySpec && typeof record.identitySpec === 'object') ? record.identitySpec : { lockedTraits: [] };
  const identitySpecSha256 = sha256(JSON.stringify(identitySpec));
  const contentSha256 = sha256(downloaded);
  const characterName = String(record.name || '');
  const characterUpdatedAt = Number(record.updatedAt || 0) || null;
  const angle = String(ref.angle || 'other');

  return {
    bytes: downloaded,
    mimeType: detectedMime,
    name: `${characterId}_${referenceId}.${extensionForMime(detectedMime)}`,
    characterId,
    characterName,
    characterUpdatedAt,
    referenceId,
    angle,
    identitySpec,
    identitySpecSha256,
    identityLockPrompt: identityPrompt(identitySpec),
    contentSha256,
    sizeBytes: downloaded.length,
    diagnostics: {
      referenceKind: 'character_reference',
      characterId,
      characterName,
      characterUpdatedAt,
      referenceId,
      angle,
      declaredMime,
      detectedMime,
      sizeBytes: downloaded.length,
      contentSha256,
      identitySpecSha256,
      storageAuthority: 'firestore',
      artifactAuthority: 'gcs',
    },
  };
}
