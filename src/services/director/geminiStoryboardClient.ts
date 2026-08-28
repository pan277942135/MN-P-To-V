import type { GeneratedStoryboardShot } from './localStoryboardGenerator';

export interface GeminiStoryboardRequest {
  title: string;
  creativeBrief: string;
  fullScript?: string;
  productionNotes?: string;
  targetDurationSeconds: number;
  targetFormat?: 'story_short' | 'vlog' | 'cosplay' | 'other';
}

export interface GeminiStoryboardResponse {
  ok: true;
  provider: 'vertex-gemini';
  model: string;
  generatedAt: number;
  shots: GeneratedStoryboardShot[];
}

export class GeminiStoryboardClientError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'GeminiStoryboardClientError';
    this.code = code;
    this.status = status;
  }
}

export async function generateGeminiStoryboard(
  input: GeminiStoryboardRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<GeminiStoryboardResponse> {
  const response = await fetchImpl('/api/director/storyboard/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Director-Generation-Intent': 'storyboard-v0.2.2',
    },
    body: JSON.stringify(input),
  });

  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new GeminiStoryboardClientError(
      'GEMINI_STORYBOARD_RESPONSE_INVALID',
      'Gemini 分镜接口返回了无法解析的响应。',
      response.status,
    );
  }

  if (!response.ok || !payload?.ok) {
    throw new GeminiStoryboardClientError(
      String(payload?.error || 'GEMINI_STORYBOARD_REQUEST_FAILED'),
      String(payload?.message || `Gemini 分镜接口请求失败（HTTP ${response.status}）。`),
      response.status,
    );
  }

  if (!Array.isArray(payload.shots) || payload.shots.length === 0) {
    throw new GeminiStoryboardClientError(
      'GEMINI_STORYBOARD_EMPTY',
      'Gemini 分镜接口没有返回 Shot List。',
      response.status,
    );
  }

  return payload as GeminiStoryboardResponse;
}
