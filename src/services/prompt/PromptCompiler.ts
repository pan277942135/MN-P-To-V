import type { IdentitySpec } from '../../types';

export type MotionIntensity = 'minimal' | 'natural' | 'expressive';

export interface FirstFrameMetadataInput {
  width?: number;
  height?: number;
  aspectRatio?: string;
  hasPerson?: boolean;
  clothingSummary?: string;
  accessoriesSummary?: string;
  mimeType?: string;
}

export interface MinimalCharacterProfile {
  name?: string;
  description?: string;
  identitySpec?: IdentitySpec;
}

export interface PromptCompilerInput {
  durationSeconds: number; // 4, 6, 8
  firstFrameMetadata?: FirstFrameMetadataInput;
  userMotionPrompt: string;
  motionIntensity: MotionIntensity; // default 'natural'
  characterProfile?: MinimalCharacterProfile;
  visualStyle?: string;
  cameraPreset?: string;
}

export interface PromptCompilerOutput {
  rawUserPrompt: string;
  identityConstraints: string;
  motionPrompt: string;
  cameraConstraints: string;
  stylePrompt: string;
  negativeConstraints: string;
  compiledPrompt: string;
  compilerVersion: string;
}

export interface MotionRiskResult {
  detectedRiskKeywords: string[];
  warnings: string[];
  hasHighRisk: boolean;
}

export class PromptCompiler {
  public static readonly VERSION = 'v1.2.0-compiler';

  public static readonly HIGH_RISK_KEYWORDS = [
    '转身', '走动', '回头', '走向镜头', '遮脸', '快速移动', '大幅抬手', '快速回头', '镜头环绕', '复杂口型', '多段不连续动作',
    'turn around', 'walk away', 'walk toward camera', 'walk toward', 'large hand gesture', 'cover face', 'quick glance back',
    'camera orbit', 'complex lip sync', 'spin', 'rotate', 'walk', 'run', 'large head turn', 'large pose change', 'face occlusion', 'fast movement'
  ];

  /**
   * Classify identity drift risk according to motion intensity and risk keywords.
   * LOW: breathing, blink, micro-expression, small weight shift
   * MEDIUM: small hand movement, small body turn
   * HIGH: large head turn, profile -> frontal, walking toward camera, large pose change, face occlusion, fast movement
   */
  public static classifyIdentityDriftRisk(userPrompt: string = ''): {
    identityDriftRisk: 'low' | 'medium' | 'high';
    warning?: string;
    detectedKeywords: string[];
  } {
    const safePrompt = (userPrompt || '').toLowerCase();
    const detected: string[] = [];

    for (const kw of this.HIGH_RISK_KEYWORDS) {
      if (safePrompt.includes(kw.toLowerCase())) {
        detected.push(kw);
      }
    }

    if (detected.length > 0) {
      return {
        identityDriftRisk: 'high',
        warning: `检测到高风险动作 [${detected.join(', ')}]，在 Veo 生成中存在角色身份漂移风险。`,
        detectedKeywords: detected,
      };
    }

    // Medium risk check
    const mediumKeywords = ['hand movement', 'body turn', '小手势', '微转头', '手部动作'];
    for (const mkw of mediumKeywords) {
      if (safePrompt.includes(mkw.toLowerCase())) {
        return {
          identityDriftRisk: 'medium',
          warning: `检测到中风险动作 [${mkw}]。`,
          detectedKeywords: [mkw],
        };
      }
    }

    return {
      identityDriftRisk: 'low',
      detectedKeywords: [],
    };
  }

