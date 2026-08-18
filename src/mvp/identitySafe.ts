import { GoogleGenAI, Type } from '@google/genai';
import sharp from 'sharp';
import type { ExtractedVideoFrame } from '../services/video/videoInspector';

export const IDENTITY_SAFE_VERSION = 'identity-safe-v0.2' as const;
export const IDENTITY_QA_MODEL_DEFAULT = 'gemini-2.5-flash';
export const IDENTITY_QA_MIN_MEAN = 90;
export const IDENTITY_QA_MIN_FRAME = 84;
export const IDENTITY_QA_MIN_TEMPORAL = 88;
export const IDENTITY_QA_MIN_VISIBLE_RATIO = 0.75;

export type IdentityQaGateStatus = 'pass' | 'review' | 'fail';

export interface IdentitySafeInputIssue {
  code: 'IMAGE_TOO_SMALL' | 'IMAGE_ASPECT_EXTREME' | 'PROMPT_IDENTITY_RISK';
  message: string;
}

export interface IdentitySafeInputCheck {
  pass: boolean;
  width: number;
  height: number;
  issues: IdentitySafeInputIssue[];
}

export interface IdentityQaFrameAssessment {
  frameIndex: number;
  timestampSec: number;
  faceSimilarityScore: number;
  faceVisible: boolean;
  differentPersonDetected: boolean;
  notes: string;
}

export interface MvpIdentityQaReport {
  version: typeof IDENTITY_SAFE_VERSION;
  qaModel: string;
  gateStatus: IdentityQaGateStatus;
  pass: boolean;
  identityDriftDetected: boolean;
  differentPersonDetected: boolean;
  meanFaceSimilarityScore: number;
  minimumFaceSimilarityScore: number;
  temporalConsistencyScore: number;
  visibleFrameRatio: number;
  worstFrameTimestamp: number | null;
  frames: IdentityQaFrameAssessment[];
  summary: string;
}

const HIGH_RISK_PROMPT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(turn\s+around|spin\s+around|rapid\s+head\s+turn|whip\s+pan)\b/i, label: '大幅转身/快速转头' },
  { pattern: /\b(cover\s+(?:her\s+|the\s+)?face|face\s+fully\s+occluded|hand\s+over\s+face)\b/i, label: '长时间遮挡脸部' },
  { pattern: /\b(camera\s+orbits?|360\s*degree\s+camera|dramatic\s+camera\s+rotation)\b/i, label: '大幅环绕镜头' },
  { pattern: /(大幅转头|快速转头|快速转身|转身背对|完全背对镜头|遮住脸|完全遮脸|手掌遮脸|镜头环绕人物|360度环绕)/i, label: '高风险身份动作' },
];

export async function validateIdentitySafeInput(params: {
  imageBuffer: Buffer;
  prompt: string;
}): Promise<IdentitySafeInputCheck> {
  const metadata = await sharp(params.imageBuffer).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  const issues: IdentitySafeInputIssue[] = [];
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);

  if (shortSide < 512 || longSide < 768) {
    issues.push({
      code: 'IMAGE_TOO_SMALL',
      message: `Identity Safe Mode 要求输入图至少短边 512px、长边 768px；当前 ${width}x${height}。`,
    });
  }
  if (shortSide > 0 && longSide / shortSide > 2.4) {
    issues.push({
      code: 'IMAGE_ASPECT_EXTREME',
      message: `输入图宽高比过于极端（${width}x${height}），容易造成脸部锚定不稳定。`,
    });
  }

  for (const item of HIGH_RISK_PROMPT_PATTERNS) {
    if (item.pattern.test(params.prompt)) {
      issues.push({
        code: 'PROMPT_IDENTITY_RISK',
        message: `Identity Safe Mode 暂不接受“${item.label}”类动作；请改为轻微、连续、无遮挡动作。`,
      });
      break;
    }
  }

  return { pass: issues.length === 0, width, height, issues };
}

