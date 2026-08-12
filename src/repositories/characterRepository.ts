import { db } from '../db/database';
import type { CharacterProfile } from '../types';

export interface ICharacterRepository {
  getAll(): Promise<CharacterProfile[]>;
  getById(id: string): Promise<CharacterProfile | undefined>;
  save(character: CharacterProfile): Promise<void>;
  delete(id: string): Promise<void>;
}

export class DexieCharacterRepository implements ICharacterRepository {
  async getAll(): Promise<CharacterProfile[]> {
    try {
      const res = await fetch('/api/characters/list');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.characters)) {
          for (const char of data.characters) {
            if (Array.isArray(char.referenceImages)) {
              char.referenceImages = char.referenceImages.map((ref: any) => ({
                ...ref,
                thumbnailUrl: ref.url || ref.thumbnailUrl || ref.dataUrl,
                dataUrl: ref.url || ref.dataUrl || ref.thumbnailUrl,
              }));
            } else {
              char.referenceImages = [];
            }
            try {
              await db.characters.put(char);
            } catch {}
          }
        }
      }
    } catch {
      // network/offline fallback
    }
    try {
      const result = await db.characters.orderBy('updatedAt').reverse().toArray();
      return (result || []).map((c) => ({
        ...c,
        referenceImages: Array.isArray(c.referenceImages) ? c.referenceImages : [],
      }));
    } catch {
      return [];
    }
  }

  async getById(id: string): Promise<CharacterProfile | undefined> {
    const local = await db.characters.get(id);
    if (local) return local;
    try {
      const res = await fetch(`/api/characters/${id}`);
      if (res.ok) {
        const data = await res.json();
        if (data.id) {
          const char: CharacterProfile = {
            id: data.id,
            name: data.name,
            description: data.description,
            identitySpec: data.identitySpec,
            status: 'ready',
            adultConfirmed: true,
            referenceImages: [],
            createdAt: data.updatedAt,
            updatedAt: data.updatedAt,
          };
          await db.characters.put(char);
          return char;
        }
      }
    } catch {}
    return undefined;
  }

  async save(character: CharacterProfile): Promise<void> {
    await db.characters.put(character);
    try {
      const formData = new FormData();
      formData.append('id', character.id);
      formData.append('name', character.name);
      formData.append('description', character.description || '');
      formData.append('identitySpec', JSON.stringify(character.identitySpec || {}));

      for (let i = 0; i < (character.referenceImages || []).length; i++) {
        const img = character.referenceImages[i];
        if (img.blob && img.blob instanceof Blob && img.blob.size > 0) {
          const file = new File([img.blob], `master_${i}.jpg`, { type: img.mimeType || img.blob.type || 'image/jpeg' });
          formData.append('masterPhotos', file);
        } else {
          const imgUrl = img.dataUrl || img.thumbnailUrl || (img as any).url || '';
          if (imgUrl && imgUrl.startsWith('data:')) {
            const arr = imgUrl.split(',');
            const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
            const bstr = atob(arr[1]);
            let n = bstr.length;
            const u8arr = new Uint8Array(n);
            while (n--) {
              u8arr[n] = bstr.charCodeAt(n);
            }
            const file = new File([u8arr], `master_${i}.jpg`, { type: mime });
            formData.append('masterPhotos', file);
          }
        }
      }

      await fetch('/api/characters/store', {
        method: 'POST',
        body: formData,
      });
    } catch {}
  }

  async delete(id: string): Promise<void> {
    await db.characters.delete(id);
    try {
      await fetch(`/api/characters/${id}`, { method: 'DELETE' });
    } catch {}
  }
}

export const characterRepository: ICharacterRepository = new DexieCharacterRepository();
