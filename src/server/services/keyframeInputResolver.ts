import crypto from 'node:crypto';
import type { ShotSpec } from '../../domain/episode/episodeTypes';
import type {
  ApprovedKeyframeInput,
  ChatGptConversationFileRef,
  SupportedKeyframeMime,
} from '../../services/episode/shotIdentitySafeRunner';
import { gcsArtifactStore, resolveVeoOutputBucket } from '../storage/gcsArtifactStore';

const MAX_KEYFRAME_BYTES = 20 * 1024 * 1024;
const SUPPORTED_MIMES = new Set<SupportedKeyframeMime>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export interface KeyframeArtifactStoreLike {
  fetchArtifactBuffer(bucketName: string, objectPath: string): Promise<Buffer>;
}

export interface KeyframeInputResolveRequest {
  shot: ShotSpec;
  openaiFileRef?: ChatGptConversationFileRef;
}

export interface KeyframeInputResolverLike {
  resolve(input: KeyframeInputResolveRequest): Promise<ApprovedKeyframeInput>;
}

export class KeyframeInputResolutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'KeyframeInputResolutionError';
  }
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deterministicAssetId(shot: ShotSpec, contentSha256: string): string {
  const digest = sha256(
    `${shot.episodeId}|${shot.shotId}|${shot.keyframe.version}|${contentSha256}`,
  ).slice(0, 32);
  const readableEpisode = shot.episodeId.slice(0, 48);
  const readableShot = shot.shotId.slice(0, 32);
  return `kf_${readableEpisode}_${readableShot}_v${shot.keyframe.version}_${digest}`;
}

function extensionForMime(mimeType: SupportedKeyframeMime): string {
  return mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
}

function detectImageMime(bytes: Buffer): SupportedKeyframeMime | null {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return 'image/png';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return null;
}

function fileRefId(fileRef: ChatGptConversationFileRef | undefined): string | undefined {
  if (typeof fileRef === 'string') return fileRef.trim() || undefined;
  return String(fileRef?.id || '').trim() || undefined;
}

function hasDurableLocation(shot: ShotSpec): boolean {
  return Boolean(
    String(shot.keyframe.outputBucket || '').trim() ||
    String(shot.keyframe.outputObjectPath || '').trim(),
  );
}

export function hasCompleteDurableKeyframeAsset(shot: ShotSpec): boolean {
  if (!hasDurableLocation(shot)) return false;
  return Boolean(
    String(shot.keyframe.assetId || '').trim() &&
    String(shot.keyframe.outputBucket || '').trim() &&
    String(shot.keyframe.outputObjectPath || '').trim() &&
    String(shot.keyframe.contentSha256 || '').trim() &&
    String(shot.keyframe.mimeType || '').trim(),
  );
}

export class KeyframeInputResolver implements KeyframeInputResolverLike {
  constructor(private readonly artifactStore: KeyframeArtifactStoreLike = gcsArtifactStore) {}

  public async resolve(input: KeyframeInputResolveRequest): Promise<ApprovedKeyframeInput> {
    const shot = input.shot;
    if (shot.keyframe.status !== 'PASS') {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_GATE_BLOCKED',
        '关键帧尚未通过 PASS，禁止解析生产输入。',
      );
    }

    if (hasDurableLocation(shot)) {
      return this.resolveDurableAsset(shot);
    }

