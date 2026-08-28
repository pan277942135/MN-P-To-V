import type { KeyframeQaReport } from './keyframeQa';

export interface KeyframeQaClientInput {
  shotLabel: string;
  prompt: string;
  continuity: string;
  candidateImageBase64: string;
  candidateMimeType: string;
  characterHint?: string;
  masterReferences?: Array<{ imageBase64: string; mimeType: string }>;
  previousKeyframe?: { imageBase64: string; mimeType: string } | null;
}

export async function runKeyframeQa(input: KeyframeQaClientInput): Promise<KeyframeQaReport> {
  const response = await fetch('/api/director/keyframes/qa', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Director-Generation-Intent': 'keyframe-qa-v0.3.3',
    },
    body: JSON.stringify(input),
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    // handled below
  }

  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.message || `关键帧自动 QA 请求失败（HTTP ${response.status}）。`);
  }

  return {
    provider: String(payload.provider || ''),
    model: String(payload.model || ''),
    analyzedAt: Number(payload.analyzedAt || Date.now()),
    pass: payload.pass === true,
    identityAssessed: payload.identityAssessed === true,
    continuityAssessed: payload.continuityAssessed === true,
    scores: {
      identityScore: typeof payload?.scores?.identityScore === 'number' ? payload.scores.identityScore : null,
      promptComplianceScore: Number(payload?.scores?.promptComplianceScore || 0),
      anatomyScore: Number(payload?.scores?.anatomyScore || 0),
      visualQualityScore: Number(payload?.scores?.visualQualityScore || 0),
      compositionScore: Number(payload?.scores?.compositionScore || 0),
      continuityScore: typeof payload?.scores?.continuityScore === 'number' ? payload.scores.continuityScore : null,
    },
    issues: Array.isArray(payload.issues) ? payload.issues : [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    summary: String(payload.summary || ''),
    repairInstruction: String(payload.repairInstruction || ''),
  };
}
