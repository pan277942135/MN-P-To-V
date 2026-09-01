export const FORMAT_POLICY_VERSION = 'production-format-policy-v1' as const;

export type AspectRatio = '16:9' | '9:16' | '1:1';

export const SUPPORTED_ASPECT_RATIOS: readonly AspectRatio[] = ['16:9', '9:16', '1:1'];

export interface ProductionFormatPolicy {
  defaultAspectRatio: AspectRatio;
  allowedAspectRatios: AspectRatio[];
  allowShotOverride: boolean;
}

export interface ShotFormatPolicy {
  aspectRatio: AspectRatio;
}

export type AssetValidationStatus = 'VALID' | 'WARNING' | 'INVALID';

export interface AssetValidation {
  status: AssetValidationStatus;
  actualAspectRatio: string;
  expectedAspectRatio: AspectRatio;
  reason?: string;
  suggestion?: string;
}

export interface AssetValidationInput {
  width: unknown;
  height: unknown;
  mimeType?: unknown;
  assetType?: unknown;
  projectPolicy?: unknown;
  episodePolicy?: unknown;
  shotOverride?: unknown;
}

export interface ResolvedFormatPolicy {
  project: ProductionFormatPolicy;
  episode: ProductionFormatPolicy;
  expectedAspectRatio: AspectRatio;
  shotOverride?: AspectRatio;
}

/** New Director projects use landscape as the production default. */
export const DEFAULT_FORMAT_POLICY: ProductionFormatPolicy = {
  defaultAspectRatio: '16:9',
  allowedAspectRatios: ['16:9', '9:16', '1:1'],
  allowShotOverride: true,
};

/** Projects written before Step 4.0.3-A.1 remain portrait-compatible. */
export const LEGACY_FORMAT_POLICY: ProductionFormatPolicy = {
  defaultAspectRatio: '9:16',
  allowedAspectRatios: ['9:16'],
  allowShotOverride: true,
};

const RATIO_TOLERANCE = 0.04;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === 'string' && SUPPORTED_ASPECT_RATIOS.includes(value as AspectRatio);
}

export function normalizeAspectRatio(value: unknown, fallback: AspectRatio = LEGACY_FORMAT_POLICY.defaultAspectRatio): AspectRatio {
  return isAspectRatio(value) ? value : fallback;
}

function uniqueAspectRatios(value: unknown): AspectRatio[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isAspectRatio))];
}

export function hasFormatPolicy(value: unknown): boolean {
  const raw = objectValue(value);
  return isAspectRatio(raw.defaultAspectRatio)
    || Array.isArray(raw.allowedAspectRatios)
    || typeof raw.allowShotOverride === 'boolean';
}

export function hasShotFormatPolicy(value: unknown): boolean {
  const raw = objectValue(value);
  return isAspectRatio(raw.aspectRatio);
}

export function normalizeFormatPolicy(
  input: unknown,
  fallback: ProductionFormatPolicy = LEGACY_FORMAT_POLICY,
): ProductionFormatPolicy {
  const inherited = normalizeFormatPolicyBase(fallback);
  const raw = objectValue(input);
  const defaultAspectRatio = normalizeAspectRatio(raw.defaultAspectRatio, inherited.defaultAspectRatio);
  const requestedAllowed = uniqueAspectRatios(raw.allowedAspectRatios);
  const allowedAspectRatios = requestedAllowed.length > 0
    ? requestedAllowed
    : (Array.isArray(raw.allowedAspectRatios) ? [defaultAspectRatio] : inherited.allowedAspectRatios);
  const normalizedAllowed = allowedAspectRatios.includes(defaultAspectRatio)
    ? allowedAspectRatios
    : [defaultAspectRatio, ...allowedAspectRatios];

  return {
    defaultAspectRatio,
    allowedAspectRatios: [...new Set(normalizedAllowed)],
    allowShotOverride: typeof raw.allowShotOverride === 'boolean'
      ? raw.allowShotOverride
      : inherited.allowShotOverride,
  };
}

function normalizeFormatPolicyBase(input: ProductionFormatPolicy): ProductionFormatPolicy {
  const defaultAspectRatio = normalizeAspectRatio(input?.defaultAspectRatio, LEGACY_FORMAT_POLICY.defaultAspectRatio);
  const allowed = uniqueAspectRatios(input?.allowedAspectRatios);
  return {
    defaultAspectRatio,
    allowedAspectRatios: allowed.length > 0 ? allowed : [defaultAspectRatio],
    allowShotOverride: input?.allowShotOverride !== false,
  };
}

