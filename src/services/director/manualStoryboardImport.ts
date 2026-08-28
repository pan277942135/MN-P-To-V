import type { GeneratedStoryboardShot } from './localStoryboardGenerator';

export interface ManualStoryboardImportPayload {
  projectTitle?: string;
  shots: GeneratedStoryboardShot[];
}

export class ManualStoryboardImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualStoryboardImportError';
  }
}

export const MANUAL_STORYBOARD_CHATGPT_INSTRUCTION = `请按“造境手动分镜导入格式”输出最终分镜：只输出一个 JSON 对象，不要 Markdown，不要解释。根对象必须包含 shots 数组；每个 Shot 必须包含 title、durationSeconds、scene、camera、action、dialogue、notes。镜头数量根据内容动态决定，不固定 S01-S06。`;

export const MANUAL_STORYBOARD_IMPORT_EXAMPLE = `{
  "projectTitle": "项目标题（可选）",
  "shots": [
    {
      "title": "镜头标题",
      "durationSeconds": 4,
      "scene": "场景 / 时间 / 空间",
      "camera": "景别、机位、运镜",
      "action": "画面中发生的动作与视觉信息",
      "dialogue": "对白 / 旁白；没有时填空字符串",
      "notes": "角色、服装、道具、连续性等备注"
    }
  ]
}`;

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function extractBalancedJson(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) return fenced[1].trim();

  const source = text.replace(/^\uFEFF/, '').trim();
  const firstObject = source.search(/[\[{]/);
  if (firstObject < 0) return undefined;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = firstObject; index < source.length; index += 1) {
    const char = source[index];

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

    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.pop() !== expected) return undefined;
      if (stack.length === 0) return source.slice(firstObject, index + 1);
    }
  }

  return undefined;
}

function parseRoot(text: string): unknown {
  const source = text.replace(/^\uFEFF/, '').trim();
  if (!source) {
    throw new ManualStoryboardImportError('请先粘贴 ChatGPT 输出的完整分镜内容。');
  }

  try {
    return JSON.parse(source);
  } catch {
    const extracted = extractBalancedJson(source);
    if (!extracted) {
      throw new ManualStoryboardImportError('无法识别 JSON。请按右侧“要求格式”让 ChatGPT 重新输出。');
    }
    try {
      return JSON.parse(extracted);
    } catch {
      throw new ManualStoryboardImportError('JSON 格式不完整或存在语法错误，请检查括号、引号和逗号。');
    }
  }
}

function requireString(
  item: Record<string, unknown>,
  field: 'title' | 'scene' | 'camera' | 'action',
  index: number,
): string {
  const value = cleanString(item[field]);
  if (!value) {
    const names = {
      title: 'title（镜头标题）',
      scene: 'scene（场景）',
      camera: 'camera（镜头语言）',
      action: 'action（画面 / 动作）',
    } as const;
    throw new ManualStoryboardImportError(`第 ${index + 1} 个 Shot 缺少 ${names[field]}。`);
  }
  return value;
}

export function parseManualStoryboardImport(text: string): ManualStoryboardImportPayload {
  const root = parseRoot(text);
  const rootObject = root && typeof root === 'object' && !Array.isArray(root)
    ? root as Record<string, unknown>
    : undefined;
  const rawShots = Array.isArray(root)
    ? root
    : Array.isArray(rootObject?.shots)
      ? rootObject.shots
      : undefined;

  if (!rawShots) {
    throw new ManualStoryboardImportError('根对象必须包含 shots 数组。');
  }
  if (rawShots.length === 0) {
    throw new ManualStoryboardImportError('shots 不能为空。');
  }
  if (rawShots.length > 50) {
    throw new ManualStoryboardImportError('一次最多导入 50 个 Shot。');
  }

  const stamp = Date.now().toString(36);
  const shots = rawShots.map((rawShot, index): GeneratedStoryboardShot => {
    if (!rawShot || typeof rawShot !== 'object' || Array.isArray(rawShot)) {
      throw new ManualStoryboardImportError(`第 ${index + 1} 个 Shot 必须是 JSON 对象。`);
    }

    const item = rawShot as Record<string, unknown>;
    const rawDuration = Number(item.durationSeconds);
    if (!Number.isFinite(rawDuration) || rawDuration < 1 || rawDuration > 60) {
      throw new ManualStoryboardImportError(
        `第 ${index + 1} 个 Shot 的 durationSeconds 必须是 1–60 之间的数字。`,
      );
    }

    return {
      uid: `manual-import-${stamp}-${index + 1}`,
      title: requireString(item, 'title', index),
      durationSeconds: Math.round(rawDuration),
      scene: requireString(item, 'scene', index),
      camera: requireString(item, 'camera', index),
      action: requireString(item, 'action', index),
      dialogue: cleanString(item.dialogue),
      notes: cleanString(item.notes),
    };
  });

  return {
    projectTitle: cleanString(rootObject?.projectTitle) || undefined,
    shots,
  };
}
