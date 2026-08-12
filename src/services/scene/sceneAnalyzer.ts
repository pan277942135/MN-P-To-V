import { GoogleGenAI, Type } from '@google/genai';
import type { StructuredSceneAnalysis, SceneMode } from '../../types';
import { redactSecrets } from '../../utils/redactSecrets';
import { callWithRetry } from '../../utils/retryHelper';

export class SceneAnalyzer {
  static async analyzeSceneImage(
    ai: GoogleGenAI,
    sceneImageBuffer: Buffer,
    mimeType: string,
    modelName?: string
  ): Promise<StructuredSceneAnalysis> {
    const promptText = `
你是一名专业的前期制片与摄影指导。请对输入的 9:16 场景图进行深度结构化视觉解析，提取全要素元数据，用于后续角色替换与视频动效生成。

解析要求：
1. 是否包含人物？有多少清晰人物？
2. 主体人物的位置、头部角度、视线方向、姿态与肢体遮挡。
3. 主体服装、鞋靴、饰品、道具、背景环境、光线色温与镜头摄影参数。
4. 评估该场景是否适合 8 秒连续微动作镜头，并指出潜在肢体畸变或身份漂移风险。
5. 推荐场景模式：
   - replace_primary_person: 场景图中是其他人，需要将脸部、头皮、发际线、头发替换为目标角色，同时保持原图中所有姿势、服装、道具、背景、光影与构图。
   - animate_existing_character: 场景图中已经是目标角色，直接驱动动效。
   - add_character_to_empty_scene: 场景图无人物，需要自然植入角色。

必须输出严格 JSON 格式。
`;

    const targetModel = modelName || 'gemini-2.5-flash';

    try {
      const runGenerate = async (m: string) => {
        return await callWithRetry(
          () =>
            ai.models.generateContent({
              model: m,
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      inlineData: {
                        mimeType,
                        data: sceneImageBuffer.toString('base64'),
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
                    hasPerson: { type: Type.BOOLEAN },
                    personCount: { type: Type.INTEGER },
                    primaryPersonLocation: { type: Type.STRING },
                    headAngleAndGaze: { type: Type.STRING },
                    poseAndLimbOcclusion: { type: Type.STRING },
                    outfitAndAccessories: { type: Type.STRING },
                    props: { type: Type.STRING },
                    background: { type: Type.STRING },
                    lightingAndColorTemp: { type: Type.STRING },
                    cameraSettings: { type: Type.STRING },
                    suitableFor8sMotion: { type: Type.BOOLEAN },
                    motionRisks: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    recommendedSceneMode: {
                      type: Type.STRING,
                      description: 'replace_primary_person | animate_existing_character | add_character_to_empty_scene',
                    },
                  },
                  required: [
                    'hasPerson',
                    'personCount',
                    'primaryPersonLocation',
                    'headAngleAndGaze',
                    'poseAndLimbOcclusion',
                    'outfitAndAccessories',
                    'props',
                    'background',
                    'lightingAndColorTemp',
                    'cameraSettings',
                    'suitableFor8sMotion',
                    'motionRisks',
                    'recommendedSceneMode',
                  ],
                },
              },
            }),
          { actionName: '场景图像分析' }
        );
      };

      let response;
      try {
        response = await runGenerate(targetModel);
      } catch (err: any) {
        if (targetModel !== 'gemini-2.5-flash' && (String(err).includes('404') || String(err).includes('not found'))) {
          console.warn(`[SceneAnalyzer] Model ${targetModel} not found on endpoint, retrying with gemini-2.5-flash...`);
          response = await runGenerate('gemini-2.5-flash');
        } else {
          throw err;
        }
      }

      const jsonText = response.text?.trim() || '{}';
      const parsed = JSON.parse(jsonText);

      let sceneMode: SceneMode = 'replace_primary_person';
      if (
        parsed.recommendedSceneMode === 'animate_existing_character' ||
        parsed.recommendedSceneMode === 'add_character_to_empty_scene' ||
        parsed.recommendedSceneMode === 'replace_primary_person'
      ) {
        sceneMode = parsed.recommendedSceneMode;
      }

      if (!parsed.hasPerson) {
        sceneMode = 'add_character_to_empty_scene';
      }

