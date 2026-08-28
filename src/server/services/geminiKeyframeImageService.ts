import { GoogleGenAI } from '@google/genai';

export interface KeyframeImageGenerationInput {
  prompt: string;
  negativePrompt?: string;
  characterHint?: string;
  referenceImageBase64?: string;
  referenceMimeType?: string;
  aspectRatio?: '9:16';
  imageSize?: '1K';
}

export interface KeyframeImageGenerationResult {
  provider: 'vertex-gemini-image';
  model: string;
  generatedAt: number;
  mimeType: string;
  imageBase64: string;
}

export interface KeyframeImageGeneratorLike {
  generate(input: KeyframeImageGenerationInput): Promise<KeyframeImageGenerationResult>;
}

export interface GeminiImageClientLike {
  models: {
    generateContent(args: Record<string, unknown>): Promise<any>;
  };
}

export class KeyframeImageGenerationError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 502) {
    super(message);
    this.name = 'KeyframeImageGenerationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function validateInput(input: KeyframeImageGenerationInput) {
  const prompt = clean(input.prompt);
  const negativePrompt = clean(input.negativePrompt);
  const characterHint = clean(input.characterHint);
  const referenceImageBase64 = clean(input.referenceImageBase64);
  const referenceMimeType = clean(input.referenceMimeType) || 'image/jpeg';

  if (!prompt) {
    throw new KeyframeImageGenerationError(
      'KEYFRAME_IMAGE_PROMPT_REQUIRED',
      '关键帧图片生成 Prompt 不能为空。',
      400,
    );
  }
  if (prompt.length + negativePrompt.length + characterHint.length > 16_000) {
    throw new KeyframeImageGenerationError(
      'KEYFRAME_IMAGE_PROMPT_TOO_LARGE',
      '关键帧图片生成输入过长，请控制在 16,000 字符以内。',
      413,
    );
  }
  if (referenceImageBase64.length > 24_000_000) {
    throw new KeyframeImageGenerationError(
      'KEYFRAME_REFERENCE_TOO_LARGE',
      '角色参考图过大，请使用更小的参考图片。',
      413,
    );
  }
  if (referenceImageBase64 && !/^image\//.test(referenceMimeType)) {
    throw new KeyframeImageGenerationError(
      'KEYFRAME_REFERENCE_INVALID',
      '角色参考图 MIME 类型无效。',
      400,
    );
  }

  return {
    prompt,
    negativePrompt,
    characterHint,
    referenceImageBase64,
    referenceMimeType,
    aspectRatio: '9:16' as const,
    imageSize: '1K' as const,
  };
}

function buildPrompt(input: ReturnType<typeof validateInput>, hasReference: boolean) {
  return [
    '你是“造境 Director”的关键帧摄影师。生成一张可直接作为后续图生视频首帧的竖屏电影感关键帧。',
    '必须是一个稳定的静态瞬间：主体清晰、空间关系明确、构图完整，不画分镜格，不出现字幕、UI、水印或说明文字。',
    hasReference
      ? '已提供角色参考图：严格保持参考图中的同一角色身份、脸部结构、年龄感与整体辨识度；不得换脸或重新设计人物。'
      : '若画面有人物，严格遵守 Prompt 中的角色身份与连续性描述。',
    input.characterHint ? `角色约束：${input.characterHint}` : '',
    `关键帧 Prompt：${input.prompt}`,
    input.negativePrompt ? `必须避免：${input.negativePrompt}` : '',
    '输出比例固定 9:16。只生成一张最终关键帧图片。',
  ].filter(Boolean).join('\n');
}

function firstImagePart(response: any): { data: string; mimeType: string } | null {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inlineData = part?.inlineData || part?.inline_data;
      const data = clean(inlineData?.data);
      if (!data) continue;
      return {
        data,
        mimeType: clean(inlineData?.mimeType || inlineData?.mime_type) || 'image/png',
      };
    }
  }
  return null;
}

export class GeminiKeyframeImageService implements KeyframeImageGeneratorLike {
  constructor(
    private readonly client: GeminiImageClientLike,
    private readonly model: string,
  ) {}

  async generate(rawInput: KeyframeImageGenerationInput): Promise<KeyframeImageGenerationResult> {
    const input = validateInput(rawInput);
    const parts: Record<string, unknown>[] = [];

    if (input.referenceImageBase64) {
      parts.push({
        inlineData: {
          data: input.referenceImageBase64,
          mimeType: input.referenceMimeType,
        },
      });
    }
    parts.push({ text: buildPrompt(input, Boolean(input.referenceImageBase64)) });

    let response: any;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          candidateCount: 1,
          imageConfig: {
            aspectRatio: input.aspectRatio,
            imageSize: input.imageSize,
          },
        },
      });
    } catch (error: any) {
      const statusCode = Number(error?.status || error?.statusCode || error?.code);
      throw new KeyframeImageGenerationError(
        'GEMINI_KEYFRAME_IMAGE_REQUEST_FAILED',
        error?.message || 'Gemini 关键帧图片生成请求失败。',
        Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 502,
      );
    }

    const image = firstImagePart(response);
    if (!image) {
      throw new KeyframeImageGenerationError(
        'GEMINI_KEYFRAME_IMAGE_EMPTY',
        'Gemini 未返回可用的关键帧图片。请检查 Prompt 或安全策略后重试。',
      );
    }

    return {
      provider: 'vertex-gemini-image',
      model: this.model,
      generatedAt: Date.now(),
      mimeType: image.mimeType,
      imageBase64: image.data,
    };
  }
}

export function createDefaultGeminiKeyframeImageService(): GeminiKeyframeImageService {
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
  const location = process.env.DIRECTOR_KEYFRAME_IMAGE_LOCATION || 'global';
  const model = process.env.DIRECTOR_KEYFRAME_IMAGE_MODEL || 'gemini-3.1-flash-image';
  const client = new GoogleGenAI({
    vertexai: true,
    project,
    location,
  }) as unknown as GeminiImageClientLike;
  return new GeminiKeyframeImageService(client, model);
}
