import { describe, expect, it, vi } from 'vitest';
import {
  createGeminiStoryboardService,
  StoryboardGenerationError,
  type GeminiClientLike,
} from '../server/services/geminiStoryboardService';

const validPayload = {
  shots: [
    {
      title: '拒信特写',
      durationSeconds: 4,
      scene: '出租屋室内',
      action: '手机屏幕连续出现工作拒信，镜头带到梅凝疲惫的反应。',
      camera: '手机极近特写 → 人物中近景',
      dialogue: '失业第七天。',
      notes: '真实梅凝，旧卫衣，保持克制。',
    },
    {
      title: '开始手搓法杖',
      durationSeconds: 5,
      scene: '出租屋手工作业区',
      action: '梅凝摊开 EVA 材料开始裁切和粘合法杖。',
      camera: '中景 → 手部近景',
      dialogue: '',
      notes: '保留粗糙手作质感。',
    },
    {
      title: '回到现实',
      durationSeconds: 4,
      scene: '雨夜阳台',
      action: '幻想消失，梅凝重新变回穿旧卫衣的真实状态。',
      camera: '中近景固定机位',
      dialogue: '',
      notes: '明确从幻想回到现实。',
    },
  ],
};

function createServiceWithText(text: string) {
  const generateContent = vi.fn().mockResolvedValue({ text });
  const client: GeminiClientLike = { models: { generateContent } };
  return {
    generateContent,
    service: createGeminiStoryboardService({
      client,
      project: 'test-project',
      location: 'us-central1',
      model: 'gemini-2.5-flash',
    }),
  };
}

const input = {
  title: '押金扣光的第七天',
  creativeBrief: '梅凝连续收到拒信，手搓法杖，在雨夜幻想变身，最后回到现实。',
  targetDurationSeconds: 30,
  targetFormat: 'story_short' as const,
};

describe('Gemini storyboard service', () => {
  it('calls Vertex Gemini with JSON schema and normalizes a dynamic Shot List', async () => {
    const { service, generateContent } = createServiceWithText(JSON.stringify(validPayload));

    const result = await service.generate(input);

    expect(result.provider).toBe('vertex-gemini');
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.shots).toHaveLength(3);
    expect(result.shots[0].uid).toMatch(/^gemini-/);
    expect(result.shots[2].title).toBe('回到现实');

    expect(generateContent).toHaveBeenCalledTimes(1);
    const request = generateContent.mock.calls[0][0];
    expect(request.model).toBe('gemini-2.5-flash');
    expect(request.config.responseMimeType).toBe('application/json');
    expect(request.config.responseJsonSchema).toBeTruthy();
    expect(request.config.temperature).toBe(0.35);
    expect(String(request.contents)).toContain('不要固定镜头数量');
    expect(String(request.contents)).toContain('响应第一个字符必须是 {');
  });

  it('accepts a valid storyboard JSON object wrapped in a markdown code fence', async () => {
    const { service } = createServiceWithText(`\n\`\`\`json\n${JSON.stringify(validPayload, null, 2)}\n\`\`\`\n`);

    const result = await service.generate(input);

    expect(result.shots).toHaveLength(3);
    expect(result.shots[0].title).toBe('拒信特写');
  });

  it('accepts one unambiguous storyboard JSON object surrounded by prose and BOM', async () => {
    const { service } = createServiceWithText(`\uFEFF以下是结构化分镜：\n${JSON.stringify(validPayload)}\n以上。`);

    const result = await service.generate(input);

    expect(result.shots[2].title).toBe('回到现实');
  });

  it('rejects ambiguous multiple storyboard JSON objects instead of guessing', async () => {
    const { service } = createServiceWithText(`${JSON.stringify(validPayload)}\n${JSON.stringify(validPayload)}`);

    await expect(service.generate(input)).rejects.toMatchObject({
      code: 'GEMINI_STORYBOARD_JSON_AMBIGUOUS',
    });
  });

  it('still fails closed for malformed non-JSON output', async () => {
    const { service } = createServiceWithText('这是一个自然语言分镜结果，没有任何 JSON 结构。');

    await expect(service.generate(input)).rejects.toMatchObject({
      code: 'GEMINI_STORYBOARD_JSON_INVALID',
    });
  });

  it('fails before provider execution when the script source is empty', async () => {
    const generateContent = vi.fn();
    const service = createGeminiStoryboardService({
      client: { models: { generateContent } },
      project: 'test-project',
    });

    await expect(service.generate({
      title: '空脚本',
      creativeBrief: '',
      fullScript: '',
      targetDurationSeconds: 30,
    })).rejects.toMatchObject({
      code: 'STORYBOARD_SOURCE_REQUIRED',
      statusCode: 400,
    });

    expect(generateContent).not.toHaveBeenCalled();
  });

  it('fails closed when Gemini returns incomplete storyboard fields', async () => {
    const service = createGeminiStoryboardService({
      client: {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            text: JSON.stringify({
              shots: [{ title: '只有标题', durationSeconds: 4 }],
            }),
          }),
        },
      },
      project: 'test-project',
    });

    await expect(service.generate({
      title: '坏数据',
      creativeBrief: '一个可拆镜的故事。',
      targetDurationSeconds: 12,
    })).rejects.toBeInstanceOf(StoryboardGenerationError);
  });
});