      return {
        hasPerson: Boolean(parsed.hasPerson),
        personCount: parsed.personCount || 0,
        primaryPersonLocation: parsed.primaryPersonLocation || 'center',
        headAngleAndGaze: parsed.headAngleAndGaze || 'facing camera',
        poseAndLimbOcclusion: parsed.poseAndLimbOcclusion || 'standing',
        outfitAndAccessories: parsed.outfitAndAccessories || 'casual outfit',
        props: parsed.props || 'none',
        background: parsed.background || 'indoor neutral',
        lightingAndColorTemp: parsed.lightingAndColorTemp || 'soft cinematic light',
        cameraSettings: parsed.cameraSettings || 'medium eye-level shot',
        suitableFor8sMotion: parsed.suitableFor8sMotion ?? true,
        motionRisks: parsed.motionRisks || [],
        recommendedSceneMode: sceneMode,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[SceneAnalyzer] analyzeSceneImage failed (${msg}), using high-quality fallback scene analysis.`);
      return {
        hasPerson: true,
        personCount: 1,
        primaryPersonLocation: 'center portrait',
        headAngleAndGaze: 'facing camera slightly angled',
        poseAndLimbOcclusion: 'natural posture in scene',
        outfitAndAccessories: 'outfit as shown in reference scene image',
        props: 'none',
        background: 'background as shown in reference scene image',
        lightingAndColorTemp: 'natural ambient lighting',
        cameraSettings: '9:16 portrait medium close-up',
        suitableFor8sMotion: true,
        motionRisks: [],
        recommendedSceneMode: 'replace_primary_person',
      };
    }
  }

  static async normalizePrompt(
    ai: GoogleGenAI,
    userPromptChinese: string,
    sceneAnalysis: StructuredSceneAnalysis,
    identityLockEnglish: string,
    visualStyle: string,
    secondaryStyle: string,
    styleStrength: number,
    modelName?: string
  ) {
    const promptText = `
你是一名资深电影导演与生成式视频 Prompt 架构师。
请将用户的中文动作描述与视觉风格，转化为包含 8 秒时间轴、动作分拆、镜头运镜、负向约束与完整英文视频 Prompt 的结构化脚本。

用户输入动作描述: "${userPromptChinese}"
场景解析上下文: ${JSON.stringify(sceneAnalysis)}
主风格: ${visualStyle}
辅助风格: ${secondaryStyle} (强度: ${styleStrength})
角色身份锁定英文: ${identityLockEnglish}

规则：
1. 必须输出完整 8 秒动作时间轴 (0~2s, 2~5s, 5~8s)。如果用户只说"让她动起来"，请只添加低风险微动作（自然呼吸、一次眨眼、轻微视线挪动、发丝微摆）。
2. 英文 Prompt 中必须包含：
   - "In a single continuous unbroken shot."
   - "No scene cuts, no transitions, no teleportation."
   - 明确的 8 秒时间轴与动作分解。
   - 角色 Identity Lock 描述：${identityLockEnglish}。
   - 保持同一脸部、年龄、发型、服装、身体比例。
   - 避免多余肢体、脸部变形、发型突变或瞬间移动。
3. 如果指定了视觉风格（如"电影剧照"、"动漫"、"赛博朋克"），请准确融入光学细节、光影与画质参数，但不得覆盖角色身份锁定与真实姿态。

输出格式必须为严格 JSON。
`;

    const targetModel = modelName || 'gemini-2.5-flash';

    try {
      const runGenerate = async (m: string) => {
        return await callWithRetry(
          () =>
            ai.models.generateContent({
              model: m,
              contents: [
                {
                  role: 'user',
                  parts: [{ text: promptText }],
                },
              ],
              config: {
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    subjectAction: { type: Type.STRING },
                    facialExpression: { type: Type.STRING },
                    gaze: { type: Type.STRING },
                    handAction: { type: Type.STRING },
                    bodyMotion: { type: Type.STRING },
                    cameraMotion: { type: Type.STRING },
                    environmentMotion: { type: Type.STRING },
                    lighting: { type: Type.STRING },
                    audio: { type: Type.STRING },
                    timeline: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          timeRange: { type: Type.STRING },
                          description: { type: Type.STRING },
                        },
                        required: ['timeRange', 'description'],
                      },
                    },
                    negativeConstraints: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    normalizedPromptEnglish: {
                      type: Type.STRING,
                      description: '最终用于发送给视频生成模型的完整英文 Prompt',
                    },
                  },
                  required: [
                    'subjectAction',
                    'facialExpression',
                    'gaze',
                    'handAction',
                    'bodyMotion',
                    'cameraMotion',
                    'environmentMotion',
                    'lighting',
                    'audio',
                    'timeline',
                    'negativeConstraints',
                    'normalizedPromptEnglish',
                  ],
                },
              },
            }),
          { actionName: '提示词脚本标准化解析' }
        );
      };

      let response;
      try {
        response = await runGenerate(targetModel);
      } catch (err: any) {
        if (targetModel !== 'gemini-2.5-flash' && (String(err).includes('404') || String(err).includes('not found'))) {
          console.warn(`[SceneAnalyzer] Model ${targetModel} not found on endpoint, retrying with gemini-2.5-flash...`);
          response = await runGenerate('gemini-2.5-flash');
        } else {
          throw err;
        }
      }

      const jsonText = response.text?.trim() || '{}';
      const parsed = JSON.parse(jsonText);

      return {
        promptScript: {
          subjectAction: parsed.subjectAction || userPromptChinese,
          facialExpression: parsed.facialExpression || 'natural facial expression with subtle eye movement',
          gaze: parsed.gaze || sceneAnalysis?.headAngleAndGaze || 'facing camera with soft gaze',
          handAction: parsed.handAction || 'holding posture naturally with fine detail',
          bodyMotion: parsed.bodyMotion || 'subtle natural breathing and soft body movement',
          cameraMotion: parsed.cameraMotion || 'slow smooth cinematic push-in, 9:16 portrait tracking',
          environmentMotion: parsed.environmentMotion || 'subtle environmental shift and atmospheric lighting',
          lighting: parsed.lighting || sceneAnalysis?.lightingAndColorTemp || 'cinematic soft lighting',
          audio: parsed.audio || 'ambient gentle environmental sound',
          timeline: parsed.timeline || [
            { timeRange: '0s - 2s', description: `Initial pose, breathing motion, ${userPromptChinese.slice(0, 30)}` },
            { timeRange: '2s - 5s', description: 'Gentle posture shift, soft eye blink, continuous movement' },
            { timeRange: '5s - 8s', description: 'Slight gaze movement, subtle smile, smooth ending' },
          ],
          negativeConstraints: parsed.negativeConstraints || [
            'no face swapping',
            'no morphing',
            'no scene cuts',
            'no extra limbs',
            'no teleportation',
          ],
          primaryVisualStyle: visualStyle,
          secondaryVisualStyle: secondaryStyle,
          styleStrength,
        },
        normalizedPromptEnglish: parsed.normalizedPromptEnglish || `In a single continuous unbroken 8-second shot. No scene cuts, no transitions, no teleportation. Character Identity: ${identityLockEnglish || 'target character'}. Action: ${userPromptChinese}. Visual style: ${visualStyle}${secondaryStyle ? `, ${secondaryStyle}` : ''}. Camera: slow smooth tracking shot in 9:16 portrait aspect ratio. Maintain exact face, age, hairstyle, outfit, and body proportion throughout.`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[SceneAnalyzer] normalizePrompt failed (${msg}), using deterministic fallback script.`);
      const cleanUserPrompt = userPromptChinese || '动作姿态演化';
      const cleanIdentity = identityLockEnglish || 'target character with locked features';
      const cleanStyle = visualStyle || '照片级写实';
      const fullStyle = secondaryStyle ? `${cleanStyle}, ${secondaryStyle}` : cleanStyle;

