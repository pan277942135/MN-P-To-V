import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import {
  EPISODE_SCHEMA_VERSION,
  SHOT_SCHEMA_VERSION,
  type CharacterSnapshotRef,
  type EpisodeSpec,
  type KeyframeProvider,
  type ShotSpec,
} from '../../domain/episode/episodeTypes';
import { parseEpisodeSpec, parseShotSpec } from '../../domain/episode/episodeSchema';
import { callWithRetry } from '../../utils/retryHelper';
import { redactSecrets } from '../../utils/redactSecrets';

const LEGAL_DURATIONS = [4, 6, 8] as const;

const PlannerShotDraftSchema = z.object({
  title: z.string().trim().min(1).max(240),
  durationSeconds: z.number().int().min(1).max(30),
  sceneLocation: z.string().trim().min(1).max(300),
  sceneTime: z.string().trim().max(120).optional().default(''),
  sceneDescription: z.string().trim().max(2000).optional().default(''),
  action: z.string().trim().min(1).max(4000),
  camera: z.string().trim().min(1).max(1000),
  emotion: z.string().trim().max(500).optional().default(''),
  props: z.array(z.string().trim().min(1).max(240)).max(50).default([]),
  voiceover: z.string().trim().max(4000).optional().default(''),
  keyframeProvider: z.enum(['CHATGPT_UPLOAD', 'GEMINI_GENERATED']).default('CHATGPT_UPLOAD'),
});

const PlannerResponseSchema = z.object({
  shots: z.array(PlannerShotDraftSchema).min(1).max(12),
});

type PlannerShotDraft = z.infer<typeof PlannerShotDraftSchema>;

export interface EpisodePlanRequest {
  episodeId: string;
  title: string;
  storyText: string;
  characterId: string;
  characterVersion: string;
  characterSnapshot: CharacterSnapshotRef;
  durationTargetSeconds: number;
  shotCount?: 5 | 6;
  budgetLimitUsd?: number;
  defaultKeyframeProvider?: Extract<KeyframeProvider, 'CHATGPT_UPLOAD' | 'GEMINI_GENERATED'>;
}

export interface EpisodePlanResult {
  episode: EpisodeSpec;
  shots: ShotSpec[];
  plannerVersion: 'episode-planner-v0.1';
  modelName: string;
}

