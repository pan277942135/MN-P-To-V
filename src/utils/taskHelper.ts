import type { GenerationTask } from '../types';

export interface ExecutionTuningPayload {
  taskId: string;
  createdAtIso: string;
  executionTimeSeconds: number;
  sceneMode: string;
  modelId: string;
  inputs: {
    userPromptChinese: string;
    normalizedPromptEnglish: string;
    durationSeconds: number;
    aspectRatio: string;
    resolution: string;
    motionIntensity: string;
    cameraPreset: string;
    visualStyle: string;
    characterName?: string;
    characterId?: string;
    hasSceneImage: boolean;
  };
  outputs: {
    status: string;
    progressStage?: string;
    httpStatus?: number | null;
    errorCode?: string;
    messageChinese?: string;
    technicalMessageRedacted?: string;
    recommendedAction?: string;
    operationName?: string | null;
    videoUri?: string | null;
    outputUri?: string | null;
    projectId?: string | null;
    region?: string | null;
    qaScore?: number | null;
  };
}

export function buildExecutionTuningPayload(task: GenerationTask): ExecutionTuningPayload {
  const isFinished =
    task.status === 'completed' ||
    task.status === 'completed_with_warning' ||
    task.status === 'failed';
  const elapsedSec = isFinished
    ? Math.max(0, Math.floor(((task.updatedAt || Date.now()) - task.createdAt) / 1000))
    : Math.max(0, Math.floor((Date.now() - task.createdAt) / 1000));

  const err = task.error;
  let errMessageChinese = '生成中断';
  if (typeof err === 'string') {
    errMessageChinese = err;
  } else if (err && typeof err === 'object') {
    const rawMsg = err.messageChinese || err.userMessage || (err as any).message;
    if (typeof rawMsg === 'string') {
      errMessageChinese = rawMsg;
    } else if (rawMsg && typeof rawMsg === 'object') {
      errMessageChinese = (rawMsg as any).messageChinese || (rawMsg as any).message || JSON.stringify(rawMsg);
    } else if (typeof task.progressStage === 'string') {
      errMessageChinese = task.progressStage;
    }
  } else if (typeof task.progressStage === 'string') {
    errMessageChinese = task.progressStage;
  }

  const technicalMsg = typeof err === 'object' && err !== null 
    ? (typeof err.technicalMessageRedacted === 'string' ? err.technicalMessageRedacted : (err.technicalMessageRedacted ? JSON.stringify(err.technicalMessageRedacted) : undefined))
    : undefined;
  const httpStatus = typeof err === 'object' && err !== null && typeof err.httpStatus === 'number' ? err.httpStatus : null;
  const errorCode = typeof err === 'object' && err !== null && typeof err.code === 'string' ? err.code : (task.status === 'failed' ? 'ERR_FAILED' : 'OK');
  const recommendedAction = typeof err === 'object' && err !== null && typeof err.recommendedAction === 'string' ? err.recommendedAction : undefined;

  const hasVideoData = Boolean(
    task.resultVideoUrl ||
      task.videoResult?.blob ||
      (task as any).videoDataUrl
  );
  const isFailedOrHasError =
    task.status === 'failed' ||
    task.status === 'submit_failed_safe_to_retry' ||
    task.status === 'submission_outcome_unknown' ||
    task.status === 'orphaned_local_task' ||
    Boolean(task.error) ||
    (typeof task.progressStage === 'string' &&
      (task.progressStage.includes('失败') ||
        task.progressStage.includes('超时') ||
        task.progressStage.includes('中断')));

  let effectiveStatus = task.status;
  if (isFailedOrHasError || ((task.status === 'completed' || task.status === 'completed_with_warning') && !hasVideoData)) {
    effectiveStatus = 'failed';
  }

  const effectiveHttpStatus = effectiveStatus === 'failed' ? (httpStatus ?? 500) : (httpStatus ?? null);
  const effectiveErrorCode = effectiveStatus === 'failed' ? (errorCode === 'OK' ? 'SERVER_FAILED' : errorCode) : errorCode;

  return {
    taskId: task.id,
    createdAtIso: new Date(task.createdAt).toISOString(),
    executionTimeSeconds: elapsedSec,
    sceneMode: task.sceneMode || 'animate_existing_character',
    modelId: task.settings?.advancedModelConfig?.videoModel || 'veo-3.1-fast-generate-001',
    inputs: {
      userPromptChinese: task.userPromptChinese || (task as any).normalizedPromptChinese || '未填写',
      normalizedPromptEnglish: task.normalizedPromptEnglish || '未生成',
      durationSeconds: task.settings?.durationSeconds || 8,
      aspectRatio: task.settings?.aspectRatio || '9:16',
      resolution: task.settings?.resolution || '1080p',
      motionIntensity: (task as any).motionIntensity || 'natural',
      cameraPreset: (task as any).cameraPreset || 'locked_camera',
      visualStyle: task.settings?.primaryStyle || '照片级写实',
      characterName: task.characterName || '未关联',
      characterId: task.characterId || 'N/A',
      hasSceneImage: Boolean(task.sceneImageBlob || task.sceneImageUrl || task.sceneImageDataUrl),
    },
    outputs: {
      status: effectiveStatus,
      progressStage: task.progressStage,
      httpStatus: effectiveHttpStatus,
      errorCode: effectiveErrorCode,
      messageChinese: errMessageChinese,
      technicalMessageRedacted: technicalMsg,
      recommendedAction,
      operationName: task.externalOperationName || (task as any).operationName || null,
      videoUri: task.videoUri || (task as any).videoUri || null,
      outputUri: task.outputUri || (task as any).outputUri || null,
      projectId: task.projectId || (task as any).projectId || null,
      region: task.region || (task as any).region || null,
      qaScore: task.qaReport?.averageIdentityScore ?? null,
    },
  };
}

