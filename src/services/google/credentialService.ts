import { GoogleAuth } from 'google-auth-library';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
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

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for persistent experience
const CONNECTIONS_FILE_PATH = path.join(process.cwd(), 'data', 'connections.json');
const sessionsMap = new Map<string, ActiveSession>();

function saveConnectionsToDisk() {
  try {
    const dir = path.dirname(CONNECTIONS_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const list = Array.from(sessionsMap.values()).map((s) => ({
      connectionId: s.connectionId,
      type: s.type,
      credentialSource: s.credentialSource,
      apiKey: s.apiKey,
      serviceAccountJsonRaw: s.serviceAccountJsonRaw,
      projectId: s.projectId,
      location: s.location,
      region: s.region,
      requestedModel: s.requestedModel,
      actualModel: s.actualModel,
      analysisModel: s.analysisModel,
      imageModel: s.imageModel,
      videoModel: s.videoModel,
      serviceAccountEmail: s.serviceAccountEmail,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    }));
    fs.writeFileSync(CONNECTIONS_FILE_PATH, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Credential Disk Storage] Could not save connections to disk:', err);
  }
}

function loadConnectionsFromDisk() {
  try {
    if (!fs.existsSync(CONNECTIONS_FILE_PATH)) return;
    const content = fs.readFileSync(CONNECTIONS_FILE_PATH, 'utf-8');
    const list: any[] = JSON.parse(content);
    const now = Date.now();
    for (const item of list) {
      if (!item || !item.connectionId) continue;
      // Re-hydrate session if still valid or recently expired
      if (item.expiresAt > now - 12 * 3600 * 1000) {
        let jwtClient: any = undefined;
        if (item.type === 'vertex_ai') {
          try {
            if (item.serviceAccountJsonRaw) {
              const auth = new GoogleAuth();
              jwtClient = auth.fromJSON(JSON.parse(item.serviceAccountJsonRaw));
              jwtClient.scopes = ['https://www.googleapis.com/auth/cloud-platform'];
            } else {
              const auth = new GoogleAuth({
                scopes: ['https://www.googleapis.com/auth/cloud-platform'],
              });
              jwtClient = auth.getClient();
            }
          } catch (e) {
            console.warn(`[Credential Rehydrate] Warning rehydrating JWT for ${item.connectionId}:`, e);
          }
        }

        const restoredSession: ActiveSession = {
          connectionId: item.connectionId,
          type: item.type,
          credentialSource: item.credentialSource,
          apiKey: item.apiKey,
          serviceAccountJsonRaw: item.serviceAccountJsonRaw,
          serviceAccountJwt: jwtClient,
          projectId: item.projectId || 'xp-vertex-project',
          location: item.location || 'us-central1',
          region: item.region || item.location || 'us-central1',
          requestedModel: item.requestedModel || 'veo-3.1-fast-generate-001',
          actualModel: item.actualModel || 'veo-3.1-fast-generate-001',
          analysisModel: item.analysisModel || 'gemini-2.5-flash',
          imageModel: item.imageModel || 'gemini-2.5-flash',
          videoModel: item.videoModel || 'veo-3.1-fast-generate-001',
          serviceAccountEmail: item.serviceAccountEmail,
          createdAt: item.createdAt || now,
          expiresAt: Math.max(item.expiresAt || 0, now + SESSION_TTL_MS), // Auto extend on start
        };
        sessionsMap.set(item.connectionId, restoredSession);
      }
    }
    console.log(`[Credential Disk Storage] Successfully rehydrated ${sessionsMap.size} active connections from disk.`);
  } catch (err) {
    console.warn('[Credential Disk Storage] Could not load connections from disk:', err);
  }
}

// Initial load on module initialization
loadConnectionsFromDisk();

// Periodically clean up expired sessions
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, session] of sessionsMap.entries()) {
    if (session.expiresAt <= now) {
      sessionsMap.delete(id);
      changed = true;
    }
  }
  if (changed) {
    saveConnectionsToDisk();
  }
}, 5 * 60 * 1000);

export class CredentialService {
  static getSession(connectionId?: string): ActiveSession | undefined {
    const now = Date.now();
    if (connectionId) {
      const session = sessionsMap.get(connectionId);
      if (session && session.expiresAt > now) {
        return session;
      }
    }
    // Fallback: If requested connection ID is not found or empty, search for any valid active session
    for (const session of sessionsMap.values()) {
      if (session && session.expiresAt > now) {
        return session;
      }
    }
    return undefined;
  }

