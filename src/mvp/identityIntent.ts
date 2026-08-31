import { GoogleGenAI, Type } from '@google/genai';

export const IDENTITY_INTENT_VERSION = 'identity-intent-v1' as const;
export type ProtectionMode = 'IDENTITY' | 'SCENE';

export interface IdentityIntentReport {
  version: typeof IDENTITY_INTENT_VERSION;
  mode: ProtectionMode;
  confidence: number;
  identityLockRequired: boolean;
  dominantIdentityVisible: boolean;
  estimatedPersonCount: number;
  reason: string;
  failClosed: boolean;
}

export function normalizeIdentityIntentDecision(raw: any): IdentityIntentReport {
  const confidence = Number(raw?.confidence);
  const identityLockRequired = raw?.identityLockRequired === true;
  const dominantIdentityVisible = raw?.dominantIdentityVisible === true;
  const estimatedPersonCount = Number.isFinite(Number(raw?.estimatedPersonCount))
    ? Math.max(0, Math.round(Number(raw.estimatedPersonCount)))
    : 0;
  const requestedMode = raw?.mode === 'SCENE' ? 'SCENE' : 'IDENTITY';
  const highConfidenceScene =
    requestedMode === 'SCENE' &&
    Number.isFinite(confidence) && confidence >= 0.85 &&
    identityLockRequired === false &&
    dominantIdentityVisible === false;

  if (!highConfidenceScene) {
    return {
      version: IDENTITY_INTENT_VERSION,
      mode: 'IDENTITY',
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      identityLockRequired: true,
      dominantIdentityVisible,
      estimatedPersonCount,
      reason: typeof raw?.reason === 'string' && raw.reason.trim()
        ? raw.reason.trim()
        : 'Identity intent was uncertain; fail-closed to strict identity protection.',
      failClosed: requestedMode === 'SCENE',
    };
  }

  return {
    version: IDENTITY_INTENT_VERSION,
    mode: 'SCENE',
    confidence: Math.max(0, Math.min(1, confidence)),
    identityLockRequired: false,
    dominantIdentityVisible: false,
    estimatedPersonCount,
    reason: typeof raw?.reason === 'string' && raw.reason.trim()
      ? raw.reason.trim()
      : 'No single dominant identity target; scene continuity QA is the applicable protection.',
    failClosed: false,
  };
}

export async function classifyIdentityIntent(params: {
  projectId: string;
  location: string;
  model: string;
  imageBuffer: Buffer;
  mimeType: string;
  prompt: string;
}): Promise<IdentityIntentReport> {
  const ai = new GoogleGenAI({ vertexai: true, project: params.projectId, location: params.location });
  const response = await ai.models.generateContent({
    model: params.model,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: params.mimeType || 'image/jpeg', data: params.imageBuffer.toString('base64') } },
        { text: `Classify whether strict single-identity locking is semantically applicable to this image-to-video task.\n\nUser prompt:\n${params.prompt}\n\nReturn IDENTITY when one recognizable person/character is the dominant target whose same identity must be preserved, including portrait, selfie, half/full body, or a small group where a dominant identity is clearly targeted.\nReturn SCENE only when there is clearly no single dominant identity target: classroom/group ensemble, wide crowd scene, environment/object/action detail, hands/props, or a composition where global scene continuity is more appropriate than face matching.\nSCENE is not a safety bypass: it routes to scene-continuity QA.\nWhen uncertain, choose IDENTITY.\nconfidence must be 0..1. identityLockRequired must be true for IDENTITY and false for SCENE. dominantIdentityVisible must be true if a single recognizable identity is visually dominant. estimatedPersonCount is an approximate count of visible people.` },
      ],
    }],
    config: {
      temperature: 0,
      candidateCount: 1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          mode: { type: Type.STRING, enum: ['IDENTITY', 'SCENE'] },
          confidence: { type: Type.NUMBER },
          identityLockRequired: { type: Type.BOOLEAN },
          dominantIdentityVisible: { type: Type.BOOLEAN },
          estimatedPersonCount: { type: Type.INTEGER },
          reason: { type: Type.STRING },
        },
        required: ['mode', 'confidence', 'identityLockRequired', 'dominantIdentityVisible', 'estimatedPersonCount', 'reason'],
      },
    },
  });
  return normalizeIdentityIntentDecision(JSON.parse(response.text?.trim() || '{}'));
}

export function failClosedIdentityIntent(reason: string): IdentityIntentReport {
  return {
    version: IDENTITY_INTENT_VERSION,
    mode: 'IDENTITY',
    confidence: 0,
    identityLockRequired: true,
    dominantIdentityVisible: false,
    estimatedPersonCount: 0,
    reason,
    failClosed: true,
  };
}
