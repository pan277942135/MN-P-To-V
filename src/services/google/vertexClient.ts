import sharp from 'sharp';
import { type ActiveSession } from './credentialService';
import { redactSecrets } from '../../utils/redactSecrets';
import { resolveVeoStorageUri, resolveVeoOutputBucket, assertProductionStorageConfig } from '../../server/storage/gcsArtifactStore';

export interface RoutingTestResult {
  httpStatus: number;
  googleErrorCode?: string | number;
  rawErrorSummary: string;
  principalEmail: string;
  projectId: string;
  region: string;
  modelId: string;
  endpoint: string;
  routeResolved: boolean;
}

export type VeoAspectRatio = '9:16' | '16:9';

export async function resolveAutoAspectRatio(imageBase64: string): Promise<VeoAspectRatio> {
  const imageBuffer = Buffer.from(imageBase64, 'base64');
  const metadata = await sharp(imageBuffer).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (width <= 0 || height <= 0) {
    throw new Error('无法读取首帧尺寸，无法自动确定视频方向');
  }
  return width > height ? '16:9' : '9:16';
}

export class VertexClient {
  static async getAccessToken(session: ActiveSession): Promise<string> {
    if (session.type !== 'vertex_ai' || !session.serviceAccountJwt) {
      throw new Error('非 Vertex AI 连接模式');
    }

    try {
      let client = session.serviceAccountJwt;
      if (client && typeof client.then === 'function') {
        client = await client;
      }
      const tokenRes = await client.getAccessToken();
      const token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token;
      if (!token) {
        throw new Error('无法获取 Access Token');
      }
      return token;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Vertex AI 刷新 Token 失败: ${redactSecrets(msg)}`);
    }
  }

  static async testRouting(
    accessToken: string,
    projectId: string,
    region = 'us-central1',
    modelId = 'veo-3.1-fast-generate-001',
    principalEmail = 'adc-runtime-account@cloud.google'
  ): Promise<RoutingTestResult> {
    const endpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelId}:predictLongRunning`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ instances: [] }),
    });

    const httpStatus = res.status;
    const resText = await res.text();
    let parsedJson: any = null;
    try {
      parsedJson = JSON.parse(resText);
    } catch {}

    const googleErrorCode = parsedJson?.error?.code || parsedJson?.error?.status || httpStatus;
    const rawErrorSummary = parsedJson?.error?.message || resText || `HTTP ${httpStatus}`;

    // 400 means route and model are resolved by Google Vertex AI!
    const routeResolved = httpStatus === 400;

    return {
      httpStatus,
      googleErrorCode,
      rawErrorSummary,
      principalEmail,
      projectId,
      region,
      modelId,
      endpoint,
      routeResolved,
    };
  }

  static async predictLongRunning(
    session: ActiveSession,
    payload: {
      prompt: string;
      imageBase64: string;
      mimeType: string;
      modelId?: string;
      durationSeconds?: number;
      taskId?: string;
      storageUri?: string;
    }
  ): Promise<{ operationName: string; endpoint: string }> {
    const accessToken = await this.getAccessToken(session);
    const projectId = session.projectId || 'xp-vertex-project';
    const region = session.region || session.location || 'us-central1';
    const modelId = payload.modelId || 'veo-3.1-fast-generate-001';
    const durationSeconds = payload.durationSeconds || 6;
    const aspectRatio = await resolveAutoAspectRatio(payload.imageBase64);

    const endpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelId}:predictLongRunning`;

    const storageConfig = assertProductionStorageConfig();
    if (!storageConfig.valid) {
      const isDrift = storageConfig.bucketDriftDetected;
      const failureReason = isDrift ? 'storage_configuration_drift' : 'storage_configuration_missing';
      const errMsg = isDrift
        ? `storage_configuration_drift: VEO_OUTPUT_BUCKET (${storageConfig.environmentBucket}) does not match expected production bucket (${storageConfig.expectedBucket})`
        : 'storage_configuration_missing: VEO_OUTPUT_BUCKET environment variable is missing';
      const err = new Error(errMsg);
      (err as any).source = 'internal_api';
      (err as any).failureStage = 'submit';
      (err as any).failureReason = failureReason;
      throw err;
    }

    const storageUri = payload.storageUri || resolveVeoStorageUri(payload.taskId || `task_${Date.now()}`);

    // AUTO aspect ratio: inherit the actual first-frame orientation.
    // Landscape -> 16:9; portrait or square -> 9:16.
    const body: Record<string, any> = {
      instances: [
        {
          prompt: payload.prompt,
          image: {
            bytesBase64Encoded: payload.imageBase64,
            mimeType: payload.mimeType,
          },
        },
      ],
      parameters: {
        sampleCount: 1,
        aspectRatio,
        durationSeconds,
        resolution: '1080p',
        personGeneration: 'allow_adult',
        generateAudio: false,
        storageUri,
      },
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`Veo predictLongRunning 请求失败 (HTTP ${res.status}): ${redactSecrets(errText)}`);
      (err as any).source = 'vertex_submit';
      (err as any).failureStage = 'submit';
      (err as any).httpStatus = res.status;
      throw err;
    }

    const data = await res.json();
    const operationName = data?.name;
    if (typeof operationName !== 'string' || !operationName.includes('/operations/')) {
      const err = new Error(`predictLongRunning 接口响应未返回有效的 operationName: ${JSON.stringify(data)}`);
      (err as any).source = 'vertex_submit';
      (err as any).failureStage = 'submit';
      (err as any).httpStatus = 500;
      throw err;
    }

    return { operationName, endpoint };
  }

  static async pollOperation(
    session: ActiveSession,
    operationName: string,
    modelId = 'veo-3.1-fast-generate-001'
  ): Promise<{ done: boolean; response?: any; error?: any }> {
    const accessToken = await this.getAccessToken(session);
    const projectId = session.projectId || 'xp-vertex-project';
    const region = session.region || session.location || 'us-central1';

    // Official fetchPredictOperation endpoint (POST only)
    const fetchEndpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelId}:fetchPredictOperation`;

    const pollPayload = { operationName };

    // Request payload assertion
    const payloadKeys = Object.keys(pollPayload);
    if (payloadKeys.length !== 1 || payloadKeys[0] !== 'operationName') {
      throw new Error('断言失败: pollPayload 键名必须严格包含且仅包含 ["operationName"]');
    }

    const opPrefix = typeof operationName === 'string' && operationName.length > 50
      ? `${operationName.slice(0, 50)}...`
      : String(operationName);

    console.log('[Vertex Polling Diagnostics]', JSON.stringify({
      endpointMethod: 'fetchPredictOperation',
      requestBodyKeys: payloadKeys,
      operationNamePrefix: opPrefix,
      K_REVISION: process.env.K_REVISION || null,
    }));

    const res = await fetch(fetchEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pollPayload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      let parsedError: any = null;
      try {
        parsedError = JSON.parse(errorText);
      } catch {}

      const googleStatus = parsedError?.error?.status || 'INVALID_ARGUMENT';
      const redactedText = redactSecrets(parsedError?.error?.message || errorText);
      const err = new Error(`fetchPredictOperation 轮询失败 (HTTP ${res.status}): ${redactedText}`);
      (err as any).source = 'vertex_polling';
      (err as any).failureStage = 'polling';
      (err as any).appHttpStatus = 500;
      (err as any).upstreamHttpStatus = res.status;
      (err as any).googleStatus = googleStatus;
      (err as any).actualModel = modelId;
      (err as any).endpointHost = `${region}-aiplatform.googleapis.com`;
      (err as any).endpointPathRedacted = `/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelId}:fetchPredictOperation`;
      throw err;
    }

    return await res.json();
  }
}