  static deleteSession(connectionId: string): boolean {
    const deleted = sessionsMap.delete(connectionId);
    if (deleted) {
      saveConnectionsToDisk();
    }
    return deleted;
  }

  static listSessions(): ActiveSession[] {
    const now = Date.now();
    const result: ActiveSession[] = [];
    for (const [id, s] of sessionsMap.entries()) {
      if (s.expiresAt > now) {
        result.push(s);
      } else {
        sessionsMap.delete(id);
      }
    }
    return result;
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

    // Verify key with minimal call
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
            model: (typeof options.analysisModel === 'string' && !options.analysisModel.includes('3.6')) ? options.analysisModel : 'gemini-2.5-flash',
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
      analysisModel: (typeof options.analysisModel === 'string' && !options.analysisModel.includes('3.6')) ? options.analysisModel : 'gemini-2.5-flash',
      imageModel: (typeof options.imageModel === 'string' && !options.imageModel.includes('3.1')) ? options.imageModel : 'gemini-2.5-flash',
      videoModel: requestedVideo,
      createdAt: now,
      expiresAt,
    };

    sessionsMap.set(connectionId, session);
    saveConnectionsToDisk();

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
    const projectId = (options.projectId || 'xp-vertex-project').trim();
    const location = (options.location || 'us-central1').trim();
    const requestedVideoModel = options.videoModel || 'veo-3.1-fast-generate-001';
    const actualVideoModel = 'veo-3.1-fast-generate-001';

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

      // Verify Service Account JWT & Fetch short-lived token
      try {
        const auth = new GoogleAuth();
        jwtClient = auth.fromJSON(parsedJson as any);
        jwtClient.scopes = ['https://www.googleapis.com/auth/cloud-platform'];
        await jwtClient.authorize();
        serviceAccountEmail = saData.client_email;
        credentialSource = 'SERVICE_ACCOUNT';
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`服务账号凭据授权验证失败: ${redactSecrets(msg)}`);
      }
    } else {
      // Attempt ADC Authentication
      try {
        const auth = new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        });
        jwtClient = await auth.getClient();
        await jwtClient.getAccessToken();
        serviceAccountEmail = 'adc-runtime-account@cloud.google';
        credentialSource = 'ADC';
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `未检测到 Application Default Credentials (ADC) 访问令牌，请在下方粘贴具有 Vertex AI 权限的服务账号 JSON 凭据。详情: ${redactSecrets(msg)}`
        );
      }
    }

    // Fetch OAuth2 Access Token for xp-vertex-project
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

    // Perform Zero-Cost Pre-Flight Routing Test using predictLongRunning with { "instances": [] }
    const routingTest = await VertexClient.testRouting(
      accessToken,
      projectId,
      location,
      actualVideoModel,
      serviceAccountEmail
    );

    if (routingTest.httpStatus === 403) {
      const summaryStr = typeof routingTest.rawErrorSummary === 'string' ? routingTest.rawErrorSummary : String(routingTest.rawErrorSummary || '');
      if (summaryStr.includes('has not been used') || summaryStr.includes('disabled')) {
        throw new Error(`Agent Platform / Vertex AI API (aiplatform.googleapis.com) 未在项目 ${projectId} 中启用，请在 GCP 控制台开启服务。`);
      }
      throw new Error(`服务账号缺乏调用 ${projectId} 模型的 IAM 权限: ${redactSecrets(routingTest.rawErrorSummary)}`);
    } else if (routingTest.httpStatus === 404) {
      throw new Error(`GCP 终端节点返回 404 NOT_FOUND (${projectId} / ${location}): ${redactSecrets(routingTest.rawErrorSummary)}`);
    }

    const connectionId = `conn_${crypto.randomUUID()}`;
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;

    const session: ActiveSession = {
      connectionId,
      type: 'vertex_ai',
      credentialSource,
      serviceAccountJsonRaw: jsonStr,
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
    saveConnectionsToDisk();

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

    const requestedVideo = options.videoModel || 'gemini-2.5-flash';

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
      analysisModel: (typeof options.analysisModel === 'string' && !options.analysisModel.includes('3.6')) ? options.analysisModel : 'gemini-2.5-flash',
      imageModel: (typeof options.imageModel === 'string' && !options.imageModel.includes('3.1')) ? options.imageModel : 'gemini-2.5-flash',
      videoModel: requestedVideo,
      createdAt: now,
      expiresAt,
    };

    sessionsMap.set(connectionId, session);
    saveConnectionsToDisk();

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