export function buildIdentitySafePrompt(userPrompt: string, conservativeRetry = false): string {
  const base = String(userPrompt || '').trim();
  const identityBlock = `\n\n[IDENTITY SAFE MODE — REQUIRED]\nUse the uploaded image as the exact identity anchor and the exact first-frame appearance reference.\nPreserve the same adult person's facial identity throughout the entire video: same facial geometry, eye shape and spacing, nose, lips, jawline, skin tone, hairstyle, hairline and overall age.\nNever replace, reinterpret, beautify into another person, or substitute the face.\nKeep face visibility high and continuous. No face occlusion, no large head turns, no sudden pose normalization, no frontalization, no identity morphing.\nCamera is locked or near-locked. Motion must be physically continuous and realistic.\nIf any user-requested motion conflicts with identity preservation, identity preservation takes priority.\n`;

  if (!conservativeRetry) {
    return `${base}${identityBlock}\nAllowed motion: subtle breathing, one natural blink, a very small expression change, and minimal natural hair or clothing movement.`;
  }

  return `${base}${identityBlock}\n[CONSERVATIVE IDENTITY RETRY]\nPrevious generation showed identity drift. Reduce motion substantially. Keep the head orientation almost unchanged from the uploaded image. No head turn, no body turn, no hand near the face, no camera movement, no reframing, no expression transition beyond one blink and a faint stable smile. Maintain the exact same face on every frame.`;
}

function assertScore(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`IDENTITY_QA_PARSE_FAILED: invalid ${name}`);
  }
  return value;
}

