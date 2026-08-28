import { GoogleGenAI } from '@google/genai';

export interface StoryboardGenerationInput {
  title: string;
  creativeBrief: string;
  fullScript?: string;
  productionNotes?: string;
  targetDurationSeconds: number;
  targetFormat?: 'story_short' | 'vlog' | 'cosplay' | 'other';
}

export interface GeminiStoryboardShot {
  uid: string;
  title: string;
  durationSeconds: number;
  scene: string;
  action: string;
  camera: string;
  dialogue: string;
  notes: string;
}

export interface GeminiStoryboardResult {
  provider: 'vertex-gemini';
  model: string;
  generatedAt: number;
  shots: GeminiStoryboardShot[];
}

export interface StoryboardGeneratorLike {
  generate(input: StoryboardGenerationInput): Promise<GeminiStoryboardResult>;
}

export interface GeminiClientLike {
  models: {
    generateContent(args: Record<string, unknown>): Promise<{ text?: string }>;
  };
}

export class StoryboardGenerationError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 502) {
    super(message);
    this.name = 'StoryboardGenerationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const STORYBOARD_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['shots'],
  properties: {
    shots: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title',
          'durationSeconds',
          'scene',
          'action',
          'camera',
          'dialogue',
          'notes',
        ],
        properties: {
          title: { type: 'string' },
          durationSeconds: { type: 'number', minimum: 1, maximum: 30 },
          scene: { type: 'string' },
          action: { type: 'string' },
          camera: { type: 'string' },
          dialogue: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  },
} as const;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function validateInput(input: StoryboardGenerationInput) {
  const title = clean(input.title);
  const creativeBrief = clean(input.creativeBrief);
  const fullScript = clean(input.fullScript);
  const productionNotes = clean(input.productionNotes);
  const targetDurationSeconds = Math.max(
    4,
    Math.min(600, Math.round(Number(input.targetDurationSeconds || 30))),
  );

  if (!title) {
    throw new StoryboardGenerationError(
      'STORYBOARD_TITLE_REQUIRED',
      '项目标题不能为空。',
      400,
    );
  }
  if (!creativeBrief && !fullScript) {
    throw new StoryboardGenerationError(
      'STORYBOARD_SOURCE_REQUIRED',
      '创意描述或完整脚本至少填写一项。',
      400,
    );
  }

  const sourceLength = creativeBrief.length + fullScript.length + productionNotes.length;
  if (sourceLength > 20_000) {
    throw new StoryboardGenerationError(
      'STORYBOARD_SOURCE_TOO_LARGE',
      '当前脚本内容过长，请控制在 20,000 字符以内。',
      413,
    );
  }

  return {
    title,
    creativeBrief,
    fullScript,
    productionNotes,
    targetDurationSeconds,
    targetFormat: input.targetFormat || 'story_short',
  };
}

function buildPrompt(input: ReturnType<typeof validateInput>) {
  const formatName = {
    story_short: '剧情短视频',
    vlog: 'Vlog',
    cosplay: 'AI Cosplay',
    other: '其他',
  }[input.targetFormat];

  return [
    '你是“造境 Director”，负责把用户已经确定的创意或脚本拆成可直接进入关键帧制作的 Storyboard / Shot List。',
    '',
    '目标：输出结构化分镜初稿，供真人导演继续修改和确认。不要固定镜头数量，必须根据剧情节奏和目标时长动态决定。',
    '',
    '拆镜规则：',
    '1. 严格保持原故事先后顺序，不擅自改写核心剧情。',
    '2. 每个 Shot 只承载一个清晰的视觉动作或情绪节点；必要时把一个长句拆成多个镜头。',
    '3. 镜头数量由内容决定，不得机械固定为 6 镜或其他固定数量。',
    '4. 每个 Shot 给出：标题、建议时长、场景、镜头语言、画面/动作、对白/旁白、连续性/导演备注。',
    '5. 时长通常 2–8 秒；全片建议总时长尽量贴近目标总时长。',
    '6. 现实、回忆、幻想、变身等状态切换必须明确。若同一句同时包含“幻想消失/变回/回到现实”，结尾应识别为“回到现实”，不要再次标成幻想变身。',
    '7. 角色、服装、道具、空间方向与动作承接要写进 notes，供后续关键帧保持连续性。',
    '8. 不要输出图片提示词，不要输出视频提示词，不要开始 Step 3。',
    '9. dialogue 没有对白时返回空字符串。',
    '10. 只返回符合 JSON Schema 的数据，不要 Markdown，不要解释。',
    '',
    `项目标题：${input.title}`,
    `目标内容形式：${formatName}`,
    `目标总时长：${input.targetDurationSeconds} 秒`,
    `创意 / 故事梗概：${input.creativeBrief || '（未提供）'}`,
    `完整脚本：${input.fullScript || '（未提供；按故事梗概拆镜）'}`,
    `生产备注：${input.productionNotes || '（无）'}`,
  ].join('\n');
}

