export const HEAD_ONLY_IMAGE_VERSION = 'head-only-v1';
export const DEFAULT_TARGET_HEAD_BODY_RATIO = 9;

export type HeadOnlyQaIssue = {
  code: string;
  severity: 'critical' | 'major' | 'minor';
  description: string;
  repairInstruction: string;
};

export type HeadOnlyQaReport = {
  identityScore: number;
  sourceIdentityResidualScore: number;
  headOnlyPreservationScore: number;
  bodyPreservationScore: number;
  outfitPreservationScore: number;
  backgroundPreservationScore: number;
  posePreservationScore: number;
  headBodyProportionScore: number;
  anatomyScore: number;
  fullBodyVisible: boolean;
  estimatedHeadBodyRatio: number | null;
  alteredOutsideHead: boolean;
  issues: HeadOnlyQaIssue[];
  summary: string;
};

export type HeadOnlyQaGate = {
  pass: boolean;
  failedChecks: string[];
};

export function evaluateHeadOnlyQaGate(report: HeadOnlyQaReport): HeadOnlyQaGate {
  const failedChecks: string[] = [];
  if (report.identityScore < 95) failedChecks.push('identityScore<95');
  if (report.sourceIdentityResidualScore > 5) failedChecks.push('sourceIdentityResidualScore>5');
  if (report.headOnlyPreservationScore < 97) failedChecks.push('headOnlyPreservationScore<97');
  if (report.bodyPreservationScore < 97) failedChecks.push('bodyPreservationScore<97');
  if (report.outfitPreservationScore < 97) failedChecks.push('outfitPreservationScore<97');
  if (report.backgroundPreservationScore < 95) failedChecks.push('backgroundPreservationScore<95');
  if (report.posePreservationScore < 97) failedChecks.push('posePreservationScore<97');
  if (report.headBodyProportionScore < 92) failedChecks.push('headBodyProportionScore<92');
  if (report.anatomyScore < 90) failedChecks.push('anatomyScore<90');
  if (report.alteredOutsideHead) failedChecks.push('alteredOutsideHead=true');
  if ((report.issues || []).some((issue) => issue.severity === 'critical')) failedChecks.push('criticalIssue');
  return { pass: failedChecks.length === 0, failedChecks };
}

export function buildHeadOnlyEditPrompt(params: {
  characterName: string;
  identityLockPromptEnglish?: string;
  targetHeadBodyRatio?: number;
  repairInstruction?: string;
}): string {
  const targetRatio = params.targetHeadBodyRatio || DEFAULT_TARGET_HEAD_BODY_RATIO;
  const repair = params.repairInstruction?.trim()
    ? `\nREPAIR ONLY THESE FAILED ITEMS: ${params.repairInstruction.trim()}\nStart again from the ORIGINAL SOURCE IMAGE, never from a failed candidate.`
    : '';

  return `
Perform a high-precision photographic HEAD-ONLY character identity replacement on the ORIGINAL SOURCE IMAGE.
Target character: ${params.characterName}.
Identity lock: ${params.identityLockPromptEnglish || 'Use the supplied character master references as the sole identity authority.'}

EDITABLE REGION ONLY:
- skull and face
- ears
- visible hair and hairline
- only the minimum neck-edge blending pixels required for a natural seam

ABSOLUTELY IMMUTABLE REGION:
Everything below the base of the neck must remain visually unchanged from the ORIGINAL SOURCE IMAGE: shoulders, torso, arms, hands, chest silhouette, waist, hips, legs, feet, clothing, shoes, jewelry, accessories, props, furniture, background, architecture, camera position, perspective, lens look, crop, framing, lighting, shadows, color grading, body pose and limb placement.
Do not redesign the body. Do not change body shape, body volume, clothing fit, exposed skin area, pose, hand position, scene geometry, or background details.

IDENTITY REQUIREMENT:
Replace the source person's head identity with the exact supplied target character identity. Remove residual source-person facial identity. Preserve realistic pores, facial anatomy, eye direction compatible with the source pose, and physically plausible hair integration.

PROPORTION REQUIREMENT:
The target aesthetic is a harmonious approximately 1:${targetRatio} head-to-full-body proportion when the full body is visible. Achieve this ONLY by natural head scale and head placement inside the editable head region. Never stretch, shrink, lengthen, reshape, reposition, or regenerate the body to force the ratio. If the body is cropped and an exact full-body ratio cannot be measured, preserve the original crop and perspective and choose a naturally proportioned head scale consistent with an approximately ${targetRatio}-head-tall adult figure.

OUTPUT REQUIREMENT:
Return one photorealistic edited image. Preserve the source image aspect ratio and composition. No text, watermark, border, collage, duplicated person, extra limbs, or scene reconstruction.${repair}`.trim();
}
