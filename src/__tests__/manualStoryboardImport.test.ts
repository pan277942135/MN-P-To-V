import { describe, expect, it } from 'vitest';
import {
  ManualStoryboardImportError,
  parseManualStoryboardImport,
} from '../services/director/manualStoryboardImport';

const validPayload = {
  projectTitle: '押金扣光的第七天',
  shots: [
    {
      title: '拒信特写',
      durationSeconds: 4,
      scene: '出租屋室内',
      camera: '手机极近特写',
      action: '手机屏幕出现中文拒信。',
      dialogue: '失业第七天。',
      notes: '真实梅凝，旧卫衣。',
    },
    {
      title: '手搓法杖',
      durationSeconds: 5,
      scene: '出租屋手工作业区',
      camera: '中景 → 手部特写',
      action: '梅凝裁切 EVA 并粘合法杖。',
      dialogue: '',
      notes: '保留手作瑕疵。',
    },
  ],
};

describe('manual storyboard import parser', () => {
  it('parses a ChatGPT JSON payload into multiple editable Shots', () => {
    const result = parseManualStoryboardImport(JSON.stringify(validPayload));

    expect(result.projectTitle).toBe('押金扣光的第七天');
    expect(result.shots).toHaveLength(2);
    expect(result.shots[0].uid).toMatch(/^manual-import-/);
    expect(result.shots[1].title).toBe('手搓法杖');
  });

  it('accepts a fenced JSON block copied from ChatGPT', () => {
    const result = parseManualStoryboardImport(
      `这里是最终分镜：\n\n\`\`\`json\n${JSON.stringify(validPayload)}\n\`\`\``,
    );

    expect(result.shots).toHaveLength(2);
  });

  it('reports the exact Shot and missing required field', () => {
    const broken = structuredClone(validPayload);
    broken.shots[1].camera = '';

    expect(() => parseManualStoryboardImport(JSON.stringify(broken))).toThrowError(
      new ManualStoryboardImportError('第 2 个 Shot 缺少 camera（镜头语言）。'),
    );
  });
});
