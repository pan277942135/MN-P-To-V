import { describe, expect, it } from 'vitest';
import {
  CHATGPT_STORYBOARD_OUTPUT_INSTRUCTION,
  parseChatGPTStoryboardImport,
} from '../services/director/chatgptStoryboardImport';

const payload = {
  schema: 'zaojing.storyboard.v1',
  project: {
    title: '押金扣光的第七天',
    sourceType: 'script',
    targetFormat: 'story_short',
    targetDurationSeconds: 30,
    aspectRatio: '9:16',
    creativeBrief: '梅凝失业后手搓法杖，在雨夜短暂进入幻想，最后回到现实。',
    fullScript: '',
    productionNotes: '真实世界保持旧卫衣与凌乱高马尾。',
  },
  shots: [
    {
      title: '拒信',
      durationSeconds: 4,
      scene: '出租屋白天',
      camera: '手机极近特写 → 人物中近景',
      action: '手机连续出现工作拒信，梅凝把手机扣在桌上。',
      dialogue: '失业第七天。',
      notes: '真实梅凝。',
    },
    {
      title: '开始手搓',
      durationSeconds: 5,
      scene: '出租屋夜晚',
      camera: '中景 → 手部近景',
      action: '梅凝裁切 EVA 并粘合法杖。',
      dialogue: '',
      notes: '保留粗糙手作质感。',
    },
  ],
};

describe('ChatGPT storyboard import', () => {
  it('imports the canonical zaojing.storyboard.v1 package into dynamic shots', () => {
    const result = parseChatGPTStoryboardImport(JSON.stringify(payload));

    expect(result.schema).toBe('zaojing.storyboard.v1');
    expect(result.project.title).toBe('押金扣光的第七天');
    expect(result.project.targetDurationSeconds).toBe(30);
    expect(result.shots).toHaveLength(2);
    expect(result.shots[0].uid).toMatch(/^chatgpt-/);
    expect(result.shots[1].title).toBe('开始手搓');
  });

  it('accepts JSON wrapped by a ChatGPT markdown code fence', () => {
    const result = parseChatGPTStoryboardImport(
      `下面是最终导入包：\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
    );

    expect(result.shots).toHaveLength(2);
    expect(result.project.productionNotes).toContain('旧卫衣');
  });

  it('rejects incomplete Shot fields instead of guessing', () => {
    const bad = {
      ...payload,
      shots: [{ title: '只有标题', durationSeconds: 4 }],
    };

    expect(() => parseChatGPTStoryboardImport(JSON.stringify(bad))).toThrow(/缺少 title、scene、camera 或 action/);
  });

  it('publishes a copyable output contract for ChatGPT', () => {
    expect(CHATGPT_STORYBOARD_OUTPUT_INSTRUCTION).toContain('zaojing.storyboard.v1');
    expect(CHATGPT_STORYBOARD_OUTPUT_INSTRUCTION).toContain('shots 数量根据剧情动态决定');
    expect(CHATGPT_STORYBOARD_OUTPUT_INSTRUCTION).toContain('不要输出 S01/S02 字段');
  });
});
