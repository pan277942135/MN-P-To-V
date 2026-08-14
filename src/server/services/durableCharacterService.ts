import crypto from 'crypto';
import type { IdentitySpec } from '../../types';
import { gcsArtifactStore } from '../storage/gcsArtifactStore';
import {
  firestoreCharacterRepository,
  type DurableCharacterRecord,
  type DurableCharacterReference,
} from '../repositories/firestoreCharacterRepository';

export interface CharacterImageInput {
  buffer: Buffer;
  mimeType?: string;
  width?: number;
  height?: number;
  angle?: string;
}

export interface HydratedDurableCharacter {
  id: string;
  name: string;
  description: string;
  identitySpec: IdentitySpec;
  referenceImages: Array<{
    id: string;
    buffer: Buffer;
    mimeType: string;
    width: number;
    height: number;
    angle?: string;
  }>;
  updatedAt: string;
  createdAt: string;
  evidenceSource: 'firestore';
}

function safeExtension(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

export class DurableCharacterService {
  public isAvailable(): boolean {
    return firestoreCharacterRepository.isAvailable();
  }

  public async listMetadata(): Promise<DurableCharacterRecord[]> {
    return firestoreCharacterRepository.listCharacters(100);
  }

  public async getMetadata(id: string): Promise<DurableCharacterRecord | null> {
    return firestoreCharacterRepository.getCharacter(id);
  }

  public async save(params: {
    id: string;
    name: string;
    description?: string;
    identitySpec: IdentitySpec;
    images?: CharacterImageInput[];
    adultConfirmed?: boolean;
    rightsConfirmed?: boolean;
  }): Promise<DurableCharacterRecord> {
    if (!this.isAvailable()) {
      throw new Error('[DurableCharacterService] Firestore unavailable; refusing local-only character save.');
    }

    const now = Date.now();
    const existing = await firestoreCharacterRepository.getCharacter(params.id);
    const uploaded: DurableCharacterReference[] = [];

    if (params.images && params.images.length > 0) {
      try {
        for (let i = 0; i < params.images.length; i++) {
          const image = params.images[i];
          const mimeType = image.mimeType || 'image/jpeg';
          const objectPath = `characters/${params.id}/masters/${now}_${i}_${crypto.randomUUID().slice(0, 8)}.${safeExtension(mimeType)}`;
          const artifact = await gcsArtifactStore.uploadImageArtifact({
            objectPath,
            buffer: image.buffer,
            contentType: mimeType,
          });
          uploaded.push({
            id: `ref_${i}`,
            outputBucket: artifact.outputBucket,
            outputObjectPath: artifact.outputObjectPath,
            mimeType,
            width: image.width || 1080,
            height: image.height || 1080,
            angle: image.angle || (i === 0 ? 'front' : 'other'),
            sortOrder: i,
            sizeBytes: artifact.sizeBytes,
          });
        }
      } catch (err) {
        for (const ref of uploaded) {
          await gcsArtifactStore.deleteVideoArtifact(ref.outputBucket, ref.outputObjectPath).catch(() => false);
        }
        throw err;
      }
    }

    const referenceImages = uploaded.length > 0 ? uploaded : (existing?.referenceImages || []);
    if (referenceImages.length === 0) {
      throw new Error('[DurableCharacterService] Character must have at least one durable master image.');
    }

    const record: DurableCharacterRecord = {
      id: params.id,
      name: params.name || existing?.name || '未命名角色',
      description: params.description ?? existing?.description ?? '',
      identitySpec: params.identitySpec || existing?.identitySpec || ({ lockedTraits: [] } as IdentitySpec),
      adultConfirmed: params.adultConfirmed ?? existing?.adultConfirmed ?? true,
      rightsConfirmed: params.rightsConfirmed ?? existing?.rightsConfirmed ?? true,
      status: 'ready',
      referenceImages,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      evidenceSource: 'firestore',
    };

    try {
      await firestoreCharacterRepository.upsertCharacter(record);
    } catch (err) {
      for (const ref of uploaded) {
        await gcsArtifactStore.deleteVideoArtifact(ref.outputBucket, ref.outputObjectPath).catch(() => false);
      }
      throw err;
    }

    if (uploaded.length > 0 && existing?.referenceImages?.length) {
      const keep = new Set(uploaded.map((ref) => `${ref.outputBucket}/${ref.outputObjectPath}`));
      for (const oldRef of existing.referenceImages) {
        if (!keep.has(`${oldRef.outputBucket}/${oldRef.outputObjectPath}`)) {
          await gcsArtifactStore.deleteVideoArtifact(oldRef.outputBucket, oldRef.outputObjectPath).catch(() => false);
        }
      }
    }

    return record;
  }

  public async hydrate(record: DurableCharacterRecord): Promise<HydratedDurableCharacter> {
    const refs = [...(record.referenceImages || [])].sort((a, b) => a.sortOrder - b.sortOrder);
    const hydratedRefs = [] as HydratedDurableCharacter['referenceImages'];
    for (const ref of refs) {
      const buffer = await gcsArtifactStore.fetchArtifactBuffer(ref.outputBucket, ref.outputObjectPath);
      hydratedRefs.push({
        id: ref.id,
        buffer,
        mimeType: ref.mimeType || 'image/jpeg',
        width: ref.width || 1080,
        height: ref.height || 1080,
        angle: ref.angle,
      });
    }
    return {
      id: record.id,
      name: record.name,
      description: record.description || '',
      identitySpec: record.identitySpec,
      referenceImages: hydratedRefs,
      createdAt: new Date(record.createdAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
      evidenceSource: 'firestore',
    };
  }

  public async getHydrated(id: string): Promise<HydratedDurableCharacter | null> {
    const record = await this.getMetadata(id);
    if (!record) return null;
    return this.hydrate(record);
  }

  public async getReferenceBuffer(characterId: string, referenceId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const record = await this.getMetadata(characterId);
    if (!record) return null;
    const ref = record.referenceImages.find((item) => item.id === referenceId);
    if (!ref) return null;
    const buffer = await gcsArtifactStore.fetchArtifactBuffer(ref.outputBucket, ref.outputObjectPath);
    return { buffer, mimeType: ref.mimeType || 'image/jpeg' };
  }

  public async delete(id: string): Promise<boolean> {
    const existing = await this.getMetadata(id);
    if (!existing) return false;
    const deleted = await firestoreCharacterRepository.deleteCharacter(id);
    if (deleted) {
      for (const ref of existing.referenceImages || []) {
        await gcsArtifactStore.deleteVideoArtifact(ref.outputBucket, ref.outputObjectPath).catch(() => false);
      }
    }
    return deleted;
  }
}

export const durableCharacterService = new DurableCharacterService();
