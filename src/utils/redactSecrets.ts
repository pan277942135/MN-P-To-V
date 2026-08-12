/**
 * Utility to redact all sensitive secrets from strings, error messages, objects, and logs.
 * Cleans out:
 * - API Keys (AIza..., generic long base64/hex strings)
 * - Private Keys (-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----)
 * - OAuth Tokens (ya29..., Bearer tokens)
 * - Client Secret / Private Key JSON fields
 * - Authorization Headers
 * - Service Account Emails
 */

export function redactSecrets(input: unknown): string {
  if (input === null || input === undefined) {
    return '';
  }

  let text = typeof input === 'string' ? input : JSON.stringify(input, null, 2);

  if (!text) return '';

  // Redact RSA/PEM Private Keys
  text = text.replace(
    /-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA )?PRIVATE KEY-----/gi,
    '[REDACTED_PRIVATE_KEY]'
  );

  // Redact raw private_key JSON string fields
  text = text.replace(
    /"private_key"\s*:\s*"[^"]*"/gi,
    '"private_key": "[REDACTED_PRIVATE_KEY]"'
  );

  // Redact Google API Keys (AIzaSy...)
  text = text.replace(/AIzaSy[A-Za-z0-9_-]{33}/g, '[REDACTED_API_KEY]');

  // Redact Google OAuth Access Tokens (ya29...)
  text = text.replace(/ya29\.[A-Za-z0-9_-]+/g, '[REDACTED_OAUTH_TOKEN]');

  // Redact Bearer Headers
  text = text.replace(/Bearer\s+[A-Za-z0-9._\--]+/gi, 'Bearer [REDACTED_TOKEN]');

  // Redact Authorization headers
  text = text.replace(/("?authorization"?\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');

  // Redact x-goog-api-key headers
  text = text.replace(/("?x-goog-api-key"?\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');

  // Redact service account email partially
  text = text.replace(
    /([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com)/gi,
    'sa-***@$2'
  );

  return text;
}

export function sanitizeError(err: unknown, defaultMessage = '系统发生内部错误') {
  const rawMessage = err instanceof Error ? err.message : String(err);
  let redacted = redactSecrets(rawMessage);

  if (
    redacted.startsWith('🚫 内容安全拦截') ||
    redacted.startsWith('Google Cloud Vertex AI 算力项目预算支出已达上限') ||
    redacted.startsWith('Gemini API / Vertex AI 算力请求配额')
  ) {
    return {
      rawMessage,
      redactedMessage: redacted,
    };
  }

  const upper = redacted.toUpperCase();
  const lower = redacted.toLowerCase();

  // Check for sexually explicit / adult / pornography policy violations
  const isSexual =
    upper.includes('SEXUALLY_EXPLICIT') ||
    upper.includes('HARM_CATEGORY_SEXUALLY_EXPLICIT') ||
    upper.includes('EXPLICIT') ||
    upper.includes('NSFW') ||
    upper.includes('PORN') ||
    upper.includes('NUDITY') ||
    lower.includes('porn') ||
    lower.includes('sexually') ||
    lower.includes('adult content') ||
    redacted.includes('色情') ||
    redacted.includes('裸露') ||
    redacted.includes('不雅') ||
    redacted.includes('淫秽') ||
    redacted.includes('涉黄');

  // Check for violence / blood / aggression policy violations
  const isViolence =
    upper.includes('VIOLENCE') ||
    upper.includes('VIOLENT') ||
    upper.includes('HARM_CATEGORY_VIOLENCE') ||
    upper.includes('HARM_CATEGORY_DANGEROUS_CONTENT') ||
    lower.includes('bloody') ||
    lower.includes('gore') ||
    lower.includes('weapon') ||
    redacted.includes('暴力') ||
    redacted.includes('血腥') ||
    redacted.includes('危险行为') ||
    redacted.includes('打斗') ||
    redacted.includes('杀戮');

  // Check for general safety / RAI / moderation policy blocks
  const isGeneralSafety =
    upper.includes('SAFETY') ||
    upper.includes('PROMPT_BLOCKED') ||
    upper.includes('BLOCK_REASON') ||
    upper.includes('RAI_') ||
    upper.includes('RESPONSIBLE_AI') ||
    upper.includes('HARM_CATEGORY') ||
    upper.includes('IMAGE_SAFETY') ||
    lower.includes('policy violation') ||
    lower.includes('content policy') ||
    lower.includes('safety policy') ||
    lower.includes('safety check') ||
    lower.includes('safety filter') ||
    lower.includes('blocked for safety') ||
    lower.includes('blocked due to safety') ||
    lower.includes('inappropriate content') ||
    lower.includes('moderation') ||
    redacted.includes('安全拦截') ||
    redacted.includes('违规内容');

  if (isSexual) {
    redacted = `🚫 内容安全拦截：生成已被大模型拒绝。检测到输入的提示词或参考图片可能包含涉及色情、裸露或不雅敏感内容，触发了内容安全保护规则。请修改提示词或更换图片后重新尝试。`;
  } else if (isViolence) {
    redacted = `🚫 内容安全拦截：生成已被大模型拒绝。检测到输入的提示词或参考图片可能包含涉及暴力、血腥或危险攻击行为，触发了内容安全保护规则。请修改提示词或更换图片后重新尝试。`;
  } else if (isGeneralSafety) {
    redacted = `🚫 内容安全拦截：生成未能通过大模型的合规审核（可能涉及暴力、色情、敏感或违规内容）。请调整提示词或更换参考图片后再试。`;
  } else if (redacted.includes('Spend cap breached') || redacted.includes('BILLING_DISABLED') || redacted.includes('billing account') || redacted.includes('spending limit')) {
    redacted = `Google Cloud Vertex AI 算力项目预算支出已达上限或结算账户未启用 (Spend cap breached / Billing disabled)。请在 GCP 控制台检查预算上限与结算设置，或在【算力连接与凭据设置】中切换为 Gemini API Key 算力模式。 (详细错误: ${redacted})`;
  } else if (redacted.includes('RESOURCE_EXHAUSTED') || redacted.includes('Quota exceeded') || redacted.includes('25000000')) {
    redacted = `Gemini API / Vertex AI 算力请求配额或 Token 限制已用尽 (Quota Exceeded)。请稍后重试，或在【算力连接与凭据设置】中更换有效的 API Key 或 GCP 项目。 (详细错误: ${redacted})`;
  } else if (redacted.includes('aiplatform.endpoints.predict') || (redacted.includes('denied') && redacted.includes('aiplatform'))) {
    redacted = `服务账号缺乏调用 GCP Vertex AI 模型的 IAM 权限 (aiplatform.endpoints.predict)。请在 GCP IAM 控制台为该服务账号添加 [Vertex AI User] 或 [Agent Platform User] 角色。注意：GCP 权限变动通常需要 2-5 分钟生效。 (详细错误: ${redacted})`;
  }

  return {
    rawMessage,
    redactedMessage: redacted || defaultMessage,
  };
}

export function createStructuredError(opts: {
  source?: 'vertex_submit' | 'vertex_polling' | 'output_download' | 'artifact_persist' | 'character_api' | 'internal_api' | 'authentication' | 'unknown';
  failureStage?: 'submit' | 'polling' | 'output_download' | 'artifact_persist' | 'internal_api';
  httpStatus?: number | null;
  appHttpStatus?: number | null;
  upstreamHttpStatus?: number | null;
  googleStatus?: string | null;
  googleReason?: string | null;
  rawError?: unknown;
  endpointHost?: string | null;
  endpointPathRedacted?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  taskId?: string | null;
  customUserMessage?: string;
  actualModel?: string;
  projectId?: string;
  region?: string;
}) {
  const source = opts.source || (opts.rawError as any)?.source || 'unknown';
  const failureStage =
    opts.failureStage ||
    (opts.rawError as any)?.failureStage ||
    (source === 'vertex_polling'
      ? 'polling'
      : source === 'output_download'
      ? 'output_download'
      : source === 'character_api' || source === 'internal_api'
      ? 'internal_api'
      : 'submit');

  const rawUpstreamStatus = opts.upstreamHttpStatus ?? (opts.rawError as any)?.upstreamHttpStatus ?? (opts.rawError as any)?.httpStatus;
  const upstreamHttpStatus = rawUpstreamStatus ? Number(rawUpstreamStatus) : null;
  const appHttpStatus = opts.appHttpStatus ?? opts.httpStatus ?? 500;
  const httpStatus = appHttpStatus;

  const { redactedMessage } = sanitizeError(opts.rawError);
  const redactedMsgStr = typeof redactedMessage === 'string' ? redactedMessage : '';

  const googleStatus = opts.googleStatus || (opts.rawError as any)?.googleStatus || null;
  const googleReason = opts.googleReason || (opts.rawError as any)?.googleReason || null;

  let userMessage = opts.customUserMessage;
  if (!userMessage) {
    if (
      redactedMsgStr &&
      (redactedMsgStr.startsWith('🚫') ||
       redactedMsgStr.includes('支出已达上限') ||
       redactedMsgStr.includes('配额') ||
       redactedMsgStr.includes('权限') ||
       redactedMsgStr.includes('超时'))
    ) {
      userMessage = redactedMsgStr;
    } else if (source === 'authentication' || httpStatus === 401 || httpStatus === 403) {
      userMessage = `当前运行身份未获得 Vertex AI 调用权限: ${redactedMsgStr || '请检查 IAM 服务账号角色配置'}`;
    } else if (
      source === 'vertex_submit' &&
      (upstreamHttpStatus === 404 || httpStatus === 404) &&
      (googleStatus === 'NOT_FOUND' || redactedMsgStr.includes('NOT_FOUND')) &&
      redactedMsgStr.includes('publishers/google/models')
    ) {
      userMessage = `当前模型或区域配置无法解析 (404): ${redactedMsgStr}`;
    } else if (source === 'vertex_polling') {
      userMessage = `云端任务查询进度异常: ${redactedMessage || '视频任务已提交，但轮询状态响应异常'}`;
    } else if (source === 'character_api') {
      userMessage = `虚拟角色接口数据异常: ${redactedMessage || '角色资料不存在或已被删除'}`;
    } else if (source === 'internal_api') {
      userMessage = `服务接口调用异常: ${redactedMessage || '应用服务接口不存在或部署版本不匹配'}`;
    } else if (source === 'output_download') {
      userMessage = `生成结果视频数据读取失败: ${redactedMessage || '视频任务可能已完成，但输出数据暂不可读'}`;
    } else {
      userMessage = redactedMessage ? redactedMessage : '视频生成失败，未能获取具体错误诊断';
    }
  }

  const revision = process.env.K_REVISION || null;

  return {
    errorId: `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    source,
    failureStage,
    httpStatus,
    appHttpStatus,
    upstreamHttpStatus,
    googleStatus,
    googleReason,
    technicalMessageRedacted: redactedMessage || '未知错误',
    userMessage,
    endpointHost: opts.endpointHost || (source.startsWith('vertex') ? 'aiplatform.googleapis.com' : null),
    endpointPathRedacted: opts.endpointPathRedacted || null,
    requestId: opts.requestId || null,
    traceId: opts.traceId || null,
    taskId: opts.taskId || null,
    revision,
    buildVersion: '6.0.0-v6.0-cinema',
    actualModel: opts.actualModel || 'veo-3.1-fast-generate-001',
    projectId: opts.projectId || 'xp-vertex-project',
    region: opts.region || 'us-central1',
    error: userMessage,
  };
}
