import sharp from 'sharp';
import { GoogleGenAI, Type } from '@google/genai';
import type {
  CharacterProfile,
  CharacterReference,
  IdentitySpec,
  AngleTag,
} from '../../types';
import { redactSecrets } from '../../utils/redactSecrets';
import { callWithRetry } from '../../utils/retryHelper';

export class IdentityBuilder {
  static async processReferenceImage(
    buffer: Buffer,
    mimeType: string,
    sortOrder: number
  ): Promise<{
    processedBuffer: Buffer;
    thumbnailBuffer: Buffer;
    mimeType: string;
    width: number;
    height: number;
  }> {
    // Sharp auto EXIF rotation and image inspection
    const imagePipeline = sharp(buffer).rotate();
    const metadata = await imagePipeline.metadata();

    const width = metadata.width || 1080;
    const height = metadata.height || 1080;

    // Convert to webp or jpeg if needed for clean standardization
    const processedBuffer = await imagePipeline.jpeg({ quality: 92 }).toBuffer();

    const thumbnailBuffer = await sharp(processedBuffer)
      .resize({ width: 320, height: 320, fit: 'cover' })
      .jpeg({ quality: 80 })
      .toBuffer();

    return {
      processedBuffer,
      thumbnailBuffer,
      mimeType: 'image/jpeg',
      width,
      height,
    };
  }

  static async analyzeCharacterProfile(
    ai: GoogleGenAI,
    profileName: string,
    profileDescription: string,
    adultConfirmed: boolean,
    rightsConfirmed: boolean,
    images: Array<{ buffer: Buffer; mimeType: string }>,
    analysisModel?: string
  ): Promise<{
    identitySpec: IdentitySpec;
    references: CharacterReference[];
    selectedImageReferenceIds: string[];
    selectedVideoReferenceIds: string[];
    status: 'ready' | 'error';
    analysisError?: string;
  }> {
    if (!adultConfirmed) {
      throw new Error('建立虚拟角色必须确认该角色为成年人');
    }

    if (!rightsConfirmed) {
      throw new Error('建立虚拟角色必须确认拥有相关素材使用权');
    }

    if (images.length < 3 || images.length > 8) {
      throw new Error('角色母板图片数量必须在 3～8 张之间');
    }

    // Process all images with sharp
    const references: CharacterReference[] = [];
    const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const processed = await this.processReferenceImage(img.buffer, img.mimeType, i);

      const refId = `ref_${i}_${crypto.randomUUID().slice(0, 8)}`;
      const originalBlob = new Blob([new Uint8Array(processed.processedBuffer)], { type: processed.mimeType });
      const thumbnailUrl = `data:image/jpeg;base64,${processed.thumbnailBuffer.toString('base64')}`;

      references.push({
        id: refId,
        blob: originalBlob,
        originalBlob: originalBlob,
        thumbnailUrl: thumbnailUrl,
        mimeType: processed.mimeType,
        width: processed.width,
        height: processed.height,
        angle: i === 0 ? 'front' : i === 1 ? 'left_45' : i === 2 ? 'right_45' : 'other',
        qualityScore: 90,
        qualityIssues: [],
        sortOrder: i,
      });

      imageParts.push({
        inlineData: {
          mimeType: processed.mimeType,
          data: processed.processedBuffer.toString('base64'),
        },
      });
    }

    // Call gemini-3.6-flash to produce structured IdentitySpec JSON
    const promptText = `
你是一名资深电影造型与视觉质检专家。
请仔细分析这 ${images.length} 张多角度人物母板照片，结合用户给出的角色描述原文，提取唯一、稳定、精确的角色身份特征规范 (IdentitySpec)。

角色名称: ${profileName}
用户输入的角色描述原文: "${profileDescription}"

【严格提取规则】:
1. 只能提取用户在描述原文中【明确写出】的特征项（例如发色、发型、眼睛、衣服、饰品、肤色、脸型等）。
2. 每项提取的特征保存到 lockedTraits 列表中，包含:
   - traitName: 特征名称 (如 "hairColor", "hairStyle", "facialFeatures", "eyeColor", "glasses", "outfit", "bodyBuild", "skinTone" 等)
   - expectedValue: 特征在描述原文中的具体期望值 (例如 "银发双马尾", "细框眼镜", "红色旗袍")
   - sourceText: 对应用户描述原文中的精准语句词段
3. 用户在描述原文中【没有提及】的特征，【一律不得自行猜测、补全或引入通用默认值】！
4. 严格禁止添加“黑发短发”、“五官清晰”、“标准身材”、“双眼皮”、“黑瞳”等任何未在原文中写明的通用默认描述。
5. 请评估母板照片是否均指向同一人物、是否有清晰正面照片。

输出必须严格遵守 JSON 格式。
`;

