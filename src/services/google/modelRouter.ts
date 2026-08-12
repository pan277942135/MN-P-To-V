import type { ActiveSession } from './credentialService';

export interface ModelConfig {
  analysisModel: string;
  imageModel: string;
  videoModel: string;
}

export const RECOMMENDED_MODELS = {
  analysisModel: 'gemini-2.5-flash',
  imageModel: 'gemini-2.5-flash',
  geminiKeyVideoModel: 'gemini-2.5-flash',
  vertexVideoModel: 'veo-3.1-fast-generate-001',
};

export const VERTEX_RECOMMENDED_MODELS = {
  analysisModel: 'gemini-2.5-flash',
  imageModel: 'gemini-2.5-flash',
  videoModel: 'veo-3.1-fast-generate-001',
};

export class ModelRouter {
  static getEffectiveModels(
    session: ActiveSession,
    userOverrides?: Partial<ModelConfig>
  ): ModelConfig {
    const isVertex = session.type === 'vertex_ai';
    const defaultAnalysis = isVertex
      ? VERTEX_RECOMMENDED_MODELS.analysisModel
      : RECOMMENDED_MODELS.analysisModel;
    const defaultImage = isVertex
      ? VERTEX_RECOMMENDED_MODELS.imageModel
      : RECOMMENDED_MODELS.imageModel;
    const defaultVideo = isVertex
      ? RECOMMENDED_MODELS.vertexVideoModel
      : RECOMMENDED_MODELS.geminiKeyVideoModel;

    let analysisModel =
      userOverrides?.analysisModel || session.analysisModel || defaultAnalysis;
    let imageModel =
      userOverrides?.imageModel || session.imageModel || defaultImage;
    let videoModel =
      userOverrides?.videoModel || session.videoModel || defaultVideo;

    // Normalize any legacy/deprecated model names
    const analysisStr = typeof analysisModel === 'string' ? analysisModel : String(analysisModel || '');
    const imageStr = typeof imageModel === 'string' ? imageModel : String(imageModel || '');
    const videoStr = typeof videoModel === 'string' ? videoModel : String(videoModel || '');

    if (analysisStr.includes('3.6') || analysisStr.startsWith('gemini-3')) {
      analysisModel = 'gemini-2.5-flash';
    }
    if (imageStr.includes('3.1') || imageStr.startsWith('gemini-3')) {
      imageModel = 'gemini-2.5-flash';
    }
    if (
      videoStr.includes('veo-2.0') ||
      videoStr.includes('preview')
    ) {
      videoModel = 'veo-3.1-fast-generate-001';
    }

    if (isVertex) {
      if (videoStr.includes('omni')) {
        videoModel = RECOMMENDED_MODELS.vertexVideoModel;
      }
    } else {
      if (videoStr.includes('veo-3')) {
        videoModel = RECOMMENDED_MODELS.geminiKeyVideoModel;
      }
    }

    return {
      analysisModel,
      imageModel,
      videoModel,
    };
  }
}
