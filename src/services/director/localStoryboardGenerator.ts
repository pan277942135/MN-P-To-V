export interface StoryboardGenerationInput {
  title: string;
  creativeBrief: string;
  fullScript?: string;
  productionNotes?: string;
  targetDurationSeconds: number;
  targetFormat?: 'story_short' | 'vlog' | 'cosplay' | 'other';
}

export interface GeneratedStoryboardShot {
  uid: string;
  title: string;
  durationSeconds: number;
  scene: string;
  action: string;
  camera: string;
  dialogue: string;
  notes: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function cleanText(value: string) {
  return value
    .replace(/[\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[，,。；;：:\s]+|[，,。；;：:\s]+$/g, '')
    .trim();
}

function splitPrimaryBeats(source: string) {
  const primary = source
    .replace(/\r/g, '')
    .split(/[。！？!?；;\n]+/)
    .map(cleanText)
    .filter((item) => item.length >= 2);

  if (primary.length >= 3) return primary;

  return source
    .split(/[，,]+/)
    .map(cleanText)
    .filter((item) => item.length >= 2);
}

function splitAtKeyword(text: string, keyword: string): [string, string] | null {
  const index = text.indexOf(keyword);
  if (index <= 4 || index >= text.length - keyword.length) return null;
  const before = cleanText(text.slice(0, index));
  const after = cleanText(text.slice(index));
  if (before.length < 4 || after.length < 4) return null;
  return [before, after];
}

function expandDirectorBeat(beat: string) {
  const expanded: string[] = [];

  const fantasySplit = ['幻想', '想象', '仿佛'].map((keyword) => splitAtKeyword(beat, keyword)).find(Boolean);
  if (fantasySplit && /(雨|阳台|天台|屋顶|法杖|变身|变成)/.test(beat)) {
    expanded.push(fantasySplit[0], fantasySplit[1]);
    return expanded;
  }

  if (/(EVA|泡棉|手搓|制作|做法杖|做.*道具)/i.test(beat) && beat.length >= 16) {
    expanded.push(beat);
    expanded.push(`制作过程细节：${beat}`);
    return expanded;
  }

  return [beat];
}

function splitLongestCommaBeat(beats: string[]) {
  let selectedIndex = -1;
  let selectedParts: string[] = [];

  beats.forEach((beat, index) => {
    const parts = beat.split(/[，,]+/).map(cleanText).filter((part) => part.length >= 4);
    if (parts.length >= 2 && beat.length > (selectedIndex >= 0 ? beats[selectedIndex].length : 0)) {
      selectedIndex = index;
      selectedParts = parts;
    }
  });

  if (selectedIndex < 0) return beats;
  const midpoint = Math.ceil(selectedParts.length / 2);
  const left = cleanText(selectedParts.slice(0, midpoint).join('，'));
  const right = cleanText(selectedParts.slice(midpoint).join('，'));
  if (!left || !right) return beats;
  return [...beats.slice(0, selectedIndex), left, right, ...beats.slice(selectedIndex + 1)];
}

function buildBeats(source: string, targetDurationSeconds: number) {
  let beats = splitPrimaryBeats(source).flatMap(expandDirectorBeat).map(cleanText).filter(Boolean);
  const desiredCount = clamp(Math.round(targetDurationSeconds / 4.5), 3, 12);

  while (beats.length < desiredCount) {
    const next = splitLongestCommaBeat(beats);
    if (next.length === beats.length) break;
    beats = next;
  }

  if (beats.length > 12) {
    const head = beats.slice(0, 11);
    head.push(beats.slice(11).join('，'));
    beats = head;
  }

  return beats.length > 0 ? beats : [cleanText(source) || '根据创意建立第一个镜头'];
}

function inferScene(beat: string) {
  if (/阳台/.test(beat) && /雨|夜/.test(beat)) return '雨夜阳台';
  if (/阳台/.test(beat)) return '阳台';
  if (/天台|屋顶/.test(beat) && /雨|夜/.test(beat)) return '雨夜天台 / 屋顶';
  if (/天台|屋顶/.test(beat)) return '天台 / 屋顶';
  if (/EVA|泡棉|手搓|制作|胶枪|裁切|法杖/.test(beat)) return '出租屋手工作业区';
  if (/出租屋|房间|卧室|公寓/.test(beat)) return '出租屋室内';
  if (/公司|办公室|工位/.test(beat)) return '办公室';
  if (/街|路上|户外/.test(beat)) return '户外';
  return '根据脚本当前场景';
}

function inferCamera(beat: string, index: number) {
  if (/手机|屏幕|短信|消息|拒信|邮件/.test(beat)) return '极近特写 → 人物中近景';
  if (/制作过程细节|手|裁|切|胶|EVA|泡棉|颜料/.test(beat)) return '手部细节特写 / 近景蒙太奇';
  if (/幻想|想象|变身|变成|魔法/.test(beat)) return '中广景 / 轻微低机位';
  if (/来到|走到|走向|进入|推开/.test(beat)) return '中景跟随 → 环境中广景';
  if (/最后|消失|回到|变回|现实/.test(beat)) return '中近景固定机位';
  return index % 3 === 0 ? '中近景' : index % 3 === 1 ? '中景' : '细节近景';
}

function inferTitle(beat: string, index: number) {
  if (/拒信|拒绝|很遗憾|求职|工作.*消息/.test(beat)) return '连续的工作拒信';
  if (/制作过程细节/.test(beat)) return '手作细节';
  if (/EVA|泡棉|手搓|制作|做法杖/.test(beat)) return '开始手搓法杖';
  if (/阳台/.test(beat) && /雨|夜/.test(beat) && !/幻想|变身|变成/.test(beat)) return '走进雨夜阳台';
  if (/幻想|想象|变身|变成|魔法/.test(beat)) return '幻想变身';
  if (/最后|消失|回到|变回|现实/.test(beat)) return '回到现实';
  const shortened = cleanText(beat.replace(/制作过程细节：/g, '')).slice(0, 14);
  return shortened || `镜头 ${index + 1}`;
}

function inferAction(beat: string) {
  if (/拒信|拒绝|很遗憾|求职/.test(beat)) {
    return `手机屏幕连续出现中文工作拒信；随后带到人物的真实反应。原始剧情：${beat}`;
  }
  if (/制作过程细节/.test(beat)) {
    return '连续捕捉 EVA 裁切、粘合、零件拼装与手部操作，让粗糙的手工道具逐渐成形。';
  }
  if (/EVA|泡棉|手搓|制作|做法杖/.test(beat)) {
    return `人物在有限空间里摊开 EVA 与手工材料，开始制作道具。原始剧情：${beat}`;
  }
  if (/幻想|想象|变身|变成|魔法/.test(beat)) {
    return `以现实动作作为连续点进入幻想，人物与手中道具的位置保持连贯。原始剧情：${beat}`;
  }
  if (/最后|消失|回到|变回|现实/.test(beat)) {
    return `幻想视觉逐渐退去，镜头明确回到真实人物状态。原始剧情：${beat}`;
  }
  return beat;
}

function inferDialogue(beat: string) {
  const quoted = beat.match(/[“「](.+?)[”」]/)?.[1];
  if (quoted) return quoted;
  if (/拒信|失业|求职/.test(beat)) return '可选字幕：失业第七天。';
  return '';
}

function inferNotes(beat: string) {
  const notes = ['9:16 竖屏；与前后镜头保持人物、服装、道具和动作连续。'];
  if (/拒信|现实|失业/.test(beat)) notes.push('现实段落保持自然、克制，不做夸张表演。');
  if (/EVA|泡棉|手搓|制作|法杖/.test(beat)) notes.push('手工道具保留粗糙真实质感，并延续到后续镜头。');
  if (/幻想|变身|变成|魔法/.test(beat)) notes.push('明确标记为幻想段落；转化前后的主体位置与道具连续。');
  if (/最后|消失|回到|变回|现实/.test(beat)) notes.push('结尾必须清晰回归真实人物造型，与幻想形成反差。');
  return notes.join(' ');
}

function allocateDurations(count: number, targetDurationSeconds: number) {
  if (count <= 0) return [];
  const cappedTarget = clamp(Math.round(targetDurationSeconds || count * 4), count, count * 8);
  const durations = Array.from({ length: count }, () => Math.max(1, Math.floor(cappedTarget / count)));
  let remaining = cappedTarget - durations.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  while (remaining > 0) {
    if (durations[cursor] < 8) {
      durations[cursor] += 1;
      remaining -= 1;
    }
    cursor = (cursor + 1) % count;
  }
  return durations;
}

export function generateLocalStoryboard(input: StoryboardGenerationInput): GeneratedStoryboardShot[] {
  const source = cleanText(input.fullScript || '') || cleanText(input.creativeBrief || '');
  if (!source) throw new Error('STORYBOARD_SOURCE_REQUIRED');

  const beats = buildBeats(source, Math.max(4, Number(input.targetDurationSeconds || 30)));
  const durations = allocateDurations(beats.length, input.targetDurationSeconds);
  const stamp = Date.now().toString(36);

  return beats.map((beat, index) => ({
    uid: `auto-${stamp}-${index + 1}`,
    title: inferTitle(beat, index),
    durationSeconds: durations[index] || 4,
    scene: inferScene(beat),
    action: inferAction(beat),
    camera: inferCamera(beat, index),
    dialogue: inferDialogue(beat),
    notes: inferNotes(beat),
  }));
}
