import { GoogleGenAI, Type } from '@google/genai';

export interface KeyframeQaReferenceInput {
  imageBase64: string;
  mimeType: string;
}

export interface KeyframeQaGenerationInput {
  shotLabel: string;
  prompt: string;
  continuity: string;
  candidateImageBase64: string;
  candidateMimeType: string;
  characterHint?: string;
  masterReferences?: KeyframeQaReferenceInput[];
  previousKeyframe?: KeyframeQaReferenceInput | null;
}

export interface KeyframeQaGenerationResult {
  provider: 'vertex-gemini-qa';
  model: string;
  analyzedAt: number;
  pass: boolean;
  identityAssessed: boolean;
  continuityAssessed: boolean;
  scores: {
    identityScore: number | null;
    promptComplianceScore: number;
    anatomyScore: number;
    visualQualityScore: number;
    compositionScore: number;
    continuityScore: number | null;
  };
  issues: Array<{
    code: string;
    severity: 'warning' | 'major' | 'critical';
    description: string;
    repairInstruction: string;
  }>;
  warnings: string[];
  summary: string;
  repairInstruction: string;
}

export interface KeyframeQaGeneratorLike {
  analyze(input: KeyframeQaGenerationInput): Promise<KeyframeQaGenerationResult>;
}

export interface GeminiQaClientLike {
  models: {
    generateContent(args: Record<string, unknown>): Promise<any>;
  };
}

export class KeyframeQaGenerationError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 502) {
    super(message);
    this.name = 'KeyframeQaGenerationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function score(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeIssue(value: any) {
  const severity = ['warning', 'major', 'critical'].includes(String(value?.severity))
    ? value.severity as 'warning' | 'major' | 'critical'
    : 'major';
  return {
    code: clean(value?.code) || 'QA_ISSUE',
    severity,
    description: clean(value?.description),
    repairInstruction: clean(value?.repairInstruction),
  };
}

function validateInput(input: KeyframeQaGenerationInput) {
  const prompt = clean(input.prompt);
  const continuity = clean(input.continuity);
  const candidateImageBase64 = clean(input.candidateImageBase64);
  const candidateMimeType = clean(input.candidateMimeType) || 'image/png';
  const masterReferences = (input.masterReferences || [])
    .filter((item) => clean(item?.imageBase64))
    .slice(0, 4)
    .map((item) => ({
      imageBase64: clean(item.imageBase64),
      mimeType: clean(item.mimeType) || 'image/jpeg',
    }));
  const previousKeyframe = input.previousKeyframe && clean(input.previousKeyframe.imageBase64)
    ? {
        imageBase64: clean(input.previousKeyframe.imageBase64),
        mimeType: clean(input.previousKeyframe.mimeType) || 'image/png',
      }
    : null;

  if (!prompt) {
    throw new KeyframeQaGenerationError('KEYFRAME_QA_PROMPT_REQUIRED', '关键帧 QA 缺少 Blueprint Prompt。', 400);
  }
  if (!candidateImageBase64 || !candidateMimeType.startsWith('image/')) {
    throw new KeyframeQaGenerationError('KEYFRAME_QA_IMAGE_REQUIRED', '关键帧 QA 缺少有效候选图片。', 400);
  }
  const totalBase64 = candidateImageBase64.length +
    masterReferences.reduce((sum, item) => sum + item.imageBase64.length, 0) +
    (previousKeyframe?.imageBase64.length || 0);
  if (totalBase64 > 55_000_000) {
    throw new KeyframeQaGenerationError('KEYFRAME_QA_INPUT_TOO_LARGE', '关键帧 QA 图片输入过大，请压缩参考图后重试。', 413);
  }

  return {
    shotLabel: clean(input.shotLabel),
    prompt,
    continuity,
    candidateImageBase64,
    candidateMimeType,
    characterHint: clean(input.characterHint),
    masterReferences,
    previousKeyframe,
  };
}