    const fileRef = input.openaiFileRef;
    if (!fileRef) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_INPUT_REQUIRED',
        `${shot.shotId} 没有完整 durable GCS 关键帧，也没有 legacy conversation_file fallback。`,
      );
    }

    const approvedSourceId = String(shot.keyframe.sourceFileId || '').trim();
    const runtimeSourceId = fileRefId(fileRef);
    if (approvedSourceId && runtimeSourceId && approvedSourceId !== runtimeSourceId) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_SOURCE_MISMATCH',
        `上传图片不是当前 ${shot.shotId} 已批准的关键帧来源。`,
      );
    }

    return {
      source: 'conversation_file',
      openaiFileRef: fileRef,
      sourceFileId: approvedSourceId || runtimeSourceId,
      assetId: shot.keyframe.assetId,
      contentSha256: shot.keyframe.contentSha256,
      version: shot.keyframe.version,
    };
  }

  private async resolveDurableAsset(shot: ShotSpec): Promise<ApprovedKeyframeInput> {
    if (!hasCompleteDurableKeyframeAsset(shot)) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_DURABLE_ASSET_INVALID',
        `${shot.shotId} durable GCS 关键帧元数据不完整，禁止降级绕过。`,
      );
    }

    const assetId = String(shot.keyframe.assetId).trim();
    const outputBucket = String(shot.keyframe.outputBucket).trim();
    const outputObjectPath = String(shot.keyframe.outputObjectPath).trim();
    const expectedSha256 = String(shot.keyframe.contentSha256).trim().toLowerCase();
    const mimeType = String(shot.keyframe.mimeType).trim() as SupportedKeyframeMime;

    if (!Number.isInteger(shot.keyframe.version) || shot.keyframe.version < 1) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_VERSION_INVALID',
        `${shot.shotId} durable keyframe version 非法。`,
      );
    }
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_HASH_INVALID',
        `${shot.shotId} durable keyframe contentSha256 非法。`,
      );
    }
    if (!SUPPORTED_MIMES.has(mimeType)) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_MIME_INVALID',
        `${shot.shotId} durable keyframe MIME 非法。`,
      );
    }

    const authoritativeBucket = resolveVeoOutputBucket();
    if (outputBucket !== authoritativeBucket) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_BUCKET_MISMATCH',
        `${shot.shotId} durable keyframe bucket 与当前存储权威配置不一致。`,
      );
    }

    const expectedPrefix = `episodes/${shot.episodeId}/shots/${shot.shotId}/keyframes/v${shot.keyframe.version}_`;
    const expectedSuffix = `${expectedSha256.slice(0, 16)}.${extensionForMime(mimeType)}`;
    if (!outputObjectPath.startsWith(expectedPrefix) || !outputObjectPath.endsWith(expectedSuffix)) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_OBJECT_PATH_MISMATCH',
        `${shot.shotId} durable keyframe object path 与版本/hash 不一致。`,
      );
    }

    const expectedAssetId = deterministicAssetId(shot, expectedSha256);
    if (assetId !== expectedAssetId) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_ASSET_ID_MISMATCH',
        `${shot.shotId} durable keyframe assetId 与内容身份不一致。`,
      );
    }

    let buffer: Buffer;
    try {
      buffer = await this.artifactStore.fetchArtifactBuffer(outputBucket, outputObjectPath);
    } catch (error) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_GCS_FETCH_FAILED',
        `${shot.shotId} durable keyframe 无法从 GCS 读取：${error instanceof Error ? error.message : String(error)}`,
        503,
      );
    }

    if (!buffer.length || buffer.length > MAX_KEYFRAME_BYTES) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_BYTES_INVALID',
        `${shot.shotId} durable keyframe 大小非法。`,
      );
    }
    if (shot.keyframe.sizeBytes && buffer.length !== shot.keyframe.sizeBytes) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_SIZE_MISMATCH',
        `${shot.shotId} durable keyframe sizeBytes 校验失败。`,
      );
    }

    const actualMime = detectImageMime(buffer);
    if (!actualMime || actualMime !== mimeType) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_MIME_MISMATCH',
        `${shot.shotId} durable keyframe magic-byte MIME 校验失败。`,
      );
    }

    const actualSha256 = sha256(buffer);
    if (actualSha256 !== expectedSha256) {
      throw new KeyframeInputResolutionError(
        'KEYFRAME_HASH_MISMATCH',
        `${shot.shotId} durable keyframe SHA256 校验失败。`,
      );
    }

    return {
      source: 'durable_gcs_asset',
      buffer,
      mimeType,
      fileName: `${shot.shotId}-keyframe-v${shot.keyframe.version}.${extensionForMime(mimeType)}`,
      assetId,
      contentSha256: actualSha256,
      version: shot.keyframe.version,
      outputBucket,
      outputObjectPath,
    };
  }
}

export const keyframeInputResolver = new KeyframeInputResolver();
