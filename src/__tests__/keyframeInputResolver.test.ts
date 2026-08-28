import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SHOT_SCHEMA_VERSION, type ShotSpec } from '../domain/episode/episodeTypes';
import { KeyframeInputResolver } from '../server/services/keyframeInputResolver';
import { EXPECTED_PRODUCTION_VEO_BUCKET } from '../server/storage/gcsArtifactStore';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function hash(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function durableShot(overrides: Partial<ShotSpec> = {}): ShotSpec {
  const contentSha256 = hash(PNG);
  const episodeId = 'MN-EP001';
  const shotId = 'S02';
  const version = 1;
  const assetDigest = hash(`${episodeId}|${shotId}|${version}|${contentSha256}`).slice(0, 32);
  return {
    episodeId,
    shotId,
    order: 1,
    durationSeconds: 4,
    status: 'VIDEO_PENDING',
    scene: { location: 'rental room' },
    action: 'build staff',
    camera: 'fixed',
    props: ['staff'],
    keyframe: {
      provider: 'CHATGPT_UPLOAD',
      status: 'PASS',
      assetId: `kf_${episodeId}_${shotId}_v${version}_${assetDigest}`,
      sourceFileId: 'file_s02',
      outputBucket: EXPECTED_PRODUCTION_VEO_BUCKET,
      outputObjectPath: `episodes/${episodeId}/shots/${shotId}/keyframes/v${version}_${contentSha256.slice(0, 16)}.png`,
      contentSha256,
      mimeType: 'image/png',
      sizeBytes: PNG.length,
      version,
      generationAttempt: 1,
      qaAttempt: 1,
    },
    video: {
      provider: 'VEO',
      status: 'PENDING',
      providerAttempt: 0,
      qaAttempt: 0,
    },
    schemaVersion: SHOT_SCHEMA_VERSION,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    ...overrides,
  };
}

describe('KeyframeInputResolver P0-7', () => {
  it('prefers and verifies the durable GCS keyframe even when a conversation fallback is supplied', async () => {
    const store = { fetchArtifactBuffer: vi.fn(async () => PNG) };
    const resolver = new KeyframeInputResolver(store);
    const shot = durableShot();

    const result = await resolver.resolve({
      shot,
      openaiFileRef: { id: 'file_s02', download_link: 'https://files.openai.com/s02' },
    });

    expect(result.source).toBe('durable_gcs_asset');
    if (result.source !== 'durable_gcs_asset') throw new Error('expected durable source');
    expect(result.buffer.equals(PNG)).toBe(true);
    expect(result.contentSha256).toBe(shot.keyframe.contentSha256);
    expect(store.fetchArtifactBuffer).toHaveBeenCalledWith(
      EXPECTED_PRODUCTION_VEO_BUCKET,
      shot.keyframe.outputObjectPath,
    );
  });

  it('fails closed on durable content hash mismatch instead of falling back to conversation_file', async () => {
    const corrupted = Buffer.from(PNG);
    corrupted[corrupted.length - 1] ^= 0xff;
    const resolver = new KeyframeInputResolver({ fetchArtifactBuffer: vi.fn(async () => corrupted) });

    await expect(resolver.resolve({
      shot: durableShot(),
      openaiFileRef: { id: 'file_s02', download_link: 'https://files.openai.com/s02' },
    })).rejects.toMatchObject({ code: 'KEYFRAME_HASH_MISMATCH' });
  });

  it('uses conversation_file only for legacy shots without a durable GCS location', async () => {
    const shot = durableShot();
    shot.keyframe = {
      ...shot.keyframe,
      outputBucket: undefined,
      outputObjectPath: undefined,
      contentSha256: undefined,
      mimeType: undefined,
      sizeBytes: undefined,
    };
    const store = { fetchArtifactBuffer: vi.fn(async () => PNG) };
    const resolver = new KeyframeInputResolver(store);

    const result = await resolver.resolve({ shot, openaiFileRef: { id: 'file_s02' } });

    expect(result).toMatchObject({ source: 'conversation_file', sourceFileId: 'file_s02' });
    expect(store.fetchArtifactBuffer).not.toHaveBeenCalled();
  });

  it('rejects partially persisted durable metadata rather than silently downgrading', async () => {
    const shot = durableShot();
    shot.keyframe = { ...shot.keyframe, contentSha256: undefined };
    const resolver = new KeyframeInputResolver({ fetchArtifactBuffer: vi.fn(async () => PNG) });

    await expect(resolver.resolve({
      shot,
      openaiFileRef: { id: 'file_s02' },
    })).rejects.toMatchObject({ code: 'KEYFRAME_DURABLE_ASSET_INVALID' });
  });
});