export async function qaVideoIdentityAgainstInput(params: {
  projectId: string;
  location: string;
  model?: string;
  referenceImage: Buffer;
  referenceMimeType: string;
  frames: ExtractedVideoFrame[];
}): Promise<MvpIdentityQaReport> {
  if (!params.referenceImage?.length) throw new Error('IDENTITY_QA_INPUT_INVALID: missing reference image');
  if (!params.frames || params.frames.length < 5) throw new Error('IDENTITY_QA_INPUT_INVALID: at least 5 real frames required');

  const model = params.model || IDENTITY_QA_MODEL_DEFAULT;
  const ai = new GoogleGenAI({ vertexai: true, project: params.projectId, location: params.location });
  const parts: any[] = [
    {
      inlineData: {
        mimeType: params.referenceMimeType || 'image/jpeg',
        data: params.referenceImage.toString('base64'),
      },
    },
    { text: '[REFERENCE_IMAGE] exact target identity and first-frame appearance anchor' },
  ];

  params.frames.forEach((frame, index) => {
    parts.push({
      inlineData: {
        mimeType: frame.mimeType || 'image/jpeg',
        data: frame.buffer.toString('base64'),
      },
    });
    parts.push({ text: `[VIDEO_FRAME_${index}] real frame at ${frame.timestampSec.toFixed(3)}s` });
  });

  parts.push({
    text: `You are a strict identity-continuity QA system for image-to-video generation.\nCompare every VIDEO_FRAME independently against REFERENCE_IMAGE.\nfaceSimilarityScore must evaluate identity only: facial geometry, eye spacing/shape, nose, lips, jawline, hairline, hairstyle and stable age cues. Ignore harmless lighting, expression and small pose changes.\nSet differentPersonDetected=true whenever the visible face is plausibly a different person, not merely a lower-quality rendering.\nSet faceVisible=false when identity cannot be judged because the face is too small, blurred, turned away or occluded.\nDo not average away a bad frame. Return one assessment for every supplied frameIndex 0..${params.frames.length - 1}.\ntemporalConsistencyScore measures whether identity remains the same continuously across the video.\nReturn strict JSON only.`,
  });

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: {
      temperature: 0,
      candidateCount: 1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          frameAssessments: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                frameIndex: { type: Type.INTEGER },
                faceSimilarityScore: { type: Type.INTEGER },
                faceVisible: { type: Type.BOOLEAN },
                differentPersonDetected: { type: Type.BOOLEAN },
                notes: { type: Type.STRING },
              },
              required: ['frameIndex', 'faceSimilarityScore', 'faceVisible', 'differentPersonDetected', 'notes'],
            },
          },
          temporalConsistencyScore: { type: Type.INTEGER },
          summary: { type: Type.STRING },
        },
        required: ['frameAssessments', 'temporalConsistencyScore', 'summary'],
      },
    },
  });

  const parsed = JSON.parse(response.text?.trim() || '{}');
  if (!Array.isArray(parsed.frameAssessments) || parsed.frameAssessments.length !== params.frames.length) {
    throw new Error('IDENTITY_QA_PARSE_FAILED: frame assessment count mismatch');
  }

  const byIndex = new Map<number, any>();
  for (const item of parsed.frameAssessments) {
    if (!Number.isInteger(item?.frameIndex) || item.frameIndex < 0 || item.frameIndex >= params.frames.length || byIndex.has(item.frameIndex)) {
      throw new Error('IDENTITY_QA_PARSE_FAILED: invalid/duplicate frameIndex');
    }
    byIndex.set(item.frameIndex, item);
  }

  const frames: IdentityQaFrameAssessment[] = params.frames.map((frame, index) => {
    const item = byIndex.get(index);
    if (!item) throw new Error(`IDENTITY_QA_PARSE_FAILED: missing frame ${index}`);
    return {
      frameIndex: index,
      timestampSec: frame.timestampSec,
      faceSimilarityScore: assertScore('faceSimilarityScore', item.faceSimilarityScore),
      faceVisible: item.faceVisible === true,
      differentPersonDetected: item.differentPersonDetected === true,
      notes: typeof item.notes === 'string' ? item.notes : '',
    };
  });

  const visibleFrames = frames.filter((frame) => frame.faceVisible);
  const visibleFrameRatio = Number((visibleFrames.length / frames.length).toFixed(3));
  const scores = visibleFrames.map((frame) => frame.faceSimilarityScore);
  const meanFaceSimilarityScore = scores.length
    ? Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(1))
    : 0;
  const minimumFaceSimilarityScore = scores.length ? Math.min(...scores) : 0;
  const temporalConsistencyScore = assertScore('temporalConsistencyScore', parsed.temporalConsistencyScore);
  const differentPersonDetected = frames.some((frame) => frame.differentPersonDetected);
  const worstFrame = visibleFrames.reduce<IdentityQaFrameAssessment | null>(
    (worst, frame) => !worst || frame.faceSimilarityScore < worst.faceSimilarityScore ? frame : worst,
    null,
  );

  const hardFail =
    differentPersonDetected ||
    visibleFrameRatio < 0.5 ||
    minimumFaceSimilarityScore < 72 ||
    temporalConsistencyScore < 72;
  const fullPass =
    !differentPersonDetected &&
    visibleFrameRatio >= IDENTITY_QA_MIN_VISIBLE_RATIO &&
    meanFaceSimilarityScore >= IDENTITY_QA_MIN_MEAN &&
    minimumFaceSimilarityScore >= IDENTITY_QA_MIN_FRAME &&
    temporalConsistencyScore >= IDENTITY_QA_MIN_TEMPORAL;
  const gateStatus: IdentityQaGateStatus = fullPass ? 'pass' : hardFail ? 'fail' : 'review';
  const identityDriftDetected = !fullPass;

  return {
    version: IDENTITY_SAFE_VERSION,
    qaModel: model,
    gateStatus,
    pass: gateStatus === 'pass',
    identityDriftDetected,
    differentPersonDetected,
    meanFaceSimilarityScore,
    minimumFaceSimilarityScore,
    temporalConsistencyScore,
    visibleFrameRatio,
    worstFrameTimestamp: worstFrame?.timestampSec ?? null,
    frames,
    summary: typeof parsed.summary === 'string' ? parsed.summary : gateStatus === 'pass' ? '身份连续性通过' : '检测到身份漂移风险',
  };
}

export function shouldRetryIdentity(report: MvpIdentityQaReport, providerAttempt: number): boolean {
  return providerAttempt === 1 && report.identityDriftDetected === true && report.pass === false;
}

export interface IdentityBenchmarkSummary {
  evaluatedCases: number;
  firstAttemptPassRate: number;
  postRetryPassRate: number;
  earlyDriftRate: number;
}

export function decideFirstFrameEnhancement(summary: IdentityBenchmarkSummary): {
  recommended: boolean;
  reason: string;
} {
  if (summary.evaluatedCases < 20) {
    return { recommended: false, reason: 'BENCHMARK_INCOMPLETE: 至少需要 20 条真实身份稳定样本再决定。' };
  }
  if (summary.postRetryPassRate < 0.9) {
    return { recommended: true, reason: 'POST_RETRY_PASS_RATE_BELOW_90_PERCENT' };
  }
  if (summary.earlyDriftRate >= 0.2) {
    return { recommended: true, reason: 'EARLY_IDENTITY_DRIFT_AT_OR_ABOVE_20_PERCENT' };
  }
  return { recommended: false, reason: 'CURRENT_INPUT_ANCHOR_IS_SUFFICIENT_FOR_V0_2' };
}
