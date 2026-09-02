import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AI_DIRECTOR_SCOPES,
  type AiDirectorScope,
  type DirectorAiTokenPublic,
  type DirectorAiTokenRecord,
} from '../../../services/aiDirector/aiDirectorTypes';
import {
  directorAiTokenRepository,
  type DirectorAiTokenRepositoryLike,
} from '../../repositories/directorAiTokenRepository';
import { projectBindingService } from '../projectBindingService';

export interface AiProjectBindingResolverLike {
  resolveBinding(bindingCode: string): Promise<string | null>;
}

export interface CreateAiTokenInput {
  projectId: string;
  name: string;
  scope: AiDirectorScope[];
  expiresAt?: string;
}

export interface CreatedAiToken extends DirectorAiTokenPublic {
  token: string;
}

export class AiTokenServiceError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'AiTokenServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function scopes(value: unknown): AiDirectorScope[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(clean)
    .filter((item): item is AiDirectorScope => AI_DIRECTOR_SCOPES.includes(item as AiDirectorScope)))];
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function generatedToken(): string {
  return `ZJ-AI-${randomBytes(24).toString('base64url')}`;
}

function publicToken(record: DirectorAiTokenRecord): DirectorAiTokenPublic {
  return {
    tokenId: record.tokenId,
    projectId: record.projectId,
    name: record.name,
    scope: [...record.scope],
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function validExpiry(value: unknown, now: number): string {
  const raw = clean(value);
  if (!raw) return '';
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new AiTokenServiceError('AI_TOKEN_EXPIRY_INVALID', 'expiresAt 必须是有效的 ISO 日期。', 400);
  }
  if (parsed <= now) {
    throw new AiTokenServiceError('AI_TOKEN_EXPIRY_IN_PAST', 'expiresAt 必须晚于当前时间。', 400);
  }
  return new Date(parsed).toISOString();
}

export class AiTokenService {
  constructor(
    private readonly repository: DirectorAiTokenRepositoryLike = directorAiTokenRepository,
    private readonly bindingResolver: AiProjectBindingResolverLike = projectBindingService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public isAvailable(): boolean {
    return this.repository.isAvailable();
  }

  public async authorizeProject(projectIdInput: string, bindingCodeInput: string): Promise<void> {
    const projectId = clean(projectIdInput);
    const bindingCode = clean(bindingCodeInput);
    if (!projectId) {
      throw new AiTokenServiceError('AI_PROJECT_ID_REQUIRED', 'projectId 不能为空。', 400);
    }
    if (!bindingCode) {
      throw new AiTokenServiceError('AI_MANAGEMENT_BINDING_REQUIRED', 'AI Token 管理需要 X-Director-Binding-Code。', 401);
    }

    let resolvedProjectId: string | null = null;
    try {
      resolvedProjectId = await this.bindingResolver.resolveBinding(bindingCode);
    } catch {
      // Binding validation details must not become a token-management oracle.
      throw new AiTokenServiceError('AI_MANAGEMENT_UNAUTHORIZED', '绑定码无效或已失效。', 401);
    }
    if (!resolvedProjectId) {
      throw new AiTokenServiceError('AI_MANAGEMENT_UNAUTHORIZED', '绑定码无效或已失效。', 401);
    }
    if (resolvedProjectId !== projectId) {
      throw new AiTokenServiceError('AI_PROJECT_ACCESS_DENIED', '绑定码无权管理该项目的 AI Token。', 403);
    }
  }

  public async createToken(input: CreateAiTokenInput, bindingCode: string): Promise<CreatedAiToken> {
    const projectId = clean(input.projectId);
    const name = clean(input.name) || 'AI Director';
    const scope = scopes(input.scope);
    if (!projectId) throw new AiTokenServiceError('AI_PROJECT_ID_REQUIRED', 'projectId 不能为空。', 400);
    if (!scope.length) throw new AiTokenServiceError('AI_TOKEN_SCOPE_REQUIRED', '至少选择一个 AI Token 权限。', 400);
    if (scope.length !== (Array.isArray(input.scope) ? new Set(input.scope.map(clean)).size : 0)) {
      throw new AiTokenServiceError('AI_TOKEN_SCOPE_INVALID', 'AI Token 权限包含不支持的 scope。', 400);
    }
    await this.authorizeProject(projectId, bindingCode);
    if (!this.repository.isAvailable()) {
      throw new AiTokenServiceError('AI_TOKEN_STORAGE_UNAVAILABLE', 'AI Token Firestore 当前不可用。', 503);
    }

    const now = this.now();
    const token = generatedToken();
    const record: DirectorAiTokenRecord = {
      tokenId: `ai_${randomUUID()}`,
      projectId,
      tokenHash: hashToken(token),
      name: name.slice(0, 120),
      scope,
      status: 'ACTIVE',
      createdAt: new Date(now).toISOString(),
      expiresAt: validExpiry(input.expiresAt, now),
    };
    const saved = await this.repository.createToken(record);
    return { ...publicToken(saved), token };
  }

  public async listTokens(projectId: string, bindingCode: string): Promise<DirectorAiTokenPublic[]> {
    await this.authorizeProject(projectId, bindingCode);
    if (!this.repository.isAvailable()) {
      throw new AiTokenServiceError('AI_TOKEN_STORAGE_UNAVAILABLE', 'AI Token Firestore 当前不可用。', 503);
    }
    const records = await this.repository.listTokens(projectId);
    return records.map(publicToken);
  }

  public async revokeToken(tokenIdInput: string, bindingCode: string): Promise<boolean> {
    const tokenId = clean(tokenIdInput);
    if (!tokenId) throw new AiTokenServiceError('AI_TOKEN_ID_REQUIRED', 'tokenId 不能为空。', 400);
    if (!this.repository.isAvailable()) {
      throw new AiTokenServiceError('AI_TOKEN_STORAGE_UNAVAILABLE', 'AI Token Firestore 当前不可用。', 503);
    }
    const record = await this.repository.getToken(tokenId);
    if (!record) return false;
    await this.authorizeProject(record.projectId, bindingCode);
    return this.repository.revokeToken(tokenId);
  }

  public async authenticate(rawToken: string): Promise<DirectorAiTokenRecord | null> {
    const token = clean(rawToken);
    if (!token) return null;
    if (!this.repository.isAvailable()) {
      throw new AiTokenServiceError('AI_TOKEN_STORAGE_UNAVAILABLE', 'AI Token Firestore 当前不可用。', 503);
    }
    const record = await this.repository.findByHash(hashToken(token));
    if (!record || record.status !== 'ACTIVE') return null;
    if (record.expiresAt) {
      const expiresAt = Date.parse(record.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= this.now()) return null;
    }
    return record;
  }

  public toPublic(record: DirectorAiTokenRecord): DirectorAiTokenPublic {
    return publicToken(record);
  }
}

export const aiTokenService = new AiTokenService();

export { hashToken };
