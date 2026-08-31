import sharp from 'sharp';

export type ImageOrientation = '16:9' | '9:16';

export interface ImagePreprocessResult {
  buffer: Buffer;
  originalWidth: number;
  originalHeight: number;
  processedWidth: number;
  processedHeight: number;
  orientation: ImageOrientation;
  autoEnhanced: boolean;
}

const MIN_SHORT_SIDE = 512;
const MIN_LONG_SIDE = 768;
const TARGET_SHORT_SIDE = 720;

/**
 * Prepare an uploaded first frame without changing its content semantics.
 * Only an aspect-preserving resize is permitted; no crop, generative upscale,
 * reframing or identity-changing enhancement is performed.
 */
export async function preprocessVeoImage(input: Buffer): Promise<ImagePreprocessResult> {
  const metadata = await sharp(input).metadata();
  const originalWidth = Number(metadata.width || 0);
  const originalHeight = Number(metadata.height || 0);
  if (originalWidth <= 0 || originalHeight <= 0) throw new Error('INVALID_IMAGE_DIMENSIONS');

  const shortSide = Math.min(originalWidth, originalHeight);
  const longSide = Math.max(originalWidth, originalHeight);
  const needsResize = shortSide < MIN_SHORT_SIDE || longSide < MIN_LONG_SIDE;
  const scale = needsResize
    ? Math.max(TARGET_SHORT_SIDE / shortSide, MIN_LONG_SIDE / longSide)
    : 1;
  const processedWidth = Math.round(originalWidth * scale);
  const processedHeight = Math.round(originalHeight * scale);
  const buffer = scale === 1
    ? Buffer.from(input)
    : await sharp(input).resize({ width: processedWidth, height: processedHeight, fit: 'fill' }).toBuffer();

  return {
    buffer,
    originalWidth,
    originalHeight,
    processedWidth,
    processedHeight,
    orientation: originalWidth > originalHeight ? '16:9' : '9:16',
    autoEnhanced: scale !== 1,
  };
}