export class GeminiKeyframeQaService implements KeyframeQaGeneratorLike {
  constructor(
    private readonly client: GeminiQaClientLike,
    private readonly model: string,
  ) {}

  async analyze(rawInput: KeyframeQaGenerationInput): Promise<KeyframeQaGenerationResult> {
    const input = validateInput(rawInput);
    const identityAssessed = input.masterReferences.length > 0;
    const continuityAssessed = Boolean(input.previousKeyframe);
    const parts: Record<string, unknown>[] = [];

    input.masterReferences.forEach((reference, index) => {
      parts.push({ inlineData: { data: reference.imageBase64, mimeType: reference.mimeType } });
      parts.push({ text: `[MASTER_REFERENCE_${index + 1}] 同一目标角色的身份母板参考图。` });
    });

    if (input.previousKeyframe) {
      parts.push({ inlineData: { data: input.previousKeyframe.imageBase64, mimeType: input.previousKeyframe.mimeType } });
      parts.push({ text: '[PREVIOUS_KEYFRAME] 上一镜已准备的关键帧，仅用于判断人物/服装/道具/状态/方向连续性。' });
    }

    parts.push({ inlineData: { data: input.candidateImageBase64, mimeType: input.candidateMimeType } });
    parts.push({ text: '[CURRENT_KEYFRAME] 当前待质检关键帧。' });

    const promptText = `
你是“造境 Director”的关键帧自动 QA 引擎。你的任务不是美学点评，而是判断这张关键帧是否足够稳定、准确，能进入后续图生视频。

镜头：${input.shotLabel || '未标号'}
Blueprint Prompt：${input.prompt}
连续性约束：${input.continuity || '无额外文字约束'}
角色约束：${input.characterHint || '未提供'}

必须按以下规则检查：
1. promptComplianceScore：是否符合 Blueprint 的人物、动作冻结瞬间、场景、道具、光线和叙事信息。>=90。
2. anatomyScore：脸、手、手指、四肢、身体比例、物体交互是否自然；额外肢体、粘连手指、重复人物属于严重问题。>=92。
3. visualQualityScore：主体清晰、无明显生成瑕疵、无乱码文字/水印/UI、无失焦或破碎材质。>=90。
4. compositionScore：9:16 首帧构图是否稳定、主体不被错误裁切、空间关系和镜头语言可信。>=88。
5. identityScore：只有存在 MASTER_REFERENCE 时才评估。综合全部母板判断同一角色身份，不要求机械复制角度/表情；脸部结构、眼鼻嘴比例、年龄感、发型与锁定辨识特征需一致。>=95。没有 MASTER_REFERENCE 时 identityAssessed=false，identityScore 返回0，不得凭文字臆测身份相似度。
6. continuityScore：只有存在 PREVIOUS_KEYFRAME 时才评估。连续性不是“场景必须一样”；如果 Blueprint 明确切换地点、时间、服装、幻想形态或回归现实，这些变化是允许的。只检查应保持的角色身份、道具、服装状态、左右方向、损伤/湿润程度、关键物件和叙事状态是否合理延续。>=90。没有上一镜时 continuityAssessed=false，continuityScore 返回0。
7. issues 中 critical 只用于会阻断后续视频的严重问题；major 为需要重做但不一定灾难性的错误；warning 为可人工决定的轻微偏差。
8. repairInstruction 必须是“只修失败项、保持正确项不变”的可执行重生成指令。若全部通过可为空字符串。

不要因为风格偏好扣分，不要把合理的景别/视角变化当作身份变化。输出严格 JSON。
`;
    parts.push({ text: promptText });

    let response: any;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              identityAssessed: { type: Type.BOOLEAN },
              continuityAssessed: { type: Type.BOOLEAN },
              identityScore: { type: Type.INTEGER },
              promptComplianceScore: { type: Type.INTEGER },
              anatomyScore: { type: Type.INTEGER },
              visualQualityScore: { type: Type.INTEGER },
              compositionScore: { type: Type.INTEGER },
              continuityScore: { type: Type.INTEGER },
              issues: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    code: { type: Type.STRING },
                    severity: { type: Type.STRING },
                    description: { type: Type.STRING },
                    repairInstruction: { type: Type.STRING },
                  },
                  required: ['code', 'severity', 'description', 'repairInstruction'],
                },
              },
              warnings: { type: Type.ARRAY, items: { type: Type.STRING } },
              summary: { type: Type.STRING },
              repairInstruction: { type: Type.STRING },
            },
            required: [
              'identityAssessed',
              'continuityAssessed',
              'identityScore',
              'promptComplianceScore',
              'anatomyScore',
              'visualQualityScore',
              'compositionScore',
              'continuityScore',
              'issues',
              'warnings',
              'summary',
              'repairInstruction',
            ],
          },
        },
      });
    } catch (error: any) {
      const statusCode = Number(error?.status || error?.statusCode || error?.code);
      throw new KeyframeQaGenerationError(
        'GEMINI_KEYFRAME_QA_REQUEST_FAILED',
        error?.message || 'Gemini 关键帧 QA 请求失败。',
        Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 502,
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(String(response?.text || '').trim());
    } catch {
      throw new KeyframeQaGenerationError(
        'GEMINI_KEYFRAME_QA_JSON_INVALID',
        'Gemini 关键帧 QA 未返回可解析的结构化 JSON。请重试；系统不会自动重复付费调用。',
      );
    }

    const effectiveIdentityAssessed = identityAssessed && parsed?.identityAssessed !== false;
    const effectiveContinuityAssessed = continuityAssessed && parsed?.continuityAssessed !== false;
    const identityScore = effectiveIdentityAssessed ? score(parsed?.identityScore) : null;
    const continuityScore = effectiveContinuityAssessed ? score(parsed?.continuityScore) : null;
    const promptComplianceScore = score(parsed?.promptComplianceScore);
    const anatomyScore = score(parsed?.anatomyScore);
    const visualQualityScore = score(parsed?.visualQualityScore);
    const compositionScore = score(parsed?.compositionScore);
    const issues = Array.isArray(parsed?.issues) ? parsed.issues.map(normalizeIssue) : [];
    const hasCritical = issues.some((issue) => issue.severity === 'critical');

    const pass =
      (!effectiveIdentityAssessed || (identityScore ?? 0) >= 95) &&
      promptComplianceScore >= 90 &&
      anatomyScore >= 92 &&
      visualQualityScore >= 90 &&
      compositionScore >= 88 &&
      (!effectiveContinuityAssessed || (continuityScore ?? 0) >= 90) &&
      !hasCritical;

    return {
      provider: 'vertex-gemini-qa',
      model: this.model,
      analyzedAt: Date.now(),
      pass,
      identityAssessed: effectiveIdentityAssessed,
      continuityAssessed: effectiveContinuityAssessed,
      scores: {
        identityScore,
        promptComplianceScore,
        anatomyScore,
        visualQualityScore,
        compositionScore,
        continuityScore,
      },
      issues,
      warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.map(clean).filter(Boolean) : [],
      summary: clean(parsed?.summary) || (pass ? '关键帧自动 QA 通过。' : '关键帧存在未达标项。'),
      repairInstruction: clean(parsed?.repairInstruction),
    };
  }
}

export function createDefaultGeminiKeyframeQaService(): KeyframeQaGeneratorLike {
  let service: GeminiKeyframeQaService | null = null;
  return {
    async analyze(input: KeyframeQaGenerationInput) {
      if (!service) {
        const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
        const location = process.env.DIRECTOR_KEYFRAME_QA_LOCATION || 'global';
        const model = process.env.DIRECTOR_KEYFRAME_QA_MODEL || process.env.IDENTITY_QA_MODEL || 'gemini-2.5-flash';
        const client = new GoogleGenAI({ vertexai: true, project, location }) as unknown as GeminiQaClientLike;
        service = new GeminiKeyframeQaService(client, model);
      }
      return service.analyze(input);
    },
  };
}