export function humanizeErrorMessage(input: unknown): string {
  if (!input) return '';
  let str = '';
  if (typeof input === 'string') {
    str = input;
  } else if (typeof input === 'object' && input !== null) {
    const obj = input as any;
    const candidate = obj.messageChinese || obj.userMessage || obj.message || obj.technicalMessageRedacted || obj.error;
    if (typeof candidate === 'string') {
      str = candidate;
    } else if (candidate && typeof candidate === 'object') {
      str = candidate.messageChinese || candidate.userMessage || candidate.message || candidate.technicalMessageRedacted || JSON.stringify(candidate);
    } else {
      str = JSON.stringify(input);
    }
  } else {
    str = String(input);
  }

  // Fast string check for known error patterns
  if (
    str.includes('violates Vertex AI') ||
    str.includes('usage guidelines') ||
    str.includes('safety policy') ||
    str.includes('Responsible AI') ||
    str.includes('sensitive words') ||
    str.includes('The prompt could not be submitted') ||
    str.includes('rephrasing the prompt') ||
    str.includes('Support codes')
  ) {
    return '输入图片或提示词触发 Google AI 安全策略与敏感词审查 (Responsible AI / Sensitive Content)。建议：请尝试调整提示词（避开敏感或露骨描述），或更换人物/场景图片后重试。';
  }

  if (
    str.includes('Veo 渲染完成，但响应中未找到视频 URI 或 Base64 数据') ||
    str.includes('未找到视频 URI 或 Base64 数据') ||
    str.includes('未找到视频 URI') ||
    str.includes('拉取视频文件流失败')
  ) {
    return 'Veo 算力渲染完成，但云端未返回有效的视频生成数据。建议：请点击【一键重试】重新发起渲染任务。';
  }

  if (
    str.includes('未检测到角色母板图') ||
    str.includes('请在角色库选择包含母板图的角色')
  ) {
    return '未检测到有效角色母板图。建议：请前往【角色库】选择或重新上传包含 3～8 张母板照片的角色，或在【创作工作台】重新上传场景图。';
  }

  if (typeof str !== 'string') {
    str = String(str || '');
  }

  // Extract embedded JSON object inside str if present (e.g. "生成失败: {\"code\":\"SERVER_ERROR\",...}")
  if (typeof str === 'string' && str.includes('{') && str.includes('}')) {
    const jsonMatch = str.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed === 'object' && parsed !== null) {
          const extracted =
            parsed.messageChinese ||
            parsed.userMessage ||
            parsed.message ||
            (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ||
            parsed.technicalMessageRedacted;
          if (typeof extracted === 'string' && extracted.trim()) {
            str = extracted;
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  // Check if str is stringified JSON e.g. {"code":3,"message":"..."} or {"messageChinese":"..."}
  let attempts = 0;
  while (typeof str === 'string' && str.trim().startsWith('{') && attempts < 3) {
    attempts++;
    try {
      const parsed = JSON.parse(str.trim());
      if (parsed && typeof parsed === 'object' && parsed !== null) {
        const found =
          parsed.messageChinese ||
          parsed.userMessage ||
          parsed.message ||
          (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ||
          parsed.technicalMessageRedacted;
        if (typeof found === 'string' && found.trim() !== '') {
          str = found;
        } else if (found && typeof found === 'object') {
          str = found.messageChinese || found.userMessage || found.message || JSON.stringify(found);
        } else {
          break;
        }
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  // Handle known Veo / Vertex AI / API errors
  if (
    str.includes('Unexpected token') ||
    str.includes('is not valid JSON') ||
    str.includes('upstream')
  ) {
    return '网络连接超时或算力代理响应异常。请稍后在【任务记录】页面点击【手动查询】。';
  }

  if (
    str.includes('Failed to fetch') ||
    str.includes('network error') ||
    str.includes('NetworkError') ||
    str.includes('ECONNRESET') ||
    str.includes('ETIMEDOUT')
  ) {
    return '网络连接中断，请稍后在【任务记录】页面点击【手动查询】。';
  }

  if (
    str.includes('Veo 渲染完成，但响应中未找到视频 URI 或 Base64 数据') ||
    str.includes('未找到视频 URI 或 Base64 数据') ||
    str.includes('未找到视频 URI') ||
    str.includes('拉取视频文件流失败')
  ) {
    return 'Veo 算力渲染完成，但云端未返回有效的视频生成数据。建议：请点击【一键重试】重新发起渲染任务。';
  }

  if (
    str.includes('violates Vertex AI') ||
    str.includes('usage guidelines') ||
    str.includes('safety policy') ||
    str.includes('Responsible AI') ||
    str.includes('sensitive words') ||
    str.includes('The prompt could not be submitted') ||
    str.includes('rephrasing the prompt') ||
    str.includes('Support codes') ||
    (str.includes('code') && str.includes('3') && str.includes('violates'))
  ) {
    return '输入图片或提示词触发 Google AI 安全策略与敏感词审查 (Responsible AI / Sensitive Content)。建议：请尝试调整提示词（避开敏感或露骨描述），或更换人物/场景图片后重试。';
  }

  if (
    str.includes('未检测到角色母板图') ||
    str.includes('请在角色库选择包含母板图的角色')
  ) {
    return '未检测到有效角色母板图。建议：请前往【角色库】选择或重新上传包含 3～8 张母板照片的角色，或在【创作工作台】重新上传场景图。';
  }

  if (str.includes('RESOURCE_EXHAUSTED') || str.includes('429') || str.includes('quota')) {
    return 'Google Vertex AI 云端算力配额不足或并发过高 (RESOURCE_EXHAUSTED)。建议：请等待 1-2 分钟后重新点击【一键重试】。';
  }

  if (str.includes('PERMISSION_DENIED') || str.includes('403')) {
    return 'GCP 算力凭据或服务账号权限不足 (PERMISSION_DENIED)。建议：前往【算力设置】重新校验并导入 Google Cloud 服务账号 JSON 凭据。';
  }

  if (str.includes('NOT_FOUND') || str.includes('404')) {
    return '云端 Veo 算力模型或 Endpoint 资源不可用 (NOT_FOUND)。建议：请检查算力设置中的 Region 区域是否支持 Veo。';
  }

  if (str.includes('DEADLINE_EXCEEDED') || str.includes('504')) {
    return '云端 Veo 算力渲染生成响应超时。建议：点击【一键重试】重新发起生成任务。';
  }

  return String(str).replace(/\\"/g, '"');
}

export function getExplicitTaskFailureReason(task: GenerationTask): {
  primaryReason: string;
  technicalDetails?: string;
  recommendedAction?: string;
  errorCode?: string;
} {
  const err = task.error;
  if (!err) {
    const stageStr = typeof task.progressStage === 'string' ? task.progressStage : '';
    const stageMsg = stageStr && (stageStr.includes('失败') || stageStr.includes('中断'))
      ? stageStr
      : '任务执行中断或被云端服务重置';
    return {
      primaryReason: stageMsg,
      recommendedAction: '可点击【一键重试】重新触发视频任务渲染',
      errorCode: 'ERR_UNKNOWN',
    };
  }

  if (typeof err === 'string') {
    const friendly = humanizeErrorMessage(err);
    return {
      primaryReason: friendly,
      recommendedAction: friendly.includes('建议') ? '请按上述建议调整后点击重试' : '请检查提示词与算力网络连接后尝试重试',
      errorCode: 'ERR_FAILED',
    };
  }

  const rawTech = typeof err.technicalMessageRedacted === 'string' 
    ? err.technicalMessageRedacted 
    : (err.technicalMessageRedacted ? (typeof err.technicalMessageRedacted === 'object' ? JSON.stringify(err.technicalMessageRedacted) : String(err.technicalMessageRedacted)) : '');

  const userMsgRaw = err.messageChinese || err.userMessage || (err as any).message;
  const rawUserMsg = typeof userMsgRaw === 'string' 
    ? userMsgRaw 
    : (userMsgRaw ? (typeof userMsgRaw === 'object' ? JSON.stringify(userMsgRaw) : String(userMsgRaw)) : '');

  const friendlyUserMsg = humanizeErrorMessage(rawUserMsg || err);
  const friendlyTech = humanizeErrorMessage(rawTech || err);

  const recAction = typeof err.recommendedAction === 'string' 
    ? err.recommendedAction 
    : (err.recommendedAction ? String(err.recommendedAction) : '');

  const code = typeof err.code === 'string' ? err.code : 'ERR_VEO_GEN';

  const isGenericUserMsg = Boolean(friendlyUserMsg) && (
    friendlyUserMsg.includes('请打开技术诊断') ||
    friendlyUserMsg.includes('未知错误') ||
    friendlyUserMsg === '生成失败' ||
    friendlyUserMsg === '启动视频生成任务失败'
  );

  let primaryReason = friendlyUserMsg;
  if (!primaryReason || isGenericUserMsg) {
    if (friendlyTech && !friendlyTech.includes('未知错误')) {
      primaryReason = friendlyTech;
    } else {
      primaryReason = friendlyUserMsg || '视频生成任务中断';
    }
  }

  const isVeoNoDataErr =
    (friendlyUserMsg && (friendlyUserMsg.includes('Veo 渲染完成') || friendlyUserMsg.includes('未找到视频 URI'))) ||
    (friendlyTech && (friendlyTech.includes('Veo 渲染完成') || friendlyTech.includes('未找到视频 URI'))) ||
    code === 'VEO_DATA_EMPTY';

  let finalRecAction = typeof recAction === 'string' && recAction ? recAction : '在下方点击【一键重试】';
  if (isVeoNoDataErr || (recAction && recAction.includes('算力连接') && !friendlyUserMsg.includes('凭据') && !friendlyUserMsg.includes('PERMISSION_DENIED'))) {
    finalRecAction = '在下方点击【一键重试】重新发起渲染任务（算力连接正常，无需重新配置）';
  }

  return {
    primaryReason: typeof primaryReason === 'string' ? primaryReason : String(primaryReason || '视频生成任务中断'),
    technicalDetails: (friendlyTech && friendlyTech !== primaryReason && typeof friendlyTech === 'string') ? friendlyTech : undefined,
    recommendedAction: finalRecAction,
    errorCode: typeof code === 'string' ? code : 'ERR_VEO_GEN',
  };
}

export function formatExecutionParamsText(task: GenerationTask): string {
  const p = buildExecutionTuningPayload(task);
  return `=== 接口与执行参数 (Zaojing Veo Task Tuning Payload) ===
【任务 ID】: ${p.taskId}
【创建时间】: ${p.createdAtIso}
【执行用时】: ${p.executionTimeSeconds} 秒
【场景模式】: ${p.sceneMode}
【基座模型】: ${p.modelId}

[调整用入参 (Inputs)]
- 中文动作指令: ${p.inputs.userPromptChinese}
- 英文 Prompt: ${p.inputs.normalizedPromptEnglish}
- 视频时长: ${p.inputs.durationSeconds} 秒
- 画幅比例: ${p.inputs.aspectRatio}
- 画质分辨率: ${p.inputs.resolution}
- 动作幅度: ${p.inputs.motionIntensity}
- 镜位预设: ${p.inputs.cameraPreset}
- 视觉风格: ${p.inputs.visualStyle}
- 包含首帧图: ${p.inputs.hasSceneImage ? '是' : '否'}
- 绑定角色: ${p.inputs.characterName} (${p.inputs.characterId})

[调整用出参 (Outputs)]
- 执行状态: ${p.outputs.status}
- 响应阶段: ${p.outputs.progressStage || 'N/A'}
- HTTP Status: ${p.outputs.httpStatus ?? 'N/A'}
- 错误代码: ${p.outputs.errorCode ?? 'N/A'}
- 报错描述: ${p.outputs.messageChinese}
- 技术明细: ${p.outputs.technicalMessageRedacted || '无'}
- 推荐解法: ${p.outputs.recommendedAction || '无'}
- OperationName: ${p.outputs.operationName || '无'}

=== JSON Raw Payload ===
${JSON.stringify(p, null, 2)}`;
}

export async function copyExecutionParamsToClipboard(task: GenerationTask): Promise<boolean> {
  try {
    const text = formatExecutionParamsText(task);
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error('Failed to copy execution params:', err);
    return false;
  }
}