export function normalizeShotDuration(raw: number): 4 | 6 | 8 {
  if (!Number.isFinite(raw)) return 4;
  let best: 4 | 6 | 8 = 4;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of LEGAL_DURATIONS) {
    const distance = Math.abs(raw - candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function fitShotDurations(rawDurations: number[], targetSeconds: number): Array<4 | 6 | 8> {
  if (rawDurations.length === 0) throw new Error('At least one shot duration is required.');
  const minTotal = rawDurations.length * 4;
  const maxTotal = rawDurations.length * 8;
  if (!Number.isInteger(targetSeconds) || targetSeconds < minTotal || targetSeconds > maxTotal || targetSeconds % 2 !== 0) {
    throw new Error(`durationTargetSeconds must be an even integer between ${minTotal} and ${maxTotal} for ${rawDurations.length} shots.`);
  }

  const durations = rawDurations.map(normalizeShotDuration);
  let total = durations.reduce((sum, value) => sum + value, 0);

  while (total < targetSeconds) {
    const index = durations.findIndex((value) => value < 8);
    if (index < 0) break;
    durations[index] = (durations[index] + 2) as 4 | 6 | 8;
    total += 2;
  }

  while (total > targetSeconds) {
    const index = durations.findIndex((value) => value > 4);
    if (index < 0) break;
    durations[index] = (durations[index] - 2) as 4 | 6 | 8;
    total -= 2;
  }

  if (total !== targetSeconds) {
    throw new Error(`Unable to fit legal shot durations to target ${targetSeconds}s.`);
  }
  return durations;
}

function buildPlannerPrompt(input: EpisodePlanRequest, shotCount: 5 | 6): string {
  const defaultProvider = input.defaultKeyframeProvider || 'CHATGPT_UPLOAD';
  return `
你是造境 AI 虚拟演员系统的分镜导演。请把下面的故事规划成严格 ${shotCount} 个连续镜头，用于后续关键帧生成和 Veo 图生视频。

【Episode】
标题：${input.title}
故事：${input.storyText}
目标总时长：${input.durationTargetSeconds} 秒
角色 ID：${input.characterId}

【硬约束】
1. 必须输出恰好 ${shotCount} 个镜头，不多不少。
2. 每镜只设计一个清晰主动作，动作必须能在 4/6/8 秒内自然完成。
3. durationSeconds 可先按剧情建议填写，系统会最终归一到 4/6/8 秒并使总时长严格等于目标时长。
4. 镜头之间要有明确的叙事推进，避免 6 张互不相关的漂亮画面。
5. camera 使用稳定、可执行的电影镜头语言；除剧情必要，不使用高速环绕、剧烈摇移、复杂长镜头。
6. action 只描述当前镜头发生的动作，不重复角色外貌设定。
7. voiceover 必须短、口语化、可直接用于旁白；不需要旁白时返回空字符串。
8. props 只列当前镜头实际出现且影响连续性的关键道具。
9. keyframeProvider 只能是 CHATGPT_UPLOAD 或 GEMINI_GENERATED。默认优先 ${defaultProvider}；只有需要复杂环境重构、明显幻想/特效首帧时才选择 GEMINI_GENERATED。
10. 不要输出解释、Markdown 或额外字段，只返回结构化 JSON。
`;
}

function buildEpisodeAndShots(
  request: EpisodePlanRequest,
  drafts: PlannerShotDraft[],
  shotCount: 5 | 6,
  now: number
): { episode: EpisodeSpec; shots: ShotSpec[] } {
  if (drafts.length !== shotCount) {
    throw new Error(`PLANNER_SHOT_COUNT_MISMATCH: expected ${shotCount}, received ${drafts.length}`);
  }

  const durations = fitShotDurations(
    drafts.map((draft) => draft.durationSeconds),
    request.durationTargetSeconds
  );
  const shotIds = drafts.map((_, index) => `S${String(index + 1).padStart(2, '0')}`);

  const shots = drafts.map((draft, index) => parseShotSpec({
    episodeId: request.episodeId,
    shotId: shotIds[index],
    order: index,
    title: draft.title,
    durationSeconds: durations[index],
    status: 'KEYFRAME_PENDING',
    scene: {
      location: draft.sceneLocation,
      ...(draft.sceneTime ? { time: draft.sceneTime } : {}),
      ...(draft.sceneDescription ? { description: draft.sceneDescription } : {}),
    },
    action: draft.action,
    camera: draft.camera,
    ...(draft.emotion ? { emotion: draft.emotion } : {}),
    props: draft.props,
    ...(draft.voiceover ? { voiceover: draft.voiceover } : {}),
    keyframe: {
      provider: draft.keyframeProvider || request.defaultKeyframeProvider || 'CHATGPT_UPLOAD',
      status: 'NOT_REQUESTED',
      version: 1,
      generationAttempt: 0,
      qaAttempt: 0,
    },
    video: {
      provider: 'VEO',
      status: 'NOT_REQUESTED',
      providerAttempt: 0,
      qaAttempt: 0,
    },
    schemaVersion: SHOT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
  }));

  const episode = parseEpisodeSpec({
    id: request.episodeId,
    title: request.title,
    synopsis: request.storyText.slice(0, 4000),
    characterId: request.characterId,
    characterVersion: request.characterVersion,
    characterSnapshot: request.characterSnapshot,
    durationTargetSeconds: request.durationTargetSeconds,
    aspectRatio: '9:16',
    status: 'PLANNED',
    ...(request.budgetLimitUsd !== undefined ? {
      budget: {
        limitUsd: request.budgetLimitUsd,
        spentUsd: 0,
        reservedUsd: 0,
        currency: 'USD',
      },
    } : {}),
    shotIds,
    schemaVersion: EPISODE_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
  });

  return { episode, shots };
}

export class EpisodePlanner {
  static readonly VERSION = 'episode-planner-v0.1' as const;

  static async plan(
    ai: GoogleGenAI,
    request: EpisodePlanRequest,
    modelName = 'gemini-2.5-flash'
  ): Promise<EpisodePlanResult> {
    const shotCount = request.shotCount || 6;
    if (!request.storyText?.trim()) throw new Error('storyText is required.');
    if (request.characterSnapshot.characterId !== request.characterId) {
      throw new Error('characterSnapshot.characterId must match characterId.');
    }
    if (request.characterSnapshot.characterVersion !== request.characterVersion) {
      throw new Error('characterSnapshot.characterVersion must match characterVersion.');
    }

    const minTotal = shotCount * 4;
    const maxTotal = shotCount * 8;
    if (
      !Number.isInteger(request.durationTargetSeconds) ||
      request.durationTargetSeconds < minTotal ||
      request.durationTargetSeconds > maxTotal ||
      request.durationTargetSeconds % 2 !== 0
    ) {
      throw new Error(`durationTargetSeconds must be an even integer between ${minTotal} and ${maxTotal} for ${shotCount} shots.`);
    }

    try {
      const response = await callWithRetry(
        () => ai.models.generateContent({
          model: modelName,
          contents: [{
            role: 'user',
            parts: [{ text: buildPlannerPrompt(request, shotCount) }],
          }],
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                shots: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      durationSeconds: { type: Type.INTEGER },
                      sceneLocation: { type: Type.STRING },
                      sceneTime: { type: Type.STRING },
                      sceneDescription: { type: Type.STRING },
                      action: { type: Type.STRING },
                      camera: { type: Type.STRING },
                      emotion: { type: Type.STRING },
                      props: { type: Type.ARRAY, items: { type: Type.STRING } },
                      voiceover: { type: Type.STRING },
                      keyframeProvider: {
                        type: Type.STRING,
                        description: 'CHATGPT_UPLOAD | GEMINI_GENERATED',
                      },
                    },
                    required: [
                      'title',
                      'durationSeconds',
                      'sceneLocation',
                      'sceneTime',
                      'sceneDescription',
                      'action',
                      'camera',
                      'emotion',
                      'props',
                      'voiceover',
                      'keyframeProvider',
                    ],
                  },
                },
              },
              required: ['shots'],
            },
          },
        }),
        { actionName: 'Episode 分镜规划' }
      );

      const parsed = PlannerResponseSchema.parse(JSON.parse(response.text?.trim() || '{}'));
      const built = buildEpisodeAndShots(request, parsed.shots, shotCount, Date.now());
      return {
        ...built,
        plannerVersion: this.VERSION,
        modelName,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Episode 规划失败: ${redactSecrets(message)}`);
    }
  }

  static buildFromDraftsForTest(
    request: EpisodePlanRequest,
    drafts: PlannerShotDraft[],
    now = Date.now()
  ): { episode: EpisodeSpec; shots: ShotSpec[] } {
    return buildEpisodeAndShots(request, drafts, request.shotCount || 6, now);
  }
}
