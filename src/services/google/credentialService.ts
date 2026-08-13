import { GoogleAuth } from 'google-auth-library';
import { GoogleGenAI } from '@google/genai';
import { ServiceAccountJsonSchema, type ComputeConnectionInfo, type CredentialSourceType } from '../../types';
import { redactSecrets } from '../../utils/redactSecrets';
import { callWithRetry } from '../../utils/retryHelper';
import { VertexClient } from './vertexClient';

export interface ActiveSession {
  connectionId: string;
  type: 'vertex_ai' | 'gemini_api_key' | 'server_env_secret';
  credentialSource: CredentialSourceType;
  apiKey?: string;
  serviceAccountJsonRaw?: string;
  serviceAccountJwt?: any;
  projectId: string;
  location: string;
  region: string;
  requestedModel: string;
  actualModel: string;
  analysisModel: string;
  imageModel: string;
  videoModel: string;
  serviceAccountEmail?: string;
  createdAt: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const sessionsMap = new Map<string, ActiveSession>();

function isCloudRuntime(): boolean {
  return Boolean(
    process.env.K_SERVICE ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT_ID
  );
}

function getRuntimeProjectId(): string {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT_ID ||
    'xp-vertex-project'
  );
}

function getRuntimeLocation(): string {
  return (
    process.env.VERTEX_LOCATION ||
    process.env.GOOGLE_CLOUD_LOCATION ||
    process.env.GCP_REGION ||
    'us-central1'
  );
}

function getRuntimeVideoModel(): string {
  return process.env.VEO_MODEL_ID || 'veo-3.1-fast-generate-001';
}

function buildRuntimeAdcSession(connectionId?: string): ActiveSession | undefined {
  if (!isCloudRuntime()) return undefined;

  const now = Date.now();
  const projectId = getRuntimeProjectId();
  const location = getRuntimeLocation();
  const videoModel = getRuntimeVideoModel();
  const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });

  // Keep ADC client creation lazy. VertexClient already resolves promise-backed clients.
  const adcClientPromise = auth.getClient();

  return {
    connectionId: connectionId || 'runtime_adc',
    type: 'vertex_ai',
    credentialSource: 'ADC',
    serviceAccountJwt: adcClientPromise,
    projectId,
    location,
    region: location,
    requestedModel: videoModel,
    actualModel: videoModel,
    analysisModel: process.env.GEMINI_ANALYSIS_MODEL || 'gemini-2.5-flash',
    imageModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash',
    videoModel,
    serviceAccountEmail: process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL || 'adc-runtime-account@cloud.google',
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
}

// Periodically clean up only ephemeral in-memory sessions.
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessionsMap.entries()) {
    if (session.expiresAt <= now) {
      sessionsMap.delete(id);
    }
  }
}, 5 * 60 * 1000).unref?.();

export class CredentialService {
  static setSession(session: ActiveSession): void {
    sessionsMap.set(session.connectionId, session);
  }

  static getSession(connectionId?: string): ActiveSession | undefined {
    const now = Date.now();

    if (connectionId) {
      const session = sessionsMap.get(connectionId);
      if (session && session.expiresAt > now) {
        return session;
      }
    }

    // Preserve existing interactive behavior when another valid ephemeral session exists.
    for (const session of sessionsMap.values()) {
      if (session.expiresAt > now) {
        return session;
      }
    }

    // Production recovery path: Cloud Run must not depend on a process-local credential
    // session or local disk. Rebuild a Vertex session from Application Default
    // Credentials so a durable Firestore operationName can still be polled after restart.
    const runtimeSession = buildRuntimeAdcSession(connectionId);
    if (runtimeSession) {
      sessionsMap.set(runtimeSession.connectionId, runtimeSession);
      return runtimeSession;
    }

    // Developer API server secret can also be reconstructed without disk persistence.
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (apiKey) {
      const createdAt = Date.now();
      const requestedVideo = process.env.GEMINI_VIDEO_MODEL || 'gemini-2.5-flash';
      const session: ActiveSession = {
        connectionId: connectionId || 'runtime_server_secret',
        type: 'server_env_secret',
        credentialSource: 'SERVER_ENV_SECRET',
        apiKey,
        projectId: 'server-env-project',
        location: 'global',
        region: 'global',
        requestedModel: requestedVideo,
        actualModel: requestedVideo,
        analysisModel: process.env.GEMINI_ANALYSIS_MODEL || 'gemini-2.5-flash',
        imageModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash',
        videoModel: requestedVideo,
        createdAt,
        expiresAt: createdAt + SESSION_TTL_MS,
      };
      sessionsMap.set(session.connectionId, session);
      return session;
    }

    return undefined;
  }

  static deleteSession(connectionId: string): boolean {
    return sessionsMap.delete(connectionId);
  }

