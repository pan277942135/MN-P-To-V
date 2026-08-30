import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { resolveAutoAspectRatio } from '../services/google/vertexClient';

describe('Identity Safe AUTO aspect ratio', () => {
  it('inherits landscape first frame as 16:9', async () => {
    const buffer = await sharp({
      create: { width: 1920, height: 1080, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).jpeg().toBuffer();

    await expect(resolveAutoAspectRatio(buffer.toString('base64'))).resolves.toBe('16:9');
  });

  it('inherits portrait first frame as 9:16', async () => {
    const buffer = await sharp({
      create: { width: 1080, height: 1920, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).jpeg().toBuffer();

    await expect(resolveAutoAspectRatio(buffer.toString('base64'))).resolves.toBe('9:16');
  });

  it('uses portrait-safe 9:16 for square frames', async () => {
    const buffer = await sharp({
      create: { width: 1080, height: 1080, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).jpeg().toBuffer();

    await expect(resolveAutoAspectRatio(buffer.toString('base64'))).resolves.toBe('9:16');
  });
});
