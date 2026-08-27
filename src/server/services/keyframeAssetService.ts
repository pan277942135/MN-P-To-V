import crypto from 'node:crypto';
import sharp from 'sharp';
import type { KeyframeProvider, ShotSpec } from '../../domain/episode/episodeTypes';
import { gcsArtifactStore, resolveVeoOutputBucket } from '../storage/gcsArtifactStore';
import { firestoreShotRepository } from '../repositories/firestoreShotRepository';

const MAX_KEYFRAME_BYTES = 20 * 1024 * 1024;
type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface PersistKeyframeAssetInput {
  episodeId: string;
  shotId: string;
  provider: KeyframeProvider;
  buffer: Buffer;
  declaredMimeType?: string;
  sourceFileId?: string;
  providerModel?: string;
  prompt?: string;
  expectedVersion?: number;
}
export interface PersistKeyframeAssetResult {
  shot: ShotSpec; assetId: string; contentSha256: string; mimeType: SupportedImageMime;
  sizeBytes: number; width: number; height: number; outputBucket: string; outputObjectPath: string; reusedExistingAsset: boolean;
}

function sha256(value: Buffer | string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function detectImageMime(buffer: Buffer): SupportedImageMime | null {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
function extensionForMime(mimeType: SupportedImageMime): string { return mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg'; }
function assertProviderInput(provider: KeyframeProvider, sourceFileId?: string, providerModel?: string): void {
  if (provider === 'CHATGPT_UPLOAD' && !String(sourceFileId || '').trim()) throw new Error('KEYFRAME_SOURCE_FILE_REQUIRED: CHATGPT_UPLOAD requires sourceFileId.');
  if (provider === 'GEMINI_GENERATED' && !String(providerModel || '').trim()) throw new Error('KEYFRAME_PROVIDER_MODEL_REQUIRED: GEMINI_GENERATED requires providerModel.');
}
function buildAssetId(episodeId: string, shotId: string, version: number, contentSha256: string): string {
  const identityHash = sha256(`${episodeId}|${shotId}|${version}|${contentSha256}`).slice(0, 32);
  return `kf_${episodeId.slice(0, 48)}_${shotId.slice(0, 32)}_v${version}_${identityHash}`;
}

export class KeyframeAssetService {
  public static async persist(input: PersistKeyframeAssetInput): Promise<PersistKeyframeAssetResult> {
    if (!input.buffer || input.buffer.length === 0) throw new Error('KEYFRAME_EMPTY: keyframe buffer is empty.');
    if (input.buffer.length > MAX_KEYFRAME_BYTES) throw new Error(`KEYFRAME_TOO_LARGE: keyframe exceeds ${MAX_KEYFRAME_BYTES} bytes.`);
    assertProviderInput(input.provider, input.sourceFileId, input.providerModel);

    const shot = await firestoreShotRepository.getShot(input.episodeId, input.shotId);
    if (!shot) throw new Error('KEYFRAME_SHOT_NOT_FOUND');
    if (shot.status === 'COMPLETED' || shot.status === 'CANCELLED') throw new Error(`KEYFRAME_SHOT_IMMUTABLE: cannot replace keyframe for ${shot.status} shot.`);
    if (shot.keyframe.provider !== input.provider) throw new Error(`KEYFRAME_PROVIDER_MISMATCH: planned=${shot.keyframe.provider}, received=${input.provider}`);

    const version = input.expectedVersion ?? shot.keyframe.version;
    const sameVersion = version === shot.keyframe.version;
    const validRetryVersion = shot.keyframe.status === 'FAIL' && version === shot.keyframe.version + 1;
    if (!sameVersion && !validRetryVersion) throw new Error(`KEYFRAME_VERSION_CONFLICT: expected=${version}, current=${shot.keyframe.version}`);

    const mimeType = detectImageMime(input.buffer);
    if (!mimeType) throw new Error('KEYFRAME_CONTENT_INVALID: only JPEG, PNG and WebP are supported.');
    if (input.declaredMimeType && input.declaredMimeType !== mimeType) throw new Error(`KEYFRAME_MIME_MISMATCH: declared=${input.declaredMimeType}, detected=${mimeType}`);

    let metadata: { width?: number; height?: number };
    try { metadata = await sharp(input.buffer).metadata(); }
    catch (error: any) { throw new Error(`KEYFRAME_DECODE_FAILED: ${String(error?.message || error)}`); }
    const width = Number(metadata.width || 0); const height = Number(metadata.height || 0);
    if (!width || !height) throw new Error('KEYFRAME_DIMENSIONS_INVALID');

    const contentSha256 = sha256(input.buffer);
    const promptHash = input.prompt ? sha256(input.prompt) : undefined;
    const assetId = buildAssetId(input.episodeId, input.shotId, version, contentSha256);
    const outputObjectPath = `episodes/${input.episodeId}/shots/${input.shotId}/keyframes/v${version}_${contentSha256.slice(0, 16)}.${extensionForMime(mimeType)}`;

    if (shot.keyframe.version === version && shot.keyframe.contentSha256 === contentSha256 && shot.keyframe.assetId === assetId && shot.keyframe.outputBucket && shot.keyframe.outputObjectPath) {
      return { shot, assetId, contentSha256, mimeType, sizeBytes: shot.keyframe.sizeBytes || input.buffer.length, width: shot.keyframe.width || width, height: shot.keyframe.height || height, outputBucket: shot.keyframe.outputBucket, outputObjectPath: shot.keyframe.outputObjectPath, reusedExistingAsset: true };
    }

    const bucketName = resolveVeoOutputBucket();
    const existedBefore = await gcsArtifactStore.artifactExists(bucketName, outputObjectPath).catch(() => false);
    const artifact = await gcsArtifactStore.uploadImageArtifact({ objectPath: outputObjectPath, buffer: input.buffer, contentType: mimeType });
    try {
      const updated = await firestoreShotRepository.bindKeyframeAsset({
        episodeId: input.episodeId, shotId: input.shotId, provider: input.provider, expectedVersion: version,
        asset: { assetId, sourceFileId: input.sourceFileId, outputBucket: artifact.outputBucket, outputObjectPath: artifact.outputObjectPath, contentSha256, mimeType, sizeBytes: artifact.sizeBytes, width, height, providerModel: input.providerModel, promptHash, persistedAt: artifact.artifactPersistedAt || Date.now() },
      });
      return { shot: updated, assetId, contentSha256, mimeType, sizeBytes: artifact.sizeBytes, width, height, outputBucket: artifact.outputBucket, outputObjectPath: artifact.outputObjectPath, reusedExistingAsset: false };
    } catch (error) {
      if (!existedBefore) await gcsArtifactStore.deleteVideoArtifact(artifact.outputBucket, artifact.outputObjectPath).catch(() => false);
      throw error;
    }
  }
}