      return {
        promptScript: {
          subjectAction: cleanUserPrompt,
          facialExpression: 'natural facial expression, subtle eye motion and soft gaze',
          gaze: sceneAnalysis?.headAngleAndGaze || 'facing camera with soft gaze',
          handAction: 'holding posture naturally with fine hand detail',
          bodyMotion: 'slight natural breathing and subtle posture shift',
          cameraMotion: 'slow smooth cinematic push-in, 9:16 portrait tracking',
          environmentMotion: 'subtle environmental movement and atmospheric lighting shifts',
          lighting: sceneAnalysis?.lightingAndColorTemp || 'cinematic soft lighting with natural shadows',
          audio: 'ambient gentle environmental sound',
          timeline: [
            { timeRange: '0s - 2s', description: `Initial pose, breathing motion, ${cleanUserPrompt.slice(0, 30)}` },
            { timeRange: '2s - 5s', description: 'Gentle posture shift, soft eye blink, continuous movement' },
            { timeRange: '5s - 8s', description: 'Slight gaze movement, subtle smile, smooth ending' },
          ],
          negativeConstraints: [
            'no face swapping',
            'no morphing',
            'no scene cuts',
            'no extra limbs',
            'no teleportation',
          ],
          primaryVisualStyle: cleanStyle,
          secondaryVisualStyle: secondaryStyle || '',
          styleStrength: styleStrength ?? 0.5,
        },
        normalizedPromptEnglish: `In a single continuous unbroken 8-second shot. No scene cuts, no transitions, no teleportation. Character Identity: ${cleanIdentity}. Action: ${cleanUserPrompt}. Visual style: ${fullStyle}. Camera: slow smooth tracking shot in 9:16 portrait aspect ratio. Maintain exact face, age, hairstyle, outfit, and body proportion throughout without morphing or distortion.`,
      };
    }
  }
}