  static listSessions(): ActiveSession[] {
    const now = Date.now();
    const result: ActiveSession[] = [];
    for (const [id, session] of sessionsMap.entries()) {
      if (session.expiresAt > now) {
        result.push(session);
      } else {
        sessionsMap.delete(id);
      }
    }
    return result;
  }

  static clearEphemeralSessionsForTest(): void {
    sessionsMap.clear();
  }

  static hasServerEnvironmentSecret(): boolean {
    return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
  }

  static async connectWithApiKey(options: {
    apiKey: string;
    analysisModel?: string;
    imageModel?: string;
    videoModel?: string;
  }): Promise<ComputeConnectionInfo> {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error('API Key 不能为空');
    }

    const requestedVideo = options.videoModel || 'gemini-2.5-flash';

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      await callWithRetry(
        () =>
          ai.models.generateContent({
            model:
              typeof options.analysisModel === 'string' && !options.analysisModel.includes('3.6')
                ? options.analysisModel
                : 'gemini-2.5-flash',
            contents: 'ping',
          }),
        { actionName: '算力密钥连通性测试' }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Gemini API Key 校验失败: ${redactSecrets(msg)}`);
    }

    const connectionId = `conn_${crypto.randomUUID()}`;
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;

    const session: ActiveSession = {
      connectionId,
      type: 'gemini_api_key',
      credentialSource: 'GEMINI_API_KEY',
      apiKey,
      projectId: 'gemini-developer-api',
      location: 'global',
      region: 'global',
      requestedModel: requestedVideo,
      actualModel: requestedVideo,
      analysisModel:
        typeof options.analysisModel === 'string' && !options.analysisModel.includes('3.6')
          ? options.analysisModel
          : 'gemini-2.5-flash',
      imageModel:
        typeof options.imageModel === 'string' && !options.imageModel.includes('3.1')
          ? options.imageModel
          : 'gemini-2.5-flash',
      videoModel: requestedVideo,
      createdAt: now,
      expiresAt,
    };

    sessionsMap.set(connectionId, session);

    const maskedKey = `${apiKey.substring(0, 6)}...${apiKey.substring(apiKey.length - 4)}`;

    return {
      connectionId,
      type: 'gemini_api_key',
      credentialSource: 'GEMINI_API_KEY',
      projectId: session.projectId,
      location: session.location,
      region: session.region,
      requestedModel: session.requestedModel,
      actualModel: session.actualModel,
      analysisModel: session.analysisModel,
      imageModel: session.imageModel,
      videoModel: session.videoModel,
      apiKeyMasked: maskedKey,
      hasServerSecret: this.hasServerEnvironmentSecret(),
      createdAt: now,
      expiresAt,
    };
  }

  static async connectWithServiceAccount(options: {
    projectId?: string;
    location?: string;
    analysisModel?: string;
    imageModel?: string;
    videoModel?: string;
    serviceAccountJson?: string;
  }): Promise<ComputeConnectionInfo> {
    const jsonStr = (options.serviceAccountJson || '').trim();
    const projectId = (options.projectId || getRuntimeProjectId()).trim();
    const location = (options.location || getRuntimeLocation()).trim();
    const requestedVideoModel = options.videoModel || getRuntimeVideoModel();
    const actualVideoModel = getRuntimeVideoModel();

    let jwtClient: any;
    let credentialSource: CredentialSourceType = 'SERVICE_ACCOUNT';
    let serviceAccountEmail = '';

    if (jsonStr.length > 0) {
      if (jsonStr.length > 100 * 1024) {
        throw new Error('Service Account JSON 文件过大（不能超过 100KB）');
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(jsonStr);
      } catch {
        throw new Error('Service Account JSON 格式不正确');
      }

      const parseResult = ServiceAccountJsonSchema.safeParse(parsedJson);
      if (!parseResult.success) {
        throw new Error(
          'Service Account JSON 缺失关键字段或格式有误（需包含 type=service_account, project_id, client_email, private_key, token_uri）'
        );
      }

      const saData = parseResult.data;
      if (saData.type !== 'service_account') {
        throw new Error('凭据类型必须为 service_account');
      }
      if (saData.project_id !== projectId) {
        throw new Error(
          `表单 Project ID (${projectId}) 与 Service Account JSON 内 project_id (${saData.project_id}) 不一致`
        );
      }
      if (
        !saData.token_uri.startsWith('https://oauth2.googleapis.com/') &&
        !saData.token_uri.startsWith('https://www.googleapis.com/')
      ) {
        throw new Error('token_uri 必须为 Google 官方 OAuth Token 地址');
      }

      try {
        const auth = new GoogleAuth();
        jwtClient = auth.fromJSON(parsedJson as any);
        jwtClient.scopes = [CLOUD_PLATFORM_SCOPE];
        await jwtClient.authorize();
        serviceAccountEmail = saData.client_email;
        credentialSource = 'SERVICE_ACCOUNT';
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`服务账号凭据授权验证失败: ${redactSecrets(msg)}`);
      }
    } else {
      try {
        const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
        jwtClient = await auth.getClient();
        await jwtClient.getAccessToken();
        serviceAccountEmail = process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL || 'adc-runtime-account@cloud.google';
        credentialSource = 'ADC';
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `未检测到 Application Default Credentials (ADC) 访问令牌，请在 Cloud Run 配置具有 Vertex AI 权限的运行时服务账号。详情: ${redactSecrets(msg)}`
        );
      }
    }

    let accessToken: string;
    try {
      const tokenRes = await jwtClient.getAccessToken();
      accessToken = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token;
      if (!accessToken) {
        throw new Error(`无法为 ${projectId} 获取 OAuth2 Access Token`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`无法为 ${projectId} 获取 OAuth2 Access Token: ${redactSecrets(msg)}`);
    }

    const routingTest = await VertexClient.testRouting(
      accessToken,
      projectId,
      location,
      actualVideoModel,
      serviceAccountEmail
    );

    if (routingTest.httpStatus === 403) {
      const summaryStr =
        typeof routingTest.rawErrorSummary === 'string'
          ? routingTest.rawErrorSummary
          : String(routingTest.rawErrorSummary || '');
      if (summaryStr.includes('has not been used') || summaryStr.includes('disabled')) {
        throw new Error(
          `Agent Platform / Vertex AI API (aiplatform.googleapis.com) 未在项目 ${projectId} 中启用，请在 GCP 控制台开启服务。`
        );
      }
      throw new Error(
        `服务账号缺乏调用 ${projectId} 模型的 IAM 权限: ${redactSecrets(routingTest.rawErrorSummary)}`
      );
    }
    if (routingTest.httpStatus === 404) {
      throw new Error(
        `GCP 终端节点返回 404 NOT_FOUND (${projectId} / ${location}): ${redactSecrets(routingTest.rawErrorSummary)}`
      );
    }

    const connectionId = `conn_${crypto.randomUUID()}`;
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;

    const session: ActiveSession = {
      connectionId,
      type: 'vertex_ai',
      credentialSource,
      // User-provided JSON remains process-memory only. It is deliberately never persisted.
      serviceAccountJsonRaw: jsonStr || undefined,
      serviceAccountJwt: jwtClient,
      projectId,
      location,
      region: location,
      requestedModel: requestedVideoModel,
      actualModel: actualVideoModel,
      analysisModel: options.analysisModel || 'gemini-2.5-flash',
      imageModel: options.imageModel || 'gemini-2.5-flash',
      videoModel: actualVideoModel,
      serviceAccountEmail,
      createdAt: now,
      expiresAt,
    };

    sessionsMap.set(connectionId, session);

    return {
      connectionId,
      type: 'vertex_ai',
      credentialSource,
      projectId,
      location,
      region: location,
      requestedModel: requestedVideoModel,
      actualModel: actualVideoModel,
      analysisModel: session.analysisModel,
      imageModel: session.imageModel,
      videoModel: session.videoModel,
      serviceAccountEmail,
      hasServerSecret: this.hasServerEnvironmentSecret(),
      createdAt: now,
      expiresAt,
    };
  }

  static async connectWithServerSecret(options: {
    analysisModel?: string;
    imageModel?: string;
    videoModel?: string;
  }): Promise<ComputeConnectionInfo> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('服务端环境变量 GEMINI_API_KEY 未设置');
    }

    const requestedVideo = options.videoModel || process.env.GEMINI_VIDEO_MODEL || 'gemini-2.5-flash';
    const connectionId = `conn_${crypto.randomUUID()}`;
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;

    const session: ActiveSession = {
      connectionId,
      type: 'server_env_secret',
      credentialSource: 'SERVER_ENV_SECRET',
      apiKey,
      projectId: 'server-env-project',
      location: 'global',
      region: 'global',
      requestedModel: requestedVideo,
      actualModel: requestedVideo,
      analysisModel:
        typeof options.analysisModel === 'string' && !options.analysisModel.includes('3.6')
          ? options.analysisModel
          : 'gemini-2.5-flash',
      imageModel:
        typeof options.imageModel === 'string' && !options.imageModel.includes('3.1')
          ? options.imageModel
          : 'gemini-2.5-flash',
      videoModel: requestedVideo,
      createdAt: now,
      expiresAt,
    };

    sessionsMap.set(connectionId, session);

    return {
      connectionId,
      type: 'server_env_secret',
      credentialSource: 'SERVER_ENV_SECRET',
      projectId: session.projectId,
      location: session.location,
      region: session.region,
      requestedModel: session.requestedModel,
      actualModel: session.actualModel,
      analysisModel: session.analysisModel,
      imageModel: session.imageModel,
      videoModel: session.videoModel,
      apiKeyMasked: 'SERVER_ENV_SECRET',
      hasServerSecret: true,
      createdAt: now,
      expiresAt,
    };
  }
}
