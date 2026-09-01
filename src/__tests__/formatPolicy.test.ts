import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORMAT_POLICY,
  LEGACY_FORMAT_POLICY,
  calculateAspectRatio,
  normalizeFormatPolicy,
  resolveFormatPolicy,
  validateAssetMetadata,
} from '../services/formatPolicy/formatPolicy';

describe('Production Format Policy', () => {
  it('uses the new landscape default while preserving the legacy fallback', () => {
    expect(DEFAULT_FORMAT_POLICY).toMatchObject({
      defaultAspectRatio: '16:9',
      allowedAspectRatios: ['16:9', '9:16', '1:1'],
      allowShotOverride: true,
    });
    expect(normalizeFormatPolicy(undefined)).toEqual(LEGACY_FORMAT_POLICY);
    expect(calculateAspectRatio(1672, 941)).toBe('16:9');
  });

  it('returns VALID for a project-matching image', () => {
    expect(validateAssetMetadata({
      width: 1920,
      height: 1080,
      mimeType: 'image/png',
      assetType: 'IMAGE',
      projectPolicy: DEFAULT_FORMAT_POLICY,
    })).toEqual({
      status: 'VALID',
      actualAspectRatio: '16:9',
      expectedAspectRatio: '16:9',
    });
  });

  it('returns WARNING for a convertible ratio mismatch', () => {
    expect(validateAssetMetadata({
      width: 1080,
      height: 1920,
      mimeType: 'image/jpeg',
      assetType: 'IMAGE',
      projectPolicy: DEFAULT_FORMAT_POLICY,
    })).toMatchObject({
      status: 'WARNING',
      actualAspectRatio: '9:16',
      expectedAspectRatio: '16:9',
      reason: 'aspect ratio mismatch',
      suggestion: 'crop or use alternate format',
    });
  });

  it('lets a valid shot override win over the project default', () => {
    const resolved = resolveFormatPolicy({
      projectPolicy: DEFAULT_FORMAT_POLICY,
      shotOverride: { aspectRatio: '9:16' },
    });
    expect(resolved.expectedAspectRatio).toBe('9:16');
    expect(validateAssetMetadata({
      width: 1080,
      height: 1920,
      mimeType: 'image/png',
      assetType: 'IMAGE',
      projectPolicy: DEFAULT_FORMAT_POLICY,
      shotOverride: { aspectRatio: '9:16' },
    }).status).toBe('VALID');
  });

  it('returns INVALID for unreadable or non-media input', () => {
    expect(validateAssetMetadata({
      width: 0,
      height: 0,
      mimeType: 'image/png',
      projectPolicy: DEFAULT_FORMAT_POLICY,
    }).status).toBe('INVALID');
    expect(validateAssetMetadata({
      width: 1920,
      height: 1080,
      mimeType: 'application/pdf',
      projectPolicy: DEFAULT_FORMAT_POLICY,
    })).toMatchObject({ status: 'INVALID', reason: 'non-media file' });
  });
});

