import type { GoogleGenAI } from '@google/genai';
import type { ServerVideoTaskRecord } from '../../types';
import { VideoInspector } from '../../services/video/videoInspector';
import { VideoIdentityQaService, type VideoIdentityQaReport } from '../../services/qa/videoIdentityQaService';
import { gcsArtifactStore } from '../storage/gcsArtifactStore';

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

    const approvedFirstFrame = await gcsArtifactStore.fetchArtifactBuffer(
      task.outputBucket,
      task.qaApprovedFirstFrameObjectPath,
      { session }
    );

    const masterImages = await Promise.all(
      task.qaMasterImageObjectPaths.map((objectPath) =>
        gcsArtifactStore.fetchArtifactBuffer(task.outputBucket!, objectPath, { session })
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
