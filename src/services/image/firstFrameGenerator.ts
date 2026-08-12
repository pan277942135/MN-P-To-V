import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';
import type { IdentitySpec, FirstFrameCandidate, CharacterReference } from '../../types';
import { redactSecrets } from '../../utils/redactSecrets';
import { callWithRetry } from '../../utils/retryHelper';

export class FirstFrameGenerator {
  static async verifyGeneratedImage(
    buffer: Buffer,
    inputSceneBuffer: Buffer
  ): Promise<{
    valid: boolean;
    reason?: string;
    width: number;
    height: number;
    mimeType: string;
  }> {
    if (!buffer || buffer.length < 10 * 1024) {
      return { valid: false, reason: '生成图片数据为空或过于微小', width: 0, height: 0, mimeType: '' };
    }

    try {
      const image = sharp(buffer);
      const metadata = await image.metadata();

      const width = metadata.width || 0;
      const height = metadata.height || 0;
      const format = metadata.format || 'jpeg';

      if (width === 0 || height === 0) {
        return { valid: false, reason: '图片尺寸无效', width: 0, height: 0, mimeType: '' };
      }

      // Check for pure black/white/monochrome image
      const stats = await image.stats();
      const isMonochromeOrSolid = stats.channels.every((ch) => ch.stdev < 2.0);
      if (isMonochromeOrSolid) {
        return { valid: false, reason: '检测到全黑、全白或纯色黑屏无效图', width, height, mimeType: `image/${format}` };
      }

      return {
        valid: true,
        width,
        height,
        mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, reason: `图片格式坏损: ${redactSecrets(msg)}`, width: 0, height: 0, mimeType: '' };
    }
  }

