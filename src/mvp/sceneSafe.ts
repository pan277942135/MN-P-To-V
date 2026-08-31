import { GoogleGenAI, Type } from '@google/genai';
import type { ExtractedVideoFrame } from '../services/video/videoInspector';

export const SCENE_SAFE_VERSION = 'scene-safe-v0.1' as const;
export type SceneQaGateStatus = 'pass' | 'review' | 'fail';

export interface MvpSceneQaReport {
  version: typeof SCENE_SAFE_VERSION;
  qaModel: string;
  gateStatus: SceneQaGateStatus;
  pass: boolean;
  sceneSimilarityScore: number;
  compositionConsistencyScore: number;
  subjectContinuityScore: number;
  temporalConsistencyScore: number;
  severeSceneBreakDetected: boolean;
  summary: string;
}

export function buildSceneSafePrompt(userPrompt: string): string {
  const base = String(userPrompt || '').trim();
  return `${base}\n\n[SCENE SAFE MODE — REQUIRED]\nUse the uploaded image as the exact first-frame scene and composition anchor. Preserve the same environment, art style, era, camera side, major props, major character count and spatial relationships unless the requested action necessarily changes positions. Do not replace the classroom/environment, redesign major objects, introduce unrelated people, or morph the scene into another location. Preserve each visible character's broad appearance and clothing where discernible, but do not force single-face identity matching when no dominant identity target exists. Motion must remain physically continuous from the uploaded image. If requested motion conflicts with scene continuity, scene continuity takes priority.`;
}

function score(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`SCENE_QA_PARSE_FAILED: invalid ${name}`);
  }
  return value;
}

export function evaluateSceneQa(raw: any, model: string): MvpSceneQaReport {
  const sceneSimilarityScore = score('sceneSimilarityScore', raw?.sceneSimilarityScore);
  const compositionConsistencyScore = score('compositionConsistencyScore', raw?.compositionConsistencyScore);
  const subjectContinuityScore = score('subjectContinuityScore', raw?.subjectContinuityScore);
  const temporalConsistencyScore = score('temporalConsistencyScore', raw?.temporalConsistencyScore);
  const severeSceneBreakDetected = raw?.severeSceneBreakDetected === true;
  const pass = !severeSceneBreakDetected &&
    sceneSimilarityScore >= 72 &&
    compositionConsistencyScore >= 68 &&
    subjectContinuityScore >= 65 &&
    temporalConsistencyScore >= 72;
  const review = !severeSceneBreakDetected && !pass &&
    sceneSimilarityScore >= 60 && temporalConsistencyScore >= 60;
  return {
    version: SCENE_SAFE_VERSION,
    qaModel: model,
    gateStatus: pass ? 'pass' : review ? 'review' : 'fail',
    pass,
    sceneSimilarityScore,
    compositionConsistencyScore,
    subjectContinuityScore,
    temporalConsistencyScore,
    severeSceneBreakDetected,
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
  };
}

export async function qaVideoSceneAgainstInput(params: {
  projectId: string;
  location: string;
  model: string;
  referenceImage: Buffer;
  referenceMimeType: string;
  frames: ExtractedVideoFrame[];
}): Promise<MvpSceneQaReport> {
  if (!params.referenceImage?.length) throw new Error('SCENE_QA_INPUT_INVALID: missing reference image');
  if (!params.frames || params.frames.length < 5) throw new Error('SCENE_QA_INPUT_INVALID: at least 5 real frames required');
  const ai = new GoogleGenAI({ vertexai: true, project: params.projectId, location: params.location });
  const parts: any[] = [
    { inlineData: { mimeType: params.referenceMimeType || 'image/jpeg', data: params.referenceImage.toString('base64') } },
    { text: '[REFERENCE_IMAGE] exact first-frame scene/composition anchor' },
  ];
  params.frames.forEach((frame, index) => {
    parts.push({ inlineData: { mimeType: frame.mimeType || 'image/jpeg', data: frame.buffer.toString('base64') } });
    parts.push({ text: `[VIDEO_FRAME_${index}] real frame at ${frame.timestampSec.toFixed(3)}s` });
  });
  parts.push({
    text: `You are a strict scene-continuity QA system for image-to-video generation. Compare the real video frames against the reference image. This task was explicitly classified as SCENE because single-face identity matching is not semantically applicable. Do not penalize normal action-driven position changes. Evaluate: (1) same environment/location/art style/era and major props, (2) composition/camera continuity, (3) continuity of major visible subjects and broad clothing/appearance without forcing face identity, (4) temporal continuity across frames. Set severeSceneBreakDetected=true for location replacement, abrupt redesign, major unrelated subject injection/removal, or catastrophic composition drift. Scores are strict integers 0..100. Return JSON only.`,
  });
  const response = await ai.models.generateContent({
    model: params.model,
    contents: [{ role: 'user', parts }],
    config: {
      temperature: 0,
      candidateCount: 1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          sceneSimilarityScore: { type: Type.INTEGER },
          compositionConsistencyScore: { type: Type.INTEGER },
          subjectContinuityScore: { type: Type.INTEGER },
          temporalConsistencyScore: { type: Type.INTEGER },
          severeSceneBreakDetected: { type: Type.BOOLEAN },
          summary: { type: Type.STRING },
        },
        required: ['sceneSimilarityScore', 'compositionConsistencyScore', 'subjectContinuityScore', 'temporalConsistencyScore', 'severeSceneBreakDetected', 'summary'],
      },
    },
  });
  return evaluateSceneQa(JSON.parse(response.text?.trim() || '{}'), params.model);
}
