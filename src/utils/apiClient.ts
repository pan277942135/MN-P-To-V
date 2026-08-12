/**
 * Utility to safely fetch and parse API JSON responses, automatically retrying if the dev server is reloading.
 */

export async function safeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 2
): Promise<Response> {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const res = await fetch(input, init);
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        continue;
      }
      throw err;
    }
  }
  return fetch(input, init);
}

export async function parseJsonResponse<T = any>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');

  if (isJson) {
    try {
      const data = await res.json();
      if (!res.ok) {
        const errMsg = data.userMessage || data.error || `请求失败 (HTTP ${res.status})`;
        const err = new Error(errMsg);
        (err as any).structuredError = data;
        (err as any).httpStatus = res.status;
        throw err;
      }
      return data as T;
    } catch (e) {
      if (e instanceof Error && (e as any).structuredError) {
        throw e;
      }
      if (!res.ok) {
        throw new Error(`后端 API 请求失败 (HTTP ${res.status})`);
      }
      throw new Error(`解析服务器 JSON 响应失败 (HTTP ${res.status})`);
    }
  }

  // Attempt to read text response
  const text = await res.text();

  // Check if text is HTML (e.g. dev server index.html or proxy error page)
  const isHtml = text.startsWith('<!doctype') || text.startsWith('<html') || text.includes('<body') || text.toLowerCase().includes('<!doctype html>');
  if (isHtml) {
    if (!res.ok) {
      throw new Error(`后端 API 服务响应异常 (HTTP ${res.status}): 请检查服务端日志或网络连接`);
    }
    throw new Error(`后端 API 服务处理超时或断开连接 (HTTP ${res.status})。可能是算力生成任务超时或服务重载，请检查算力设置后重试。`);
  }

  if (!res.ok) {
    throw new Error(text || `请求失败 (HTTP ${res.status})`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`服务器响应不是有效 JSON (HTTP ${res.status}): ${text.slice(0, 80)}`);
  }
}

export async function safeFetchApi<T = any>(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 1
): Promise<{ res: Response; data: T }> {
  let attempt = 0;
  let lastErr: any = null;

  while (attempt <= retries) {
    try {
      const res = await safeFetch(input, init, 1);
      const data = await parseJsonResponse<T>(res);
      return { res, data };
    } catch (err) {
      lastErr = err;
      const rawMsg = err instanceof Error ? err.message : String(err || '');
      const msg = typeof rawMsg === 'string' ? rawMsg : String(rawMsg || '');
      
      // Never retry on explicit safety content blocks
      if (msg.includes('内容安全拦截')) {
        throw err;
      }

      const isTransient =
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('Failed to fetch') ||
        msg.includes('fetch failed') ||
        msg.includes('NetworkError') ||
        msg.includes('Load failed');

      if (isTransient && attempt < retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        continue;
      }
      break;
    }
  }

  if (lastErr) {
    const rawMsg = lastErr instanceof Error ? lastErr.message : String(lastErr || '');
    const msg = typeof rawMsg === 'string' ? rawMsg : String(rawMsg || '');
    if (msg.includes('Failed to fetch') || msg.includes('fetch failed') || msg.includes('NetworkError') || msg.includes('Load failed')) {
      throw new Error('后端 Node.js 服务 (端口 3000) 未响应或连接中断 (Failed to fetch)。请稍后重试或重新测试。');
    }
    throw lastErr;
  }

  throw new Error('网络请求异常');
}


