import { redactSecrets } from './redactSecrets';

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
      const cleanMsg = redactSecrets(rawMsg);
      
      const is404 =
        errObj?.status === 404 ||
        errObj?.code === 404 ||
        rawMsg.includes('404') ||
        rawMsg.includes('not found') ||
        rawMsg.includes('NOT_FOUND') ||
        rawMsg.includes('is not found');

      if (is404) {
        throw err;
      }

      const is429 =
        errObj?.status === 429 ||
        errObj?.code === 429 ||
        errObj?.status === 'RESOURCE_EXHAUSTED' ||
        rawMsg.includes('429') ||
        rawMsg.includes('Resource exhausted') ||
        rawMsg.includes('RESOURCE_EXHAUSTED');

      const isTransient =
        is429 ||
        errObj?.status === 503 ||
        errObj?.code === 503 ||
        errObj?.status === 500 ||
        errObj?.code === 500 ||
        rawMsg.includes('Service Unavailable') ||
        rawMsg.includes('Internal error');

      if (isTransient && attempt <= maxRetries) {
        const reasonStr = is429 ? '配额限制/频率过高(429)' : '服务临时抖动';
        console.warn(
          `[Retry] ${actionName} 遇到${reasonStr}, 正在执行第 ${attempt}/${maxRetries} 次自动重试，等待 ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // 指数退避 3s -> 6s -> 12s
        continue;
      }

      if (is429) {
        throw new Error(
          `${actionName} 触发算力配额上限或并发限制 (429 RESOURCE_EXHAUSTED)。请求频率过高，建议等待 10-30 秒后重试，或在【算力设置】中检查并更换算力凭据。`
        );
      }

      throw err;
    }
  }
  throw new Error(`${actionName} 重试超过最大次数`);
}

