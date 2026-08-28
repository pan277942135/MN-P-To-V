import type { GeneratedStoryboardShot } from './localStoryboardGenerator';

export const CHATGPT_STORYBOARD_SCHEMA = 'zaojing.storyboard.v1' as const;

export type ChatGPTStoryboardSourceType = 'idea' | 'outline' | 'script';
export type ChatGPTStoryboardTargetFormat = 'story_short' | 'vlog' | 'cosplay' | 'other';

export interface ChatGPTStoryboardProject {
  title: string;
  sourceType: ChatGPTStoryboardSourceType;
  targetFormat: ChatGPTStoryboardTargetFormat;
  targetDurationSeconds: number;
  aspectRatio: '9:16';
  creativeBrief: string;
  fullScript: string;
  productionNotes: string;
}

export interface ChatGPTStoryboardImportResult {
  schema: typeof CHATGPT_STORYBOARD_SCHEMA;
  project: ChatGPTStoryboardProject;
  shots: GeneratedStoryboardShot[];
}

export class ChatGPTStoryboardImportError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChatGPTStoryboardImportError';
    this.code = code;
  }
}

export const CHATGPT_STORYBOARD_OUTPUT_INSTRUCTION = `请把我们已经讨论完成的分镜整理成“造境 Storyboard 导入包”。

只输出一个 JSON 对象，不要解释，不要 Markdown；字段必须使用英文 key，内容可以是中文。

固定格式：
{
  "schema": "zaojing.storyboard.v1",
  "project": {
    "title": "项目标题",
    "sourceType": "script",
    "targetFormat": "story_short",
    "targetDurationSeconds": 30,
    "aspectRatio": "9:16",
    "creativeBrief": "故事核心梗概",
    "fullScript": "完整脚本；没有则填空字符串",
    "productionNotes": "统一角色、服装、场景、连续性等生产备注；没有则填空字符串"
  },
  "shots": [
    {
      "title": "镜头标题",
      "durationSeconds": 4,
      "scene": "场景与时间",
      "camera": "景别、机位、运镜",
      "action": "画面中真实发生的动作/视觉内容",
      "dialogue": "对白/旁白；没有则填空字符串",
      "notes": "角色、服装、道具、空间、情绪及与前后镜头的连续性约束"
    }
  ]
}

规则：
1. shots 数量根据剧情动态决定，不固定 6 镜。
2. 每个 Shot 只承载一个清晰的视觉动作或情绪节点。
3. durationSeconds 必须是 1–60 的数字。
4. title、scene、camera、action 必须填写；dialogue 可为空；notes 尽量填写连续性约束。
5. 保持我们已经讨论确认的剧情顺序和细节，不要重新创作另一版故事。
6. 不要输出 S01/S02 字段，造境会按 shots 数组顺序自动编号。
7. 最终回复只包含这一份 JSON。`;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function extractBalancedObjects(input: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(input.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return results;
}

function parseEnvelope(raw: string): unknown {
  const normalized = raw.replace(/^\uFEFF/, '').trim();
  if (!normalized) {
    throw new ChatGPTStoryboardImportError(
      'CHATGPT_IMPORT_EMPTY',
      '没有检测到可导入内容。请先复制 ChatGPT 输出的 Storyboard JSON。',
    );
  }

  try {
    return JSON.parse(normalized);
  } catch {
    // Continue with fenced / prose-wrapped JSON extraction.
  }

  const candidates: string[] = [];
  const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fencedMatch: RegExpExecArray | null;
  while ((fencedMatch = fencedPattern.exec(normalized)) !== null) {
    candidates.push(fencedMatch[1].trim());
  }
  candidates.push(...extractBalancedObjects(normalized));

  const parsedCandidates: unknown[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { schema?: unknown }).schema === CHATGPT_STORYBOARD_SCHEMA
      ) {
        parsedCandidates.push(parsed);
      }
    } catch {
      // Ignore malformed wrappers and keep searching for one valid import envelope.
    }
  }

  if (parsedCandidates.length === 1) return parsedCandidates[0];
  if (parsedCandidates.length > 1) {
    throw new ChatGPTStoryboardImportError(
      'CHATGPT_IMPORT_AMBIGUOUS',
      '检测到多份造境 Storyboard JSON。请只保留一份后重新导入。',
    );
  }

  throw new ChatGPTStoryboardImportError(
    'CHATGPT_IMPORT_JSON_INVALID',
    '没有识别到有效的 zaojing.storyboard.v1 JSON。可先点击“复制给 ChatGPT 的输出要求”重新生成。',
  );
}