function readShotOverride(value: unknown): AspectRatio | undefined {
  if (isAspectRatio(value)) return value;
  const raw = objectValue(value);
  return isAspectRatio(raw.aspectRatio) ? raw.aspectRatio : undefined;
}

/**
 * Resolve the expected output ratio without changing any production document.
 * A shot override is accepted only when the inherited policy allows it and the
 * requested ratio is in the episode/project allowed set.
 */
export function resolveFormatPolicy(input: {
  projectPolicy?: unknown;
  episodePolicy?: unknown;
  shotOverride?: unknown;
} = {}): ResolvedFormatPolicy {
  const project = normalizeFormatPolicy(input.projectPolicy, LEGACY_FORMAT_POLICY);
  const episode = normalizeFormatPolicy(input.episodePolicy, project);
  const requestedShotOverride = readShotOverride(input.shotOverride);
  const canOverride = project.allowShotOverride && episode.allowShotOverride;
  const shotOverride = requestedShotOverride
    && canOverride
    && episode.allowedAspectRatios.includes(requestedShotOverride)
    ? requestedShotOverride
    : undefined;

  return {
    project,
    episode,
    expectedAspectRatio: shotOverride || episode.defaultAspectRatio,
    ...(shotOverride ? { shotOverride } : {}),
  };
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.round(left);
  let b = Math.round(right);
  while (b > 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function reducedRatio(width: number, height: number): string {
  const divisor = greatestCommonDivisor(width, height);
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
}

function ratioValue(value: AspectRatio | string): number {
  const [width, height] = value.split(':').map(Number);
  return width > 0 && height > 0 ? width / height : 0;
}

function nearestSupportedRatio(value: number): AspectRatio | null {
  let best: AspectRatio | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of SUPPORTED_ASPECT_RATIOS) {
    const nextDistance = Math.abs(value - ratioValue(candidate));
    if (nextDistance < distance) {
      distance = nextDistance;
      best = candidate;
    }
  }
  return distance <= RATIO_TOLERANCE ? best : null;
}

export function calculateAspectRatio(widthInput: unknown, heightInput: unknown): string {
  const width = numeric(widthInput);
  const height = numeric(heightInput);
  if (!width || !height) return '';
  return nearestSupportedRatio(width / height) || reducedRatio(width, height);
}

export function aspectRatiosMatch(actual: string, expected: AspectRatio): boolean {
  const [width, height] = actual.split(':').map(Number);
  const actualValue = width > 0 && height > 0 ? width / height : 0;
  return actualValue > 0 && Math.abs(actualValue - ratioValue(expected)) <= RATIO_TOLERANCE;
}

function mediaMimeType(value: unknown): boolean {
  return typeof value !== 'string' || /^(image|video|audio)\//i.test(value.trim());
}

function mediaAssetType(value: unknown): boolean {
  return typeof value !== 'string' || ['IMAGE', 'VIDEO', 'AUDIO'].includes(value.trim().toUpperCase());
}

/**
 * Metadata validation is intentionally advisory for ratio mismatches. A valid
 * media file can still enter the registry as WARNING so a later crop/alternate
 * format decision remains possible; malformed/non-media input is INVALID.
 */
export function validateAssetMetadata(input: AssetValidationInput): AssetValidation {
  const resolved = resolveFormatPolicy({
    projectPolicy: input.projectPolicy,
    episodePolicy: input.episodePolicy,
    shotOverride: input.shotOverride,
  });
  const width = numeric(input.width);
  const height = numeric(input.height);
  const actualAspectRatio = calculateAspectRatio(width, height);

  if (!mediaMimeType(input.mimeType) || !mediaAssetType(input.assetType)) {
    return {
      status: 'INVALID',
      actualAspectRatio,
      expectedAspectRatio: resolved.expectedAspectRatio,
      reason: 'non-media file',
      suggestion: 'provide a valid image, video, or audio file',
    };
  }

  if (!width || !height || !actualAspectRatio) {
    return {
      status: 'INVALID',
      actualAspectRatio,
      expectedAspectRatio: resolved.expectedAspectRatio,
      reason: 'unable to read media metadata',
      suggestion: 'provide a valid media file with readable dimensions',
    };
  }

  if (aspectRatiosMatch(actualAspectRatio, resolved.expectedAspectRatio)) {
    return {
      status: 'VALID',
      actualAspectRatio,
      expectedAspectRatio: resolved.expectedAspectRatio,
    };
  }

  return {
    status: 'WARNING',
    actualAspectRatio,
    expectedAspectRatio: resolved.expectedAspectRatio,
    reason: 'aspect ratio mismatch',
    suggestion: 'crop or use alternate format',
  };
}
