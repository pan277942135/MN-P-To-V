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
export type IdentityQaSourceScoreScale = '0-100' | 'legacy-1-5-normalized';

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
  scoreScale?: '0-100';
  sourceScoreScale?: IdentityQaSourceScoreScale;
}

const HIGH_RISK_PROMPT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(?:turn(?:s|ed|ing)?\s+(?:quickly\s+|rapidly\s+|fully\s+)?around|spin(?:s|ning)?\s+around|rapid\s+head\s+turn|quick\s+head\s+turn|whip\s+pan)\b/i, label: '大幅转身/快速转头' },
  { pattern: /\b(?:cover(?:s|ed|ing)?\s+(?:her\s+|his\s+|their\s+|the\s+)?face|face\s+(?:is\s+)?fully\s+occluded|hand\s+(?:passes\s+)?over\s+(?:her\s+|his\s+|the\s+)?face)\b/i, label: '长时间遮挡脸部' },
  { pattern: /\b(?:camera\s+orbits?|360\s*degree\s+camera|dramatic\s+camera\s+rotation)\b/i, label: '大幅环绕镜头' },
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
        message: `检测到“${item.label}”类高风险身份动作；Identity Safe 将自动收敛为轻微、连续、无遮挡动作，不阻断提交。`,
      });
      break;
    }
  }

  const blockingIssues = issues.filter((issue) => issue.code !== 'PROMPT_IDENTITY_RISK');
  return { pass: blockingIssues.length === 0, width, height, issues };
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

function qaSemanticEvidence(parsed: any): string {
  const notes = Array.isArray(parsed?.frameAssessments)
    ? parsed.frameAssessments.map((item: any) => typeof item?.notes === 'string' ? item.notes : '').join(' ')
    : '';
  return `${typeof parsed?.summary === 'string' ? parsed.summary : ''} ${notes}`.toLowerCase();
}

function hasPositiveIdentityEvidence(text: string): boolean {
  return /perfect(?:ly)?(?:\s+maintain(?:ed)?)?|match(?:es|ed|ing)?\s+(?:the\s+)?reference|same\s+(?:person|identity)|identity[^.]{0,40}(?:maintain|consistent)|face[^.]{0,40}consistent|一致|完全匹配|身份[^。]{0,20}(?:保持|稳定)/i.test(text);
}

function hasNegativeIdentityEvidence(text: string): boolean {
  return /different\s+person|identity\s+drift|identity\s+mismatch|face\s+mismatch|inconsistent\s+(?:identity|face)|not\s+(?:the\s+)?same\s+(?:person|identity)|身份漂移|不同的人|身份不一致|人脸不一致|不匹配/i.test(text);
}

/**
 * Gemini has historically emitted Identity Safe scores on an undocumented 1–5 scale even
 * though the downstream gate is 0–100. Normalize only when the entire numeric payload is
 * 1–5 AND the structured/semantic evidence says the identity is consistently the same.
 * Ambiguous or contradictory 1–5-like evidence fails closed as a QA contract error so it
 * can never consume a Veo provider retry.
 */
export function normalizeIdentityQaParsedScores(rawParsed: any): {
  parsed: any;
  sourceScoreScale: IdentityQaSourceScoreScale;
} {
  const parsed = {
    ...rawParsed,
    frameAssessments: Array.isArray(rawParsed?.frameAssessments)
      ? rawParsed.frameAssessments.map((item: any) => ({ ...item }))
      : rawParsed?.frameAssessments,
  };

  const frameScores = Array.isArray(parsed.frameAssessments)
    ? parsed.frameAssessments.map((item: any) => item?.faceSimilarityScore)
    : [];
  const allScores = [...frameScores, parsed?.temporalConsistencyScore];
  const legacyOneToFive =
    allScores.length > 1 &&
    allScores.every((score) => Number.isInteger(score) && score >= 1 && score <= 5);

  if (!legacyOneToFive) {
    return { parsed, sourceScoreScale: '0-100' };
  }

  const text = qaSemanticEvidence(parsed);
  const differentPersonDetected = Array.isArray(parsed.frameAssessments)
    && parsed.frameAssessments.some((item: any) => item?.differentPersonDetected === true);
  const positiveEvidence = hasPositiveIdentityEvidence(text);
  const negativeEvidence = hasNegativeIdentityEvidence(text);

  if (differentPersonDetected || negativeEvidence || !positiveEvidence) {
    throw new Error(
      'IDENTITY_QA_EVIDENCE_CONFLICT: 1-5-like scores conflict with or lack positive identity evidence; preserve artifact and re-QA without Veo regeneration.',
    );
  }

  const normalizeLegacyScore = (score: number) => (score - 1) * 25;
  parsed.frameAssessments = parsed.frameAssessments.map((item: any) => ({
    ...item,
    faceSimilarityScore: normalizeLegacyScore(item.faceSimilarityScore),
  }));
  parsed.temporalConsistencyScore = normalizeLegacyScore(parsed.temporalConsistencyScore);

  return { parsed, sourceScoreScale: 'legacy-1-5-normalized' };
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
    text: `You are a strict identity-continuity QA system for image-to-video generation.\nCompare every VIDEO_FRAME independently against REFERENCE_IMAGE.\nAll numeric identity scores MUST be integers on a 0–100 scale, where 100 means an exact/fully consistent identity match and 0 means no identity match. NEVER use a 1–5 or 1–10 rating scale.\nfaceSimilarityScore must evaluate identity only: facial geometry, eye spacing/shape, nose, lips, jawline, hairline, hairstyle and stable age cues. Ignore harmless lighting, expression and small pose changes.\nSet differentPersonDetected=true whenever the visible face is plausibly a different person, not merely a lower-quality rendering.\nSet faceVisible=false when identity cannot be judged because the face is too small, blurred, turned away or occluded.\nDo not average away a bad frame. Return one assessment for every supplied frameIndex 0..${params.frames.length - 1}.\ntemporalConsistencyScore uses the same 0–100 scale and measures whether identity remains the same continuously across the video.\nReturn strict JSON only.`,
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
                faceSimilarityScore: { type: Type.INTEGER, description: 'Identity similarity on a strict 0-100 scale; 100 is exact match.' },
                faceVisible: { type: Type.BOOLEAN },
                differentPersonDetected: { type: Type.BOOLEAN },
                notes: { type: Type.STRING },
              },
              required: ['frameIndex', 'faceSimilarityScore', 'faceVisible', 'differentPersonDetected', 'notes'],
            },
          },
          temporalConsistencyScore: { type: Type.INTEGER, description: 'Temporal identity consistency on a strict 0-100 scale; 100 is fully consistent.' },
          summary: { type: Type.STRING },
        },
        required: ['frameAssessments', 'temporalConsistencyScore', 'summary'],
      },
    },
  });

  const normalized = normalizeIdentityQaParsedScores(JSON.parse(response.text?.trim() || '{}'));
  const parsed = normalized.parsed;
  const sourceScoreScale = normalized.sourceScoreScale;
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
    scoreScale: '0-100',
    sourceScoreScale,
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
