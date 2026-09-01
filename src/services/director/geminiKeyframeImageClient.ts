import type { AspectRatio, AssetValidation } from '../formatPolicy/formatPolicy';

export interface GenerateKeyframeImageRequest {
  prompt: string;
  negativePrompt?: string;
  characterHint?: string;
  referenceImageBase64?: string;
  referenceMimeType?: string;
  aspectRatio?: AspectRatio;
}

export interface GenerateKeyframeImageResponse {
  provider: 'vertex-gemini-image';
  model: string;
  generatedAt: number;
  mimeType: string;
  imageBase64: string;
  validation?: AssetValidation;
}

export async function generateKeyframeImage(
  input: GenerateKeyframeImageRequest,
): Promise<GenerateKeyframeImageResponse> {
  const response = await fetch('/api/director/keyframes/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Director-Generation-Intent': 'keyframe-image-v0.3.2',
    },
    body: JSON.stringify(input),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.message || payload?.error || `关键帧图片生成失败 (HTTP ${response.status})`);
  }

  return {
    provider: payload.provider,
    model: String(payload.model || ''),
    generatedAt: Number(payload.generatedAt || Date.now()),
    mimeType: String(payload.mimeType || 'image/png'),
    imageBase64: String(payload.imageBase64 || ''),
    ...(payload.validation ? { validation: payload.validation as AssetValidation } : {}),
  };
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType || 'image/png' });
}
