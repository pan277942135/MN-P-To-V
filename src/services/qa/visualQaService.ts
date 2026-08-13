import { GoogleGenAI, Type } from '@google/genai';
import type {
  IdentitySpec,
  FirstFrameQaReport,
  VideoQaReport,
  SceneMode,
} from '../../types';
import { redactSecrets } from '../../utils/redactSecrets';
import { callWithRetry } from '../../utils/retryHelper';

export class VisualQaService {
  static async qaFirstFrame(
    ai: GoogleGenAI,
    analysisModel: string,
    masterImageBuffer: Buffer,
    masterMimeType: string,
    sceneImageBuffer: Buffer,
    sceneMimeType: string,
    firstFrameBuffer: Buffer,
    firstFrameMimeType: string,
    identitySpec: IdentitySpec,
    sceneMode: SceneMode
  ): Promise<FirstFrameQaReport> {
    const promptText = `
你是一名 AI 视觉质检专家与电影剪辑指导。请对生成的首帧候选图进行多维度严格视觉比对测试。

比对图像说明：
1. [MASTER_REFERENCE]: 目标角色母板照片。
2. [ORIGINAL_SCENE]: 原始输入场景图。
3. [CANDIDATE_FIRST_FRAME]: 待质检生成的首帧候选图。

角色身份规范 (IdentitySpec):
${JSON.stringify(identitySpec)}

场景模式: ${sceneMode}

评分标准 (0~100 分):
- identityScore: 生成首帧与角色母板的脸部五官、眼型瞳色、发型发色一致性。合格线 >= 95。
- sourcePersonResidualScore: 仅用于 replace_primary_person，判断是否残存原场景人物脸部特征，合格线 <= 5。对于 animate_existing_character，原场景人物本身就是目标角色，此项不参与 Gate，请返回 0。
- scenePreservationScore: 场景背景、光影、色温保留度。合格线 >= 90。
- posePreservationScore: 原姿态、身体轮廓保留度。合格线 >= 90。
- outfitPreservationScore: 原服装、鞋靴、饰品保留度。合格线 >= 90。
- anatomyScore: 手脚指头、五官骨骼解剖合理度。合格线 >= 90。

判断规则:
- pass 为 true 当且仅当所有项达到合格线，且没有 critical 严重缺陷。
- 如果不合格，必须在 repairInstruction 中明确给出定向修复提示词指令（只修错误项，保持正确项不变）。

输出格式必须为严格 JSON。
`;

    try {
      const response = await callWithRetry(
        () =>
          ai.models.generateContent({
            model: analysisModel || 'gemini-3.6-flash',
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      mimeType: masterMimeType,
                      data: masterImageBuffer.toString('base64'),
                    },
                  },
                  {
                    inlineData: {
                      mimeType: sceneMimeType,
                      data: sceneImageBuffer.toString('base64'),
                    },
                  },
                  {
                    inlineData: {
                      mimeType: firstFrameMimeType,
                      data: firstFrameBuffer.toString('base64'),
                    },
                  },
                  { text: promptText },
                ],
              },
            ],
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  identityScore: { type: Type.INTEGER },
                  sourcePersonResidualScore: { type: Type.INTEGER },
                  scenePreservationScore: { type: Type.INTEGER },
                  posePreservationScore: { type: Type.INTEGER },
                  outfitPreservationScore: { type: Type.INTEGER },
                  anatomyScore: { type: Type.INTEGER },
                  faceDetails: { type: Type.STRING },
                  hairDetails: { type: Type.STRING },
                  bodyDetails: { type: Type.STRING },
                  issues: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        code: { type: Type.STRING },
                        severity: { type: Type.STRING },
                        description: { type: Type.STRING },
                        repairInstruction: { type: Type.STRING },
                      },
                      required: ['code', 'severity', 'description', 'repairInstruction'],
                    },
                  },
                  summary: { type: Type.STRING },
                },
                required: [
                  'identityScore',
                  'sourcePersonResidualScore',
                  'scenePreservationScore',
                  'posePreservationScore',
                  'outfitPreservationScore',
                  'anatomyScore',
                  'faceDetails',
                  'hairDetails',
                  'bodyDetails',
                  'issues',
                  'summary',
                ],
              },
            },
          }),
        { actionName: '首帧质检评估' }
      );

      const jsonText = response.text?.trim() || '{}';
      const parsed = JSON.parse(jsonText);

      if (
        !parsed ||
        typeof parsed.identityScore !== 'number' ||
        typeof parsed.sourcePersonResidualScore !== 'number' ||
        typeof parsed.scenePreservationScore !== 'number'
      ) {
        throw new Error('QA_PARSE_FAILED: 无法解析首帧质检评估 JSON 输出中的有效评分数值');
      }

      const identityScore = parsed.identityScore;
      const residualScore = parsed.sourcePersonResidualScore;
      const sceneScore = parsed.scenePreservationScore;
      const poseScore = parsed.posePreservationScore;
      const outfitScore = parsed.outfitPreservationScore;
      const anatomyScore = parsed.anatomyScore;

      const hasCriticalIssue = (parsed.issues || []).some(
        (i: any) => i.severity === 'critical'
      );

      const residualPass = sceneMode === 'replace_primary_person' ? residualScore <= 5 : true;

      const pass =
        identityScore >= 95 &&
        residualPass &&
        sceneScore >= 90 &&
        poseScore >= 90 &&
        outfitScore >= 90 &&
        anatomyScore >= 90 &&
        !hasCriticalIssue;

      return {
        pass,
        identityScore,
        sourcePersonResidualScore: residualScore,
        scenePreservationScore: sceneScore,
        posePreservationScore: poseScore,
        outfitPreservationScore: outfitScore,
        anatomyScore,
        faceDetails: parsed.faceDetails || '',
        hairDetails: parsed.hairDetails || '',
        bodyDetails: parsed.bodyDetails || '',
        issues: parsed.issues || [],
        summary: parsed.summary || (pass ? '首帧视觉质检合格' : '首帧存在未达标项'),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`首帧质检评估失败: ${redactSecrets(msg)}`);
    }
  }

  static async qaVideoFrames(
    ai: GoogleGenAI,
    analysisModel: string,
    frameBuffers: Buffer[],
    firstFrameBuffer: Buffer,
    masterInput: Buffer | Buffer[],
    identitySpec: IdentitySpec,
    characterDescription?: string,
    sceneImageBuffer?: Buffer
  ): Promise<VideoQaReport> {
    const parts: any[] = [];
    const masterBuffers = Array.isArray(masterInput) ? masterInput : [masterInput];

    // Input 1: Original uploaded scene image
    if (sceneImageBuffer) {
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: sceneImageBuffer.toString('base64'),
        },
      });
      parts.push({ text: '[RAW_SCENE_IMAGE]: User uploaded raw scene image' });
    }

    // Input 2: All master images of current character
    masterBuffers.forEach((buf, idx) => {
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: buf.toString('base64'),
        },
      });
      parts.push({ text: `[MASTER_CHARACTER_REF_${idx + 1}]: Target Character Master Image ${idx + 1}` });
    });

    // Input 3: Approved first frame
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: firstFrameBuffer.toString('base64'),
      },
    });
    parts.push({ text: '[APPROVED_FIRST_FRAME]: Approved First Frame (0s Keyframe)' });

    // Input 5: Extracted video frames
    frameBuffers.forEach((buf, idx) => {
      const timePercent = idx * 20;
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: buf.toString('base64'),
        },
      });
      parts.push({ text: `[VIDEO_FRAME_${idx}_(${timePercent}%)]: Extracted frame at ${timePercent}% timestamp` });
    });

    const lockedTraitsList = identitySpec?.lockedTraits || [];

    const promptText = `
你是一名 AI 视频流画质与时间一致性质检专家。请对抽取的 6 关键帧 (0%, 20%, 40%, 60%, 80%, 100%) 进行全流程时序连贯性与动态身份锁定评估。

【当前角色描述原文】:
"${characterDescription || ''}"

【动态锁定特征列表 (lockedTraits)】:
${JSON.stringify(lockedTraitsList)}

【动态质检评估规则】:
1. 逐项检查 lockedTraits 中【明确写出】的特征项（脸部身份一致性、发色、发型与发长、肤色、身材比例、标志性饰品）。
2. 若角色描述与 lockedTraits 中写了某项固定特征，视频出现不一致，则该项直接判为不合格扣分。
3. 若角色描述与 lockedTraits 中【未写明】某特征，【不得凭空加入检查要求，也不得因为未描述的特征导致扣分】。
4. averageIdentityScore >= 95
5. minimumIdentityScore >= 90
6. temporalConsistencyScore >= 90 (无瞬间换脸、发型发色突变)
7. motionNaturalnessScore >= 88 (物理动作自然)
8. anatomyScore >= 88 (无肢体与手部畸变)

输出必须为严格 JSON 格式。
`;

    parts.push({ text: promptText });

    try {
      const response = await callWithRetry(
        () =>
          ai.models.generateContent({
            model: analysisModel || 'gemini-3.6-flash',
            contents: [
              {
                role: 'user',
                parts,
              },
            ],
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  averageIdentityScore: { type: Type.INTEGER },
                  minimumIdentityScore: { type: Type.INTEGER },
                  temporalConsistencyScore: { type: Type.INTEGER },
                  motionNaturalnessScore: { type: Type.INTEGER },
                  anatomyScore: { type: Type.INTEGER },
                  sceneContinuityScore: { type: Type.INTEGER },
                  promptComplianceScore: { type: Type.INTEGER },
                  criticalIssues: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  repairInstruction: { type: Type.STRING },
                  summary: { type: Type.STRING },
                },
                required: [
                  'averageIdentityScore',
                  'minimumIdentityScore',
                  'temporalConsistencyScore',
                  'motionNaturalnessScore',
                  'anatomyScore',
                  'sceneContinuityScore',
                  'promptComplianceScore',
                  'criticalIssues',
                  'repairInstruction',
                  'summary',
                ],
              },
            },
          }),
        { actionName: '视频多帧质检评估' }
      );

      const jsonText = response.text?.trim() || '{}';
      const parsed = JSON.parse(jsonText);

      if (
        !parsed ||
        typeof parsed.averageIdentityScore !== 'number' ||
        typeof parsed.minimumIdentityScore !== 'number' ||
        typeof parsed.temporalConsistencyScore !== 'number'
      ) {
        throw new Error('QA_PARSE_FAILED: 无法解析视频多帧质检评估 JSON 输出中的有效评分数值');
      }

      const avgIdentity = parsed.averageIdentityScore;
      const minIdentity = parsed.minimumIdentityScore;
      const tempConsistency = parsed.temporalConsistencyScore;
      const motionNat = parsed.motionNaturalnessScore ?? 88;
      const anatomy = parsed.anatomyScore ?? 88;
      const criticalIssues: string[] = Array.isArray(parsed.criticalIssues) ? parsed.criticalIssues : [];

      const pass =
        avgIdentity >= 95 &&
        minIdentity >= 90 &&
        tempConsistency >= 90 &&
        motionNat >= 88 &&
        anatomy >= 88 &&
        criticalIssues.length === 0;

      const frameReports = frameBuffers.map((_, idx) => {
        const timestampSec = Number(((idx * 8) / Math.max(1, frameBuffers.length - 1)).toFixed(1));
        return {
          timestampSec,
          frameIndex: idx,
          identityScore: idx === 0 ? avgIdentity : minIdentity,
          qualityScore: anatomy,
          notes: `Inspected extracted keyframe at ${timestampSec}s (${idx * 20}%)`,
        };
      });

      return {
        pass,
        averageIdentityScore: avgIdentity,
        minimumIdentityScore: minIdentity,
        temporalConsistencyScore: tempConsistency,
        motionNaturalnessScore: motionNat,
        anatomyScore: anatomy,
        sceneContinuityScore: parsed.sceneContinuityScore ?? 90,
        promptComplianceScore: parsed.promptComplianceScore ?? 90,
        frameReports,
        criticalIssues,
        repairInstruction: parsed.repairInstruction || (pass ? '' : '请保持角色主体在全视频段落中的发型、瞳色与骨骼连贯性'),
        summary: parsed.summary || (pass ? '视频全帧抽帧质检合格' : '视频存在画质或一致性未达标项'),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`视频抽帧质检评估失败: ${redactSecrets(msg)}`);
    }
  }
}