function validateProject(raw: unknown, shotDurationTotal: number): ChatGPTStoryboardProject {
  if (!raw || typeof raw !== 'object') {
    throw new ChatGPTStoryboardImportError('CHATGPT_IMPORT_PROJECT_REQUIRED', '导入包缺少 project。');
  }

  const project = raw as Record<string, unknown>;
  const title = text(project.title);
  if (!title) {
    throw new ChatGPTStoryboardImportError('CHATGPT_IMPORT_TITLE_REQUIRED', 'project.title 不能为空。');
  }

  const sourceType = ['idea', 'outline', 'script'].includes(String(project.sourceType))
    ? project.sourceType as ChatGPTStoryboardSourceType
    : 'script';
  const targetFormat = ['story_short', 'vlog', 'cosplay', 'other'].includes(String(project.targetFormat))
    ? project.targetFormat as ChatGPTStoryboardTargetFormat
    : 'story_short';
  const aspectRatio = project.aspectRatio === '9:16' ? '9:16' : '9:16';

  return {
    title,
    sourceType,
    targetFormat,
    targetDurationSeconds: clampNumber(
      project.targetDurationSeconds,
      4,
      600,
      Math.max(4, shotDurationTotal),
    ),
    aspectRatio,
    creativeBrief: text(project.creativeBrief),
    fullScript: text(project.fullScript),
    productionNotes: text(project.productionNotes),
  };
}

function validateShots(raw: unknown): GeneratedStoryboardShot[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ChatGPTStoryboardImportError('CHATGPT_IMPORT_SHOTS_REQUIRED', '导入包没有 shots。');
  }
  if (raw.length > 50) {
    throw new ChatGPTStoryboardImportError('CHATGPT_IMPORT_TOO_MANY_SHOTS', '一次最多导入 50 个 Shot。');
  }

  const stamp = Date.now().toString(36);
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new ChatGPTStoryboardImportError(
        'CHATGPT_IMPORT_SHOT_INVALID',
        `第 ${index + 1} 个 Shot 结构无效。`,
      );
    }

    const shot = item as Record<string, unknown>;
    const title = text(shot.title);
    const scene = text(shot.scene);
    const camera = text(shot.camera);
    const action = text(shot.action);
    if (!title || !scene || !camera || !action) {
      throw new ChatGPTStoryboardImportError(
        'CHATGPT_IMPORT_SHOT_INCOMPLETE',
        `第 ${index + 1} 个 Shot 缺少 title、scene、camera 或 action。`,
      );
    }

    return {
      uid: `chatgpt-${stamp}-${index + 1}`,
      title,
      durationSeconds: clampNumber(shot.durationSeconds, 1, 60, 4),
      scene,
      camera,
      action,
      dialogue: text(shot.dialogue),
      notes: text(shot.notes),
    };
  });
}

export function parseChatGPTStoryboardImport(raw: string): ChatGPTStoryboardImportResult {
  const envelope = parseEnvelope(raw);
  if (!envelope || typeof envelope !== 'object') {
    throw new ChatGPTStoryboardImportError('CHATGPT_IMPORT_INVALID', 'Storyboard 导入包结构无效。');
  }

  const data = envelope as Record<string, unknown>;
  if (data.schema !== CHATGPT_STORYBOARD_SCHEMA) {
    throw new ChatGPTStoryboardImportError(
      'CHATGPT_IMPORT_SCHEMA_UNSUPPORTED',
      `仅支持 schema=${CHATGPT_STORYBOARD_SCHEMA}。`,
    );
  }

  const shots = validateShots(data.shots);
  const total = shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  const project = validateProject(data.project, total);

  return {
    schema: CHATGPT_STORYBOARD_SCHEMA,
    project,
    shots,
  };
}