  static async generateFirstFrameCandidates(
    ai: GoogleGenAI,
    imageModelName: string,
    sceneImageBuffer: Buffer,
    sceneMimeType: string,
    identitySpec: IdentitySpec,
    referenceImages: CharacterReference[],
    actionPoseDescription: string,
    repairInstruction?: string,
    masterBuffers?: Buffer[],
    masterMimeTypes?: string[],
    sceneMode?: string
  ): Promise<FirstFrameCandidate[]> {
    // If scene already contains the character, directly use the raw scene image without re-drawing/reconstructing
    if (sceneMode === 'animate_existing_character') {
      const candidateId = `ff_scene_${crypto.randomUUID().slice(0, 8)}`;
      const blob = new Blob([new Uint8Array(sceneImageBuffer)], { type: sceneMimeType || 'image/jpeg' });
      return [
        {
          id: candidateId,
          blob,
          width: 1080,
          height: 1920,
          mimeType: sceneMimeType || 'image/jpeg',
          createdAt: Date.now(),
        },
      ];
    }

    const candidates: FirstFrameCandidate[] = [];

    // Prepare character reference parts
    const parts: any[] = [];

    // 1. Target Scene Image as composition and pose base
    parts.push({
      inlineData: {
        mimeType: sceneMimeType,
        data: sceneImageBuffer.toString('base64'),
      },
    });
    parts.push({
      text: '[SCENE_BASE_IMAGE]: Use this image ONLY as the composition, pose, clothing, background, and lighting template. Replace the primary face with the character identity below.',
    });

    // 2. Character Reference Images (Master Plates)
    if (masterBuffers && masterBuffers.length > 0) {
      masterBuffers.forEach((buf, idx) => {
        parts.push({
          inlineData: {
            mimeType: masterMimeTypes?.[idx] || 'image/jpeg',
            data: buf.toString('base64'),
          },
        });
        parts.push({
          text: `[CHARACTER_IDENTITY_REFERENCE_${idx + 1}]: High quality master photo of the target character (Angle: ${referenceImages[idx]?.angle || 'master'}). Lock face, features, eye color, skin tone, hair style.`,
        });
      });
    } else {
      referenceImages.forEach((ref, idx) => {
        parts.push({
          text: `[CHARACTER_IDENTITY_REFERENCE_${idx + 1}]: High quality master photo of the target character. Lock face, features, eye color, skin tone, hair style.`,
        });
      });
    }

    // 3. Prompt Text
    const charLock = identitySpec.identityLockPromptEnglish || 'target character with locked face and features';
    let promptText = `
High-precision 9:16 portrait keyframe reconstruction.
Reconstruct the first frame (0.0s keyframe) for image-to-video generation.

CRITICAL INSTRUCTIONS:
1. Target Identity Lock: ${charLock}.
2. Keep the scene composition, background, body pose, outfit, and lighting identical to [SCENE_BASE_IMAGE].
3. Replace face, facial details, hairline, and hair with the exact identity from [CHARACTER_IDENTITY_REFERENCE] master photos.
4. Anatomy: Perfectly rendered natural face, eyes, hands, skin texture with fine detail. No extra fingers, no morphing.
5. Aspect Ratio: 9:16 portrait. High resolution 2K rendering.
`;

    if (repairInstruction) {
      promptText += `\n[DIRECTIONAL REPAIR INSTRUCTION]: ${repairInstruction}. Fix only the failed quality aspects while keeping everything else perfectly consistent.`;
    }

    parts.push({ text: promptText });

    // We will attempt candidate generation
    try {
      const extractCandidatesFromResponse = async (response: any): Promise<FirstFrameCandidate[]> => {
        const result: FirstFrameCandidate[] = [];
        const responseCandidates = response.candidates || [];
        for (const candidate of responseCandidates) {
          const partsList = candidate.content?.parts || [];
          for (const part of partsList) {
            const inline = part.inlineData || (part as any).inline_data;
            const b64Data = inline?.data || inline?.bytesBase64Encoded;
            if (b64Data) {
              const imgBuffer = Buffer.from(b64Data, 'base64');
              const verification = await this.verifyGeneratedImage(imgBuffer, sceneImageBuffer);

              if (verification.valid) {
                const candidateId = `ff_${crypto.randomUUID().slice(0, 8)}`;
                const blob = new Blob([new Uint8Array(imgBuffer)], { type: verification.mimeType });

                result.push({
                  id: candidateId,
                  blob,
                  width: verification.width,
                  height: verification.height,
                  mimeType: verification.mimeType,
                  createdAt: Date.now(),
                });
              } else {
                console.warn(`[FirstFrameGenerator] Candidate image verification issue: ${verification.reason}`);
              }
            } else if (part.text) {
              console.warn(`[FirstFrameGenerator] Received text part from image model: ${part.text.slice(0, 150)}`);
            }
          }
        }
        return result;
      };

      // Primary Attempt
      const primaryModel = imageModelName || 'gemini-3.1-flash-image';
      const isLite = typeof primaryModel === 'string' && primaryModel.includes('lite');
      const imageConfig: any = { aspectRatio: '9:16' };
      if (!isLite) {
        imageConfig.imageSize = '1K';
      }

      let lastError: Error | null = null;

      try {
        const response = await callWithRetry(
          () =>
            ai.models.generateContent({
              model: primaryModel,
              contents: [{ role: 'user', parts }],
              config: { imageConfig },
            }),
          { actionName: `首帧图像重构生成 (${primaryModel})` }
        );

        const extracted = await extractCandidatesFromResponse(response);
        candidates.push(...extracted);
      } catch (err: any) {
        console.warn(`[FirstFrameGenerator] Primary model ${primaryModel} failed:`, err);
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      // Fallback Attempt 2: gemini-2.5-flash for Vertex AI endpoints
      if (candidates.length === 0) {
        console.warn(`[FirstFrameGenerator] Trying fallback model gemini-2.5-flash...`);
        try {
          const vertexResponse = await callWithRetry(
            () =>
              ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ role: 'user', parts }],
              }),
            { actionName: `首帧图像重构生成 (降级模组 gemini-2.5-flash)` }
          );

          const vertexExtracted = await extractCandidatesFromResponse(vertexResponse);
          candidates.push(...vertexExtracted);
        } catch (vErr: any) {
          console.warn(`[FirstFrameGenerator] Fallback model gemini-2.5-flash also failed:`, vErr);
        }
      }

      if (candidates.length === 0) {
        if (lastError) {
          throw lastError;
        }
        throw new Error('模型响应中未找到合规图像输出，请检查图像是否触发安全审查或更换包含清晰面部的母板图');
      }

      return candidates;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`首帧重建生成失败: ${redactSecrets(msg)}`);
    }
  }
}