  /**
   * Motion-first prompt strategy for Image-To-Video (I2V) in M2-1.
   * Relies on the uploaded first frame for WHO / WHAT / WHERE.
   * Focuses the prompt strictly on MOTION and forbids re-describing physical details
   * (e.g. Asian female, young woman, hair color, face shape, body/wardrobe description)
   * unless strictly necessary for motion semantics.
   */
  public static compileI2VMotionPrompt(input: {
    userMotionPrompt: string;
    durationSeconds?: number;
    cameraPreset?: string;
  }): string {
    const duration = input.durationSeconds || 4;
    const motionRaw = this.cleanUserMotionPrompt(input.userMotionPrompt) || 'Natural subtle breathing motion and gentle posture shift.';
    
    // Strip redundant physical re-descriptions if present in motion string
    const motion = motionRaw
      .replace(/\b(Asian female|young woman|black hair|brown eyes|oval face|slender body|white shirt)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    let cameraDesc = 'Fixed camera.';
    if (input.cameraPreset === 'slow_push') cameraDesc = 'Slow camera push-in.';
    else if (input.cameraPreset === 'slow_pull') cameraDesc = 'Slow camera pull-back.';
    else if (input.cameraPreset === 'subtle_pan') cameraDesc = 'Gentle horizontal camera pan.';

    return [
      `Use the uploaded image as the exact first frame.`,
      ``,
      `For ${duration} seconds:`,
      motion || 'Natural subtle breathing motion and gentle posture shift.',
      ``,
      `Preserve the subject's existing facial appearance,`,
      `head orientation,`,
      `hair silhouette,`,
      `body proportions,`,
      `wardrobe,`,
      `composition and environment.`,
      ``,
      cameraDesc,
    ].join('\n');
  }

  /**
   * Extract stable identity traits from character spec/description while omitting
   * conflicting outfit, scene, props or body proportion descriptors.
   */
  public static extractStableIdentityTraits(profile?: MinimalCharacterProfile): {
    identityTraits: string[];
    expressionRules: string[];
    motionRules: string[];
    forbiddenChanges: string[];
    stylePreferences: string[];
  } {
    if (!profile) {
      return {
        identityTraits: [],
        expressionRules: [],
        motionRules: [],
        forbiddenChanges: ['Do not change facial anatomy, eye color, or hair structure from the first frame image.'],
        stylePreferences: []
      };
    }

    const traits: string[] = [];
    const spec = profile.identitySpec;

    if (spec) {
      if (spec.faceShape) traits.push(`Face shape: ${spec.faceShape}`);
      if (spec.facialFeatures) traits.push(`Facial features: ${spec.facialFeatures}`);
      if (spec.eyeShapeAndColor) traits.push(`Eye color & shape: ${spec.eyeShapeAndColor}`);
      if (spec.hairColorLengthStyle) traits.push(`Hair style & color: ${spec.hairColorLengthStyle}`);
      if (spec.skinToneAndTexture) traits.push(`Skin tone: ${spec.skinToneAndTexture}`);
    } else if (profile.description) {
      // Fallback description parsing - filter out clothing or scene words
      const sentences = profile.description.split(/[,.，。]/).map(s => s.trim()).filter(Boolean);
      for (const sentence of sentences) {
        if (!/穿|装|服|衣|裤|鞋|背景|场景|拿|握|戴/.test(sentence)) {
          traits.push(sentence);
        }
      }
    }

    return {
      identityTraits: traits.length > 0 ? traits : ['Matching character facial anatomy'],
      expressionRules: spec?.defaultTemperament
        ? [`Default expression: ${spec.defaultTemperament}`, 'Focused natural gaze, no eye rolling or blank eye-whites']
        : ['Soft, natural expression', 'Focused natural gaze, no eye rolling or blank eye-whites'],
      motionRules: [
        'Keep motion natural with gentle respiration breathing, subtle chest micro-movement, and soft posture micro-shifts.',
        'Keep motion contained to head, face, shoulders, and minor hand movements.'
      ],
      forbiddenChanges: [
        'Do not modify face structure, eye color, or gender.',
        'Keep eye gaze focused and natural.',
        'Maintain natural skin tone and authentic portrait realism.',
        'Do not alter clothing or accessories from the first frame image.',
        'Do not add unrequested props or change background scene.'
      ],
      stylePreferences: []
    };
  }

  /**
   * Detect motion risks based on keywords, duration, and intensity
   */
  public static detectMotionRisks(userPrompt: string = '', durationSeconds: number, motionIntensity: MotionIntensity): MotionRiskResult {
    const safePrompt = typeof userPrompt === 'string' ? userPrompt : '';
    const promptLower = safePrompt.toLowerCase();
    const detected: string[] = [];
    const warnings: string[] = [];

    for (const keyword of this.HIGH_RISK_KEYWORDS) {
      if (safePrompt.includes(keyword) || promptLower.includes(keyword.toLowerCase())) {
        detected.push(keyword);
      }
    }

    if (detected.length > 0) {
      warnings.push(`检测到复杂动作词 [${detected.join(', ')}]，在 Veo 生成中可能引发身体扭曲或身份不一致。`);
    }

    if (durationSeconds === 4 && (motionIntensity === 'expressive' || detected.length > 0)) {
      warnings.push('4 秒生成建议设为 1 个主动作加微表情（如眨眼、微笑、轻微提头），复杂度过高增加渲染失真风险。');
    } else if (durationSeconds === 6 && detected.length > 1) {
      warnings.push('6 秒生成建议最多包含 2 个连续小动作。');
    } else if (durationSeconds === 8 && detected.length > 2) {
      warnings.push('8 秒生成建议最多包含 2~3 个连续动作。');
    }

    if (motionIntensity === 'expressive') {
      warnings.push('⚠️ expressive 动作档位包含较大姿态幅度，可能引发微小的视觉变异与身份漂移风险。');
    }

    return {
      detectedRiskKeywords: detected,
      warnings,
      hasHighRisk: detected.length > 0 || (durationSeconds === 4 && motionIntensity === 'expressive')
    };
  }

  /**
   * Deterministically normalizes compiled/raw prompts into a safe, concise English motion description for Veo 3.1.
   * Ensures adult person representation, retains original intent, removes negative prompt clutter, and prevents RAI filter triggers.
   */
  public static normalizeForVeo(
    compiledPrompt: string,
    rawUserPrompt: string,
    options?: { durationSeconds?: number; hasPerson?: boolean }
  ): string {
    const raw = (rawUserPrompt || '').trim();
    const compiled = (compiledPrompt || '').trim();
    const duration = options?.durationSeconds || 6;
    const hasPerson = options?.hasPerson !== false;

    // 1. Clean source string from negative tags, brackets, and sensitive words
    let source = compiled || raw;
    source = this.cleanUserMotionPrompt(source);

    // Remove negative prompt blocks
    source = source.replace(/Negative constraints:[\s\S]*/i, '').trim();

    // Clean out any remaining explicit/anatomical/violence keywords
    const explicitRegex = /\b(nude|naked|explicit|sexual|boobs|cleavage|bikini|lingerie|stripping|revealing|underwear|breast|chest|topless|sensual|erotic|gore|violent|blood|porn|nsfw|sexy)\b/gi;
    source = source.replace(explicitRegex, '');

    // Strip Chinese chars if present into clean English motion description
    let coreMotion = source;
    if (/[\u4e00-\u9fa5]/.test(source)) {
      coreMotion = source.replace(/[\u4e00-\u9fa5]+/g, 'natural motion').trim();
    }

    // Ensure adult person subject framing
    const subjectPrefix = hasPerson
      ? 'An adult person with natural posture, facial expression, and steady gaze.'
      : 'A natural subject scene in steady framing.';

    // Extract motion clause
    let motionClause = coreMotion && coreMotion.length > 5 ? coreMotion : 'Natural motion with smooth facial movement.';
    // Clean up redundant prefixes if present in motionClause
    motionClause = motionClause
      .replace(/^A realistic portrait video generated directly from the uploaded first frame image \(\d+ seconds\)\./i, '')
      .replace(/Maintain character facial consistency \([^)]*\)\. Lock original composition, framing, outfit, background environment, and posture\. Keep natural eye gaze and portrait realism\./i, '')
      .trim();

    if (!motionClause || motionClause.length < 5) {
      motionClause = 'Natural subtle facial motion and gentle posture shift.';
    }

    const safePrompt = `${subjectPrefix} ${motionClause} Duration: ${duration}s. Clear lighting, cinematic depth, and steady camera framing.`;

    // Final clean-up of extra double spaces or leftover negative tags
    return safePrompt.replace(/Negative constraints:.*$/gi, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Cleans raw prompt inputs by stripping negative prompt blocks, section brackets,
   * sensitive visual words (RAI safety filter triggers), and formatting tags to ensure
   * Veo model safety and natural motion quality.
   */
  public static cleanUserMotionPrompt(prompt: string): string {
    if (!prompt || typeof prompt !== 'string') return '';
    let cleaned = prompt;

    // Remove negative prompt sections like 【第X段 负向提示词】... or 负向提示词: ...
    cleaned = cleaned.replace(/(?:【[^】]*负向提示词[^】]*】|\[[^\]]*Negative Prompt[^\]]*\]|负向提示词[:：]|Negative prompt[:：])[\s\S]*/i, '');

    // Remove positive prompt headers like 【第X段 正向提示词】 or 【正向提示词】
    cleaned = cleaned.replace(/【[^】]*(?:正向|动作)?提示词[^】]*】/g, '');

    // Filter out sensitive visual terms that trigger Veo RAI Safety Filters
    const sensitiveTermsRegex = /性感|露骨|赤裸|裸露|诱惑|胸部|胸口|透视|下体|私密|剥开|解开衣|湿身|脱衣|死库水|比基尼|泳装|内衣|短裙|低胸|露肩|露背|erotic|nude|naked|explicit|sexual|boobs|cleavage|bikini|lingerie|stripping|revealing|underwear|breast|chest|topless|sensual/gi;
    cleaned = cleaned.replace(sensitiveTermsRegex, '自然大方姿态');

    // Remove problematic structural prompts or extreme action keywords
    cleaned = cleaned.replace(/18禁|成人|色情|血腥|暴力|打斗|杀戮|nsfw|porn|gore|violent|blood/gi, '');

    // Trim extra whitespace and trailing/leading quotes or brackets
    cleaned = cleaned.replace(/^[\s,，.。:：;；"'"'`“”]+|[\s,，.。:：;；"'"'`“”]+$/g, '').trim();

    return cleaned || '角色呈自然动态，眼神聚焦镜头，伴随呼吸与轻微动作。';
  }

  /**
   * Compile the prompt according to priority rules:
   * uploaded first-frame visual > current motion request > character identity traits > visual style preset > default constraints
   */
  public static compile(input: PromptCompilerInput): PromptCompilerOutput {
    const rawUserPrompt = typeof input.userMotionPrompt === 'string' ? input.userMotionPrompt.trim() : '';
    const sanitizedMotion = this.cleanUserMotionPrompt(rawUserPrompt);
    const durationSec = input.durationSeconds || 4;
    const intensity = input.motionIntensity || 'natural';

    // 1. Identity & Structural Invariant Constraints
    const extracted = this.extractStableIdentityTraits(input.characterProfile);
    const identityTraitsStr = extracted.identityTraits.join(', ');
    const identityConstraints = `Maintain character facial consistency (${identityTraitsStr}). Lock original composition, framing, outfit, background environment, and posture. Keep natural eye gaze and portrait realism.`;

    // 2. Motion Prompt by Duration & Vlog Motion Density
    let motionScopeDesc = '';
    if (durationSec <= 4) {
      if (intensity === 'minimal') {
        motionScopeDesc = '4-second video with 1 micro-motion: subtle eye blink, natural breathing, and light expression shift.';
      } else if (intensity === 'natural') {
        motionScopeDesc = '4-second video with 1 gentle main motion: slight head tilt, soft gaze shift toward camera.';
      } else {
        motionScopeDesc = '4-second video with 1 soft gesture, gentle smile transition, and natural breathing.';
      }
    } else if (durationSec <= 8) {
      if (intensity === 'minimal') {
        motionScopeDesc = '8-second video with 1-2 micro-motions: soft gaze adjustment and smooth eye blinking.';
      } else if (intensity === 'natural') {
        motionScopeDesc = '8-second video with 1-2 smooth micro-motions: gentle head turn and soft gaze returning to lens.';
      } else {
        motionScopeDesc = '8-second video with 2 controlled micro-motions: soft posture shift and expressive transition.';
      }
    } else {
      // 10s - 30s
      if (intensity === 'minimal') {
        motionScopeDesc = `${durationSec}-second video featuring subtle micro-expressions and soft gaze shifts.`;
      } else if (intensity === 'natural') {
        motionScopeDesc = `${durationSec}-second video featuring a smooth sequence of 2-3 gentle micro-actions.`;
      } else {
        motionScopeDesc = `${durationSec}-second video with a fluid sequence of soft posture adjustments and natural expressions.`;
      }
    }

    const motionPrompt = `${motionScopeDesc} Motion detail: ${sanitizedMotion || 'Natural portrait motion complying with original frame pose.'}`;

    // 3. Camera Constraints
    const cameraPreset = input.cameraPreset || 'locked_camera';
    let cameraConstraints = 'Locked camera, static framing, consistent lighting, smooth natural motion.';
    if (cameraPreset === 'slow_push') {
      cameraConstraints = 'Slow smooth camera push-in towards subject, steady framing, consistent lighting.';
    } else if (cameraPreset === 'slow_pull') {
      cameraConstraints = 'Slow smooth camera pull-back revealing surroundings, steady framing, consistent lighting.';
    } else if (cameraPreset === 'subtle_pan') {
      cameraConstraints = 'Gentle horizontal camera pan tracking across scene, stable lighting.';
    } else if (cameraPreset === 'vertical_boom') {
      cameraConstraints = 'Smooth vertical camera pedestal boom, maintaining steady subject alignment.';
    } else if (cameraPreset === 'subtle_orbit') {
      cameraConstraints = 'Gentle slow arc camera movement surrounding the subject, maintaining focus.';
    } else if (cameraPreset === 'tracking_shot') {
      cameraConstraints = 'Smooth parallel tracking camera motion, staying aligned with subject.';
    } else if (cameraPreset === 'close_up') {
      cameraConstraints = 'Tight portrait close-up framing, steady sharp focus on eyes.';
    }

    // 4. Style Prompt
    const visualStyle = input.visualStyle || 'photorealistic';
    let stylePrompt = 'High quality portrait photography style, clear eyes, natural lighting, cinematic mood.';
    if (visualStyle === 'cinematic') {
      stylePrompt = 'Cinematic film aesthetic, soft lens flare, professional volumetric lighting.';
    } else if (visualStyle === 'anime') {
      stylePrompt = 'Refined 2D anime animation style, crisp line work, soft shading, vibrant lighting.';
    }

    // 5. Negative Constraints
    const negativeConstraints = 'Avoid facial distortion, flickering, sudden identity changes, morphing limbs, unnatural camera shake.';

    // Combine into final compiled prompt
    const compiledPrompt = [
      `A realistic portrait video generated directly from the uploaded first frame image (${durationSec} seconds).`,
      identityConstraints,
      motionPrompt,
      cameraConstraints,
      stylePrompt,
      `Negative constraints: ${negativeConstraints}`
    ].join(' ');

    return {
      rawUserPrompt,
      identityConstraints,
      motionPrompt,
      cameraConstraints,
      stylePrompt,
      negativeConstraints,
      compiledPrompt,
      compilerVersion: this.VERSION
    };
  }
}
