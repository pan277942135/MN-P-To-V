import { Storage } from '@google-cloud/storage';
import type { GoogleGenAI } from '@google/genai';
import type { ServerVideoTaskRecord } from '../../types';
import { VideoInspector } from '../../services/video/videoInspector';
import { VideoIdentityQaService, type VideoIdentityQaReport } from '../../services/qa/videoIdentityQaService';
import { gcsArtifactStore } from '../storage/gcsArtifactStore';

function isSupportedImageBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  const isWebp =
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return isJpeg || isPng || isWebp;
}

async function fetchExactQaImage(
  bucket: string,
  objectPath: string,
  session?: any
): Promise<Buffer> {
  // Unit/integration tests rely on the in-memory GCS mock. Production QA anchors,
  // however, are owned by this Cloud Run service and must be read by exact object path.
  // Never use fetchArtifactBuffer here: that video-oriented helper intentionally falls
  // back from missing task objects to veo/<task>/video.mp4, which can turn an image read
  // into MP4 bytes and cause Gemini INVALID_ARGUMENT: "Provided image is not valid."
  if (process.env.NODE_ENV === 'test' || (gcsArtifactStore as any).useMock) {
    const buffer = await gcsArtifactStore.fetchArtifactBuffer(bucket, objectPath, { session });
    if (!isSupportedImageBuffer(buffer)) {
      throw new Error(`VIDEO_QA_IMAGE_ANCHOR_INVALID: ${objectPath} is not JPEG/PNG/WebP`);
    }
    return buffer;
  }

  const storage = new Storage();
  const [bytes] = await storage.bucket(bucket).file(objectPath).download();
  const buffer = Buffer.from(bytes);
  if (!isSupportedImageBuffer(buffer)) {
    throw new Error(`VIDEO_QA_IMAGE_ANCHOR_INVALID: ${objectPath} is not JPEG/PNG/WebP`);
  }
  return buffer;
}

export class DurableVideoIdentityQaService {
  static async run(params: {
    task: ServerVideoTaskRecord;
    videoBuffer: Buffer;
    ai: GoogleGenAI;
    analysisModel: string;
    session?: any;
  }): Promise<VideoIdentityQaReport> {
    const { task, videoBuffer, ai, analysisModel, session } = params;

    if (task.artifactPersisted !== true || !task.outputBucket || !task.outputObjectPath) {
      throw new Error('VIDEO_QA_ARTIFACT_NOT_PERSISTED: 视频必须先持久化至 Authority GCS 再执行 QA');
    }
    if (!task.qaApprovedFirstFrameObjectPath) {
      throw new Error('VIDEO_QA_IDENTITY_REFERENCE_MISSING: 缺失已批准首帧持久化锚点');
    }
    if (!task.qaMasterImageObjectPaths || task.qaMasterImageObjectPaths.length === 0) {
      throw new Error('VIDEO_QA_IDENTITY_REFERENCE_MISSING: 缺失角色母板持久化锚点');
    }
    if (!task.identitySpec) {
      throw new Error('VIDEO_QA_IDENTITY_REFERENCE_MISSING: 缺失 IdentitySpec');
    }

    const inspection = await VideoInspector.inspectAndExtractFrames(videoBuffer);
    if (!inspection.valid) {
      throw new Error(`VIDEO_QA_MEDIA_INVALID: ${inspection.issueReason || '真实视频检查失败'}`);
    }

    const approvedFirstFrame = await fetchExactQaImage(
      task.outputBucket,
      task.qaApprovedFirstFrameObjectPath,
      session
    );

    const masterImages = await Promise.all(
      task.qaMasterImageObjectPaths.map((objectPath) =>
        fetchExactQaImage(task.outputBucket!, objectPath, session)
      )
    );

    return await VideoIdentityQaService.qaVideoIdentity({
      ai,
      analysisModel,
      samples: inspection.extractedFrames,
      approvedFirstFrame,
      approvedFirstFrameMimeType: task.qaApprovedFirstFrameMimeType || 'image/jpeg',
      masterImages,
      masterMimeTypes: task.qaMasterImageMimeTypes || [],
      identitySpec: task.identitySpec,
      characterDescription: task.characterDescription || '',
      samplingStrategyVersion: inspection.samplingStrategyVersion || 'unspecified',
    });
  }
}
