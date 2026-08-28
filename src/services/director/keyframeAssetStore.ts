import { db } from '../../db/database';

export const keyframeAssetStore = {
  async put(id: string, shotUid: string, blob: Blob): Promise<void> {
    await db.keyframeAssets.put({
      id,
      shotUid,
      blob,
      mimeType: blob.type || 'image/png',
      updatedAt: Date.now(),
    });
  },

  async get(id: string): Promise<Blob | null> {
    if (!id) return null;
    const row = await db.keyframeAssets.get(id);
    return row?.blob || null;
  },

  async remove(id: string): Promise<void> {
    if (!id) return;
    await db.keyframeAssets.delete(id);
  },
};