function normalizeShots(payload: unknown): GeminiStoryboardShot[] {
  const rawShots = (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { shots?: unknown }).shots)
  )
    ? (payload as { shots: unknown[] }).shots
    : [];

  if (rawShots.length === 0 || rawShots.length > 20) {
    throw new StoryboardGenerationError(
      'GEMINI_STORYBOARD_INVALID',
      'Gemini 返回的 Shot List 为空或镜头数量异常。',
    );
  }

  const stamp = Date.now().toString(36);
  return rawShots.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new StoryboardGenerationError(
        'GEMINI_STORYBOARD_INVALID',
        `Gemini 返回的 S${String(index + 1).padStart(2, '0')} 结构无效。`,
      );
    }

    const item = raw as Record<string, unknown>;
    const title = clean(item.title);
    const scene = clean(item.scene);
    const action = clean(item.action);
    const camera = clean(item.camera);
    const dialogue = clean(item.dialogue);
    const notes = clean(item.notes);
    const durationSeconds = Math.max(
      1,
      Math.min(30, Math.round(Number(item.durationSeconds || 0))),
    );

    if (!title || !scene || !action || !camera || !notes || !durationSeconds) {
      throw new StoryboardGenerationError(
        'GEMINI_STORYBOARD_INVALID',
        `Gemini 返回的 S${String(index + 1).padStart(2, '0')} 缺少必要分镜字段。`,
      );
    }

    return {
      uid: `gemini-${stamp}-${index + 1}`,
      title,
      durationSeconds,
      scene,
      action,
      camera,
      dialogue,
      notes,
    };
  });
}

export interface GeminiStoryboardServiceOptions {
  client?: GeminiClientLike;
  project?: string;
  location?: string;
  model?: string;
}

export function createGeminiStoryboardService(
  options: GeminiStoryboardServiceOptions = {},
): StoryboardGeneratorLike {
  const project = options.project || process.env.GOOGLE_CLOUD_PROJECT || '';
  const location =
    options.location ||
    process.env.DIRECTOR_STORYBOARD_LOCATION ||
    process.env.VERTEX_LOCATION ||
    'us-central1';
  const model =
    options.model ||
    process.env.DIRECTOR_STORYBOARD_MODEL ||
    'gemini-2.5-flash';

  let client = options.client;

  const getClient = (): GeminiClientLike => {
    if (client) return client;
    if (!project) {
      throw new StoryboardGenerationError(
        'GEMINI_PROJECT_NOT_CONFIGURED',
        'GOOGLE_CLOUD_PROJECT 未配置，无法调用 Vertex AI Gemini。',
        503,
      );
    }
    client = new GoogleGenAI({
      vertexai: true,
      project,
      location,
    }) as unknown as GeminiClientLike;
    return client;
  };

  return {
    async generate(rawInput: StoryboardGenerationInput): Promise<GeminiStoryboardResult> {
      const input = validateInput(rawInput);
      const prompt = buildPrompt(input);

      try {
        const response = await getClient().models.generateContent({
          model,
          contents: prompt,
          config: {
            temperature: 0.45,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            responseJsonSchema: STORYBOARD_JSON_SCHEMA,
          },
        });

        const text = clean(response.text);
        if (!text) {
          throw new StoryboardGenerationError(
            'GEMINI_STORYBOARD_EMPTY',
            'Gemini 未返回可解析的分镜结果。',
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new StoryboardGenerationError(
            'GEMINI_STORYBOARD_JSON_INVALID',
            'Gemini 返回了非 JSON 分镜结果。',
          );
        }

        return {
          provider: 'vertex-gemini',
          model,
          generatedAt: Date.now(),
          shots: normalizeShots(parsed),
        };
      } catch (error) {
        if (error instanceof StoryboardGenerationError) throw error;
        throw new StoryboardGenerationError(
          'GEMINI_STORYBOARD_REQUEST_FAILED',
          error instanceof Error
            ? `Gemini 分镜生成失败：${error.message}`
            : 'Gemini 分镜生成失败。',
        );
      }
    },
  };
}

export function createDefaultGeminiStoryboardService() {
  return createGeminiStoryboardService();
}