    const targetModel = analysisModel || 'gemini-2.5-flash';

    try {
      const runGenerate = async (m: string) => {
        return await callWithRetry(
          () =>
            ai.models.generateContent({
              model: m,
              contents: [
                {
                  role: 'user',
                  parts: [...imageParts, { text: promptText }],
                },
              ],
              config: {
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    adultStatus: { type: Type.STRING, description: '固定为 confirmed_adult' },
                    lockedTraits: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          traitName: { type: Type.STRING },
                          expectedValue: { type: Type.STRING },
                          sourceText: { type: Type.STRING },
                        },
                        required: ['traitName', 'expectedValue', 'sourceText'],
                      },
                    },
                    identityLockPromptEnglish: {
                      type: Type.STRING,
                      description: '仅依据用户给出的描述提炼的英文身份锁定描述',
                    },
                    identityLockPromptChinese: {
                      type: Type.STRING,
                      description: '中文身份锁定描述',
                    },
                    hasFrontClearPhoto: { type: Type.BOOLEAN },
                    consistencyConflictDetected: { type: Type.BOOLEAN },
                    conflictReason: { type: Type.STRING },
                  },
                  required: [
                    'adultStatus',
                    'lockedTraits',
                    'identityLockPromptEnglish',
                    'identityLockPromptChinese',
                    'hasFrontClearPhoto',
                    'consistencyConflictDetected',
                  ],
                },
              },
            }),
          { actionName: '角色身份锁定分析' }
        );
      };

      let response;
      try {
        response = await runGenerate(targetModel);
      } catch (err: any) {
        if (targetModel !== 'gemini-2.5-flash') {
          console.warn(`[IdentityBuilder] Model ${targetModel} failed, retrying with gemini-2.5-flash:`, err);
          response = await runGenerate('gemini-2.5-flash');
        } else {
          throw err;
        }
      }

      const jsonText = response.text?.trim() || '{}';
      let parsed: any = {};
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        const cleanJson = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        try {
          parsed = JSON.parse(cleanJson);
        } catch {
          console.warn('[IdentityBuilder] JSON parse fallback failed, using empty object');
        }
      }

      const extractedLockedTraits = Array.isArray(parsed.lockedTraits)
        ? parsed.lockedTraits.map((t: any) => ({
            traitName: String(t.traitName || 'customTrait'),
            expectedValue: String(t.expectedValue || ''),
            sourceText: String(t.sourceText || profileDescription),
          }))
        : [];

      const identitySpec: IdentitySpec = {
        lockedTraits: extractedLockedTraits,
        adultStatus: 'confirmed_adult',
        identityLockPromptEnglish: parsed.identityLockPromptEnglish || profileDescription || '',
        identityLockPromptChinese: parsed.identityLockPromptChinese || profileDescription || '',
      };

      if (parsed.consistencyConflictDetected) {
        return {
          identitySpec,
          references,
          selectedImageReferenceIds: [],
          selectedVideoReferenceIds: [],
          status: 'error',
          analysisError: `母板照片存在不一致冲突: ${parsed.conflictReason || '多张照片人物特征冲突'}`,
        };
      }

      if (!parsed.hasFrontClearPhoto) {
        return {
          identitySpec,
          references,
          selectedImageReferenceIds: [],
          selectedVideoReferenceIds: [],
          status: 'error',
          analysisError: '角色母板中缺少清晰正面照片，无法完成角色立项',
        };
      }

      // Auto select reference photos
      const selectedImageReferenceIds = references.slice(0, 4).map((r) => r.id);
      const selectedVideoReferenceIds = references.slice(0, 3).map((r) => r.id);

      return {
        identitySpec,
        references,
        selectedImageReferenceIds,
        selectedVideoReferenceIds,
        status: 'ready',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`角色分析失败: ${redactSecrets(msg)}`);
    }
  }
}
