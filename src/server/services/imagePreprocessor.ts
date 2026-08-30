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
const TARGET_SHORT_SIDE = 720;

/**
 * Prepare uploaded images for Veo generation.
 * Rules:
 * - Keep source orientation.
 * - Landscape -> 16:9.
 * - Portrait -> 9:16.
 * - Never crop.
 * - Resize by aspect-preserving scale only.
 */
export async function preprocessVeoImage(input: Buffer): Promise<ImagePreprocessResult> {
  const image = sharp(input);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('INVALID_IMAGE_DIMENSIONS');
  }

  const originalWidth = metadata.width;
  const originalHeight = metadata.height;
  const portrait = originalHeight > originalWidth;

  const shortSide = Math.min(originalWidth, originalHeight);
  const scale = shortSide < MIN_SHORT_SIDE ? TARGET_SHORT_SIDE / shortSide : 1;

  const processedWidth = Math.round(originalWidth * scale);
  const processedHeight = Math.round(originalHeight * scale);

  const buffer = await image
    .resize({
      width: processedWidth,
      height: processedHeight,
      fit: 'fill',
    })
    .jpeg({ quality: 95 })
    .toBuffer();

  return {
    buffer,
    originalWidth,
    originalHeight,
    processedWidth,
    processedHeight,
    orientation: portrait ? '9:16' : '16:9',
    autoEnhanced: scale !== 1,
  };
}
