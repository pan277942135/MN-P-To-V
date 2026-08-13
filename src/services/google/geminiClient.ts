import { GoogleGenAI } from '@google/genai';
import { CredentialService, type ActiveSession } from './credentialService';
import { VertexClient } from './vertexClient';
import { redactSecrets } from '../../utils/redactSecrets';

export class GeminiClientFactory {
  static async getClientForSession(session: ActiveSession): Promise<GoogleGenAI> {
    if (session.type === 'gemini_api_key' || session.type === 'server_env_secret') {
      const apiKey = session.apiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('连接已失效或缺失 API Key');
      }

      return new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
    }

    if (session.type === 'vertex_ai') {
      if (!session.serviceAccountJwt || !session.projectId) {
        throw new Error('连接已失效或缺失服务账号凭据');
      }

      // P0-5: all Vertex OAuth token resolution goes through VertexClient.
      // Runtime ADC reconstruction intentionally stores auth.getClient() as a Promise
      // so cold starts stay lazy; VertexClient.getAccessToken() knows how to await that
      // promise before invoking getAccessToken(). Directly calling the field here made
      // second/cold Cloud Run instances fail before reaching the durable idempotency gate.
      let accessToken: string;
      try {
        accessToken = await VertexClient.getAccessToken(session);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`服务账号 Token 刷新失败: ${redactSecrets(msg)}`);
      }

      // Initialize GoogleGenAI in Vertex AI mode
      const location = (session.location && session.location !== 'global') ? session.location : 'us-central1';
      return new GoogleGenAI({
        vertexai: true,
        project: session.projectId,
        location,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
            Authorization: `Bearer ${accessToken}`,
          },
        },
      });
    }

    throw new Error('未知连接类型');
  }

  static getClientByConnectionId(connectionId: string): Promise<GoogleGenAI> {
    const session = CredentialService.getSession(connectionId);
    if (!session) {
      throw new Error('连接已失效，请重新进行算力设置连接');
    }
    return this.getClientForSession(session);
  }
}
