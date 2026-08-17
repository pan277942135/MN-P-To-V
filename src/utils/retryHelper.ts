import { redactSecrets } from './redactSecrets';

function toNumericStatus(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function getNumericStatuses(errObj: any): number[] {
  return [
    errObj?.status,
    errObj?.code,
    errObj?.httpStatus,
    errObj?.upstreamHttpStatus,
    errObj?.appHttpStatus,
  ]
    .map(toNumericStatus)
    .filter((status): status is number => status !== null);
}

export function isRateLimitError(err: unknown): boolean {
  const errObj = err as any;
  const rawMsg = typeof errObj?.message === 'string' ? errObj.message : String(err || '');
  const lowerMsg = rawMsg.toLowerCase();
  const googleStatus = String(errObj?.googleStatus || errObj?.status || '').toUpperCase();

  return (
    getNumericStatuses(errObj).includes(429) ||
    googleStatus === 'RESOURCE_EXHAUSTED' ||
    lowerMsg.includes('resource_exhausted') ||
    lowerMsg.includes('resource exhausted') ||
    lowerMsg.includes('rate exceeded') ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('rate-limit') ||
    lowerMsg.includes('rate limited') ||
    lowerMsg.includes('too many requests') ||
    lowerMsg.includes('quota exceeded')
  );
}

export async function callWithRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; initialDelayMs?: number; actionName?: string } = {}
): Promise<T> {
  const { maxRetries = 3, initialDelayMs = 3000, actionName = 'API 调用' } = options;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const errObj = err as any;
      const rawMsg = typeof errObj?.message === 'string' ? errObj.message : String(err || '');
      const lowerMsg = rawMsg.toLowerCase();
      const cleanMsg = redactSecrets(rawMsg);
      const statuses = getNumericStatuses(errObj);

      const is404 =
        statuses.includes(404) ||
        lowerMsg.includes('404') ||
        lowerMsg.includes('not found') ||
        lowerMsg.includes('is not found');

      if (is404) {
        throw err;
      }

      const is429 = isRateLimitError(err);
      const isTransient =
        is429 ||
        statuses.some((status) => [500, 502, 503, 504].includes(status)) ||
        lowerMsg.includes('service unavailable') ||
        lowerMsg.includes('temporarily unavailable') ||
        lowerMsg.includes('internal error');

      if (isTransient && attempt <= maxRetries) {
        const reasonStr = is429 ? '配额/频率/容量限制(429)' : '服务临时抖动';
        console.warn(
          `[Retry] ${actionName} 遇到${reasonStr}, 正在执行第 ${attempt}/${maxRetries} 次自动重试，等待 ${delay}ms... (${cleanMsg})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // 指数退避 3s -> 6s -> 12s
        continue;
      }

      if (is429) {
        const upstreamHttpStatus =
          toNumericStatus(errObj?.upstreamHttpStatus) ??
          toNumericStatus(errObj?.httpStatus) ??
          toNumericStatus(errObj?.status) ??
          toNumericStatus(errObj?.code) ??
          null;

        const rateLimitError = new Error(
          `${actionName} 触发上游请求频率、配额或共享容量限制 (429 RESOURCE_EXHAUSTED / Rate exceeded)。系统已完成有限指数退避重试仍未恢复，请稍后再试或检查当前 GCP 项目的 Vertex AI 配额与容量。`
        );
        Object.assign(rateLimitError, {
          source: errObj?.source || 'vertex_submit',
          failureStage: errObj?.failureStage || 'submit',
          // Application semantic status is 429. Preserve the provider's original
          // HTTP status separately when it was available (some capacity paths can
          // surface a different upstream status while still meaning rate-limited).
          httpStatus: 429,
          upstreamHttpStatus,
          googleStatus: errObj?.googleStatus || 'RESOURCE_EXHAUSTED',
          failureReason: 'quota_or_rate_limited',
          retryMode: 'SAFE_TO_REGENERATE',
        });
        throw rateLimitError;
      }

      throw err;
    }
  }
  throw new Error(`${actionName} 重试超过最大次数`);
}
