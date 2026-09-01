import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
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

  it('returns upload validation and keeps a convertible ratio as WARNING', async () => {
    const landscape = await sharp({
      create: { width: 1920, height: 1080, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } },
    }).png().toBuffer();
    const saved: DirectorCloudSnapshot[] = [];
    let putCount = 0;
    const repository = {
      isAvailable: () => true,
      upsertSnapshot: async (value: DirectorCloudSnapshot): Promise<DirectorCloudProjectRecord> => {
        saved.push(value);
        return { snapshot: value, serverUpdatedAt: 789 };
      },
      getSnapshot: async () => null,
      getLatestSnapshot: async () => null,
    };
    const assetStore = {
      putKeyframe: async (input: any) => {
        putCount += 1;
        return {
          shotUid: input.shotUid,
          blobKey: input.blobKey,
          bucket: 'bucket-1',
          objectPath: `director/${input.shotUid}/${input.blobKey}.png`,
          uri: `gs://bucket-1/director/${input.shotUid}/${input.blobKey}.png`,
          mimeType: input.mimeType,
          sizeBytes: input.buffer.length,
          generation: '1',
          updatedAt: 999,
        };
      },
      getAsset: async () => ({ buffer: Buffer.from('asset'), mimeType: 'image/png' }),
    };
    const assetRegistry = {
      syncLegacySnapshotAssets: async () => [{
        assetId: 'registry-a',
        source: { sourceId: 'shot-a:blob-a' },
      }],
    };
    const service = new DirectorCloudPersistenceService(repository as any, assetStore as any, assetRegistry as any);
    const result = await service.sync({
      ...snapshot(),
      formatPolicy: {
        defaultAspectRatio: '16:9',
        allowedAspectRatios: ['16:9', '9:16'],
        allowShotOverride: true,
      },
    }, [{
      shotUid: 'shot-a',
      blobKey: 'blob-a',
      mimeType: 'image/png',
      base64: landscape.toString('base64'),
      validate: true,
    }]);

    expect(putCount).toBe(1);
    expect(result.assetUploads[0]).toMatchObject({
      assetId: 'registry-a',
      validation: { status: 'VALID', actualAspectRatio: '16:9', expectedAspectRatio: '16:9' },
    });
    expect(saved).toHaveLength(1);
  });

  it('does not persist an INVALID strict upload but still returns its validation', async () => {
    let putCount = 0;
    const repository = {
      isAvailable: () => true,
      upsertSnapshot: async (value: DirectorCloudSnapshot): Promise<DirectorCloudProjectRecord> => ({ snapshot: value, serverUpdatedAt: 790 }),
      getSnapshot: async () => null,
      getLatestSnapshot: async () => null,
    };
    const assetStore = {
      putKeyframe: async () => { putCount += 1; throw new Error('should not put'); },
      getAsset: async () => ({ buffer: Buffer.from('asset'), mimeType: 'image/png' }),
    };
    const service = new DirectorCloudPersistenceService(repository as any, assetStore as any, { syncLegacySnapshotAssets: async () => [] } as any);
    const result = await service.sync({ ...snapshot(), formatPolicy: {
      defaultAspectRatio: '16:9',
      allowedAspectRatios: ['16:9'],
      allowShotOverride: true,
    } }, [{
      shotUid: 'shot-a',
      blobKey: 'bad-a',
      mimeType: 'application/pdf',
      base64: Buffer.from('not-media').toString('base64'),
      validate: true,
    }]);

    expect(putCount).toBe(0);
    expect(result.assetUploads[0].validation.status).toBe('INVALID');
  });
});
