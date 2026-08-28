import { describe, expect, it } from 'vitest';
import {
  DIRECTOR_CLOUD_SCHEMA,
  buildDirectorShotDocuments,
  type DirectorCloudProjectRecord,
  type DirectorCloudSnapshot,
} from '../server/repositories/firestoreDirectorProjectRepository';
import { DirectorCloudPersistenceService } from '../server/services/directorCloudPersistenceService';

function snapshot(): DirectorCloudSnapshot {
  return {
    schema: DIRECTOR_CLOUD_SCHEMA,
    projectId: 'project-1',
    episodeId: 'episode-1',
    seriesTitle: '《风从那年教室吹过》系列',
    projectTitle: 'EP01',
    clientUpdatedAt: 123,
    stages: {
      storyboard: {
        shots: [
          { uid: 'shot-a', title: '教室', durationSeconds: 4 },
          { uid: 'shot-b', title: '走廊', durationSeconds: 5 },
        ],
      },
      keyframeBlueprint: {
        blueprints: [{ shotUid: 'shot-a', uid: 'bp-a' }, { shotUid: 'shot-b', uid: 'bp-b' }],
      },
      keyframeAssets: {
        assets: [
          { shotUid: 'shot-a', blobKey: 'blob-a', status: 'PASS' },
          { shotUid: 'shot-b', blobKey: 'blob-b', status: 'PASS' },
        ],
      },
      keyframeQa: {
        items: [{ shotUid: 'shot-a', autoStatus: 'PASS' }, { shotUid: 'shot-b', autoStatus: 'PASS' }],
      },
      videoBlueprint: {
        items: [{ shotUid: 'shot-a', productionDurationSeconds: 4 }, { shotUid: 'shot-b', productionDurationSeconds: 6 }],
      },
    },
  };
}

describe('DirectorCloudPersistenceService', () => {
  it('normalizes the Director project into stable per-shot Firestore documents', () => {
    const docs = buildDirectorShotDocuments(snapshot());
    expect(docs).toHaveLength(2);
    expect(docs[0].shotUid).toBe('shot-a');
    expect((docs[0] as any).storyboard.title).toBe('教室');
    expect((docs[0] as any).keyframeBlueprint.uid).toBe('bp-a');
    expect((docs[1] as any).videoBlueprint.productionDurationSeconds).toBe(6);
  });

  it('uploads local keyframes to GCS, records cloud refs, and persists the full snapshot', async () => {
    let saved: DirectorCloudSnapshot | null = null;
    const repository = {
      isAvailable: () => true,
      upsertSnapshot: async (value: DirectorCloudSnapshot): Promise<DirectorCloudProjectRecord> => {
        saved = value;
        return { snapshot: value, serverUpdatedAt: 456 };
      },
      getSnapshot: async () => saved ? { snapshot: saved, serverUpdatedAt: 456 } : null,
      getLatestSnapshot: async () => saved ? { snapshot: saved, serverUpdatedAt: 456 } : null,
    };
    const assetStore = {
      putKeyframe: async (input: any) => ({
        shotUid: input.shotUid,
        blobKey: input.blobKey,
        bucket: 'bucket-1',
        objectPath: `director/${input.shotUid}/${input.blobKey}.png`,
        uri: `gs://bucket-1/director/${input.shotUid}/${input.blobKey}.png`,
        mimeType: input.mimeType,
        sizeBytes: input.buffer.length,
        generation: '1',
        updatedAt: 999,
      }),
      getAsset: async () => ({ buffer: Buffer.from('asset'), mimeType: 'image/png' }),
    };
    const service = new DirectorCloudPersistenceService(repository as any, assetStore as any);
    const record = await service.sync(snapshot(), [
      { shotUid: 'shot-a', blobKey: 'blob-a', mimeType: 'image/png', base64: Buffer.from('image-a').toString('base64') },
      { shotUid: 'shot-b', blobKey: 'blob-b', mimeType: 'image/png', base64: Buffer.from('image-b').toString('base64') },
    ]);

    expect(record.serverUpdatedAt).toBe(456);
    expect(saved).not.toBeNull();
    const cloudItems = (saved as any).stages.keyframeCloudAssets.items;
    expect(cloudItems).toHaveLength(2);
    expect(cloudItems[0].uri).toContain('gs://bucket-1/');

    const restored = await service.getKeyframeAsset('project-1', 'episode-1', 'shot-a', 'blob-a');
    expect(restored?.buffer.toString()).toBe('asset');
    expect(restored?.ref.blobKey).toBe('blob-a');
  });
});
