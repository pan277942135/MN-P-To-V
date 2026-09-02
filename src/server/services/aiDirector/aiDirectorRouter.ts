import express from 'express';
import type {
  AiDirectorScope,
  AiAssetPreviewResponse,
  AiDirectorContext,
  AiDirectorShot,
  AiReviewPackageResponse,
  DirectorAiTokenRecord,
} from '../../../services/aiDirector/aiDirectorTypes';
import {
  aiDirectorService,
  type AiDirectorService,
} from './aiDirectorService';
import {
  aiTokenService,
  type AiTokenService,
  type CreatedAiToken,
} from './aiTokenService';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorStatus(error: any, fallback = 500): number {
  const status = Number(error?.statusCode || error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback;
}

function errorCode(error: any, fallback: string): string {
  return typeof error?.code === 'string' && error.code.trim() ? error.code.trim() : fallback;
}

function errorMessage(error: any, status: number, fallback: string): string {
  if (status >= 500 && !(error?.name === 'AiTokenServiceError' || error?.name === 'AiDirectorServiceError')) {
    return fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

function errorResponse(res: express.Response, error: any, fallbackCode: string, fallbackMessage: string) {
  const status = errorStatus(error);
  return res.status(status).json({
    ok: false,
    error: errorCode(error, fallbackCode),
    message: errorMessage(error, status, fallbackMessage),
    ...(error?.reason ? { reason: error.reason } : {}),
  });
}

function bearerToken(req: express.Request): string {
  const header = clean(req.get('Authorization'));
  const match = header.match(/^Bearer\s+(.+)$/i);
  return clean(match?.[1]);
}

function bindingCode(req: express.Request): string {
  return clean(req.get('X-Director-Binding-Code')) || clean(req.body?.bindingCode);
}

function projectIdFromToken(req: express.Request): string {
  return clean((req as any).aiToken?.projectId);
}

function requestedScopes(value: unknown): AiDirectorScope[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(clean).filter((item): item is AiDirectorScope => (
    item === 'context' || item === 'preview' || item === 'review_package'
  )))];
}

function invalidRequestedScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(clean).filter((item) => !['context', 'preview', 'review_package'].includes(item)))];
}

function setNoStore(res: express.Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

export interface AiTokenServiceLike {
  isAvailable(): boolean;
  createToken(input: { projectId: string; name: string; scope: AiDirectorScope[]; expiresAt?: string }, bindingCode: string): Promise<CreatedAiToken>;
  listTokens(projectId: string, bindingCode: string): Promise<unknown[]>;
  revokeToken(tokenId: string, bindingCode: string): Promise<boolean>;
  authenticate(rawToken: string): Promise<DirectorAiTokenRecord | null>;
  toPublic(record: DirectorAiTokenRecord): unknown;
}

export interface AiDirectorServiceLike {
  getProjectContext(projectId: string, scopes: AiDirectorScope[]): Promise<AiDirectorContext>;
  getShotContext(projectId: string, shotUid: string, scopes: AiDirectorScope[]): Promise<AiDirectorShot & { purpose: string }>;
  getAssetPreview(projectId: string, assetId: string): Promise<AiAssetPreviewResponse>;
  generateReviewPackage(projectId: string, scopes: AiDirectorScope[]): Promise<AiReviewPackageResponse>;
}

export function createAiDirectorRouter(
  tokenService: AiTokenServiceLike = aiTokenService,
  service: AiDirectorServiceLike = aiDirectorService,
) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  const requireScopes = (required: AiDirectorScope[]) => async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const rawToken = bearerToken(req);
    if (!rawToken) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'AI_TOKEN_REQUIRED', message: '需要 Authorization: Bearer {token}。'});
    }
    try {
      const token = await tokenService.authenticate(rawToken);
      if (!token) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return res.status(401).json({ ok: false, error: 'AI_TOKEN_INVALID', message: 'AI Token 无效、已撤销或已过期。' });
      }
      const missing = required.filter((scope) => !token.scope.includes(scope));
      if (missing.length) {
        return res.status(403).json({
          ok: false,
          error: 'AI_SCOPE_REQUIRED',
          message: `Token 缺少权限：${missing.join(', ')}。`,
          required: missing,
        });
      }
      (req as any).aiToken = token;
      return next();
    } catch (error) {
      return errorResponse(res, error, 'AI_TOKEN_AUTH_FAILED', 'AI Token 校验失败。');
    }
  };

  const assertProject = (req: express.Request, res: express.Response, projectIdInput: string): string | null => {
    const projectId = clean(projectIdInput);
    if (!projectId) {
      res.status(400).json({ ok: false, error: 'AI_PROJECT_ID_REQUIRED', message: 'projectId 不能为空。' });
      return null;
    }
    if (projectIdFromToken(req) !== projectId) {
      res.status(403).json({ ok: false, error: 'AI_PROJECT_ACCESS_DENIED', message: 'Token 无权访问该项目。' });
      return null;
    }
    return projectId;
  };

  router.post('/tokens', async (req, res) => {
    const invalidScopes = invalidRequestedScopes(req.body?.scope);
    if (invalidScopes.length) {
      return res.status(400).json({
        ok: false,
        error: 'AI_TOKEN_SCOPE_INVALID',
        message: `AI Token 权限不支持：${invalidScopes.join(', ')}。`,
      });
    }
    try {
      const created = await tokenService.createToken({
        projectId: clean(req.body?.projectId),
        name: clean(req.body?.name),
        scope: requestedScopes(req.body?.scope),
        ...(clean(req.body?.expiresAt) ? { expiresAt: clean(req.body.expiresAt) } : {}),
      }, bindingCode(req));
      setNoStore(res);
      // The plaintext token is deliberately returned only in this response.
      return res.status(201).json({ ok: true, ...created });
    } catch (error) {
      return errorResponse(res, error, 'AI_TOKEN_CREATE_FAILED', '创建 AI Token 失败。');
    }
  });

  router.get('/tokens', async (req, res) => {
    const projectId = clean(req.query.projectId);
    if (!projectId) return res.status(400).json({ ok: false, error: 'AI_PROJECT_ID_REQUIRED', message: 'projectId 不能为空。' });
    try {
      const tokens = await tokenService.listTokens(projectId, bindingCode(req));
      setNoStore(res);
      return res.status(200).json({ ok: true, projectId, tokens });
    } catch (error) {
      return errorResponse(res, error, 'AI_TOKEN_LIST_FAILED', '读取 AI Token 列表失败。');
    }
  });

  router.delete('/tokens/:tokenId', async (req, res) => {
    const tokenId = clean(req.params.tokenId);
    if (!tokenId) return res.status(400).json({ ok: false, error: 'AI_TOKEN_ID_REQUIRED', message: 'tokenId 不能为空。' });
    try {
      const revoked = await tokenService.revokeToken(tokenId, bindingCode(req));
      if (!revoked) return res.status(404).json({ ok: false, error: 'AI_TOKEN_NOT_FOUND', message: '找不到指定 AI Token。' });
      setNoStore(res);
      return res.status(200).json({ ok: true, tokenId, status: 'REVOKED' });
    } catch (error) {
      return errorResponse(res, error, 'AI_TOKEN_REVOKE_FAILED', '撤销 AI Token 失败。');
    }
  });

  router.get('/projects/:projectId/context', requireScopes(['context']), async (req, res) => {
    const projectId = assertProject(req, res, req.params.projectId);
    if (!projectId) return;
    try {
      const context = await service.getProjectContext(projectId, (req as any).aiToken.scope);
      setNoStore(res);
      return res.status(200).json({ ok: true, ...context });
    } catch (error) {
      return errorResponse(res, error, 'AI_PROJECT_CONTEXT_FAILED', '读取 AI 项目上下文失败。');
    }
  });

  router.get('/shots/:shotUid/context', requireScopes(['context']), async (req, res) => {
    const projectId = projectIdFromToken(req);
    const shotUid = clean(req.params.shotUid);
    if (!projectId) return res.status(403).json({ ok: false, error: 'AI_PROJECT_ACCESS_DENIED', message: 'Token 未绑定项目。' });
    if (!shotUid) return res.status(400).json({ ok: false, error: 'AI_SHOT_UID_REQUIRED', message: 'shotUid 不能为空。' });
    try {
      const context = await service.getShotContext(projectId, shotUid, (req as any).aiToken.scope);
      setNoStore(res);
      return res.status(200).json({ ok: true, ...context });
    } catch (error) {
      return errorResponse(res, error, 'AI_SHOT_CONTEXT_FAILED', '读取 AI Shot 上下文失败。');
    }
  });

  router.get('/assets/:assetId/preview', requireScopes(['preview']), async (req, res) => {
    const projectId = projectIdFromToken(req);
    const assetId = clean(req.params.assetId);
    if (!projectId) return res.status(403).json({ ok: false, error: 'AI_PROJECT_ACCESS_DENIED', message: 'Token 未绑定项目。' });
    if (!assetId) return res.status(400).json({ ok: false, error: 'AI_ASSET_ID_REQUIRED', message: 'assetId 不能为空。' });
    try {
      const preview = await service.getAssetPreview(projectId, assetId);
      setNoStore(res);
      return res.status(200).json({ ok: true, ...preview });
    } catch (error) {
      return errorResponse(res, error, 'AI_ASSET_PREVIEW_FAILED', '读取 AI Asset Preview 失败。');
    }
  });

  router.post('/projects/:projectId/review-package', requireScopes(['context', 'review_package']), async (req, res) => {
    const projectId = assertProject(req, res, req.params.projectId);
    if (!projectId) return;
    try {
      const packageResponse = await service.generateReviewPackage(projectId, (req as any).aiToken.scope);
      setNoStore(res);
      return res.status(200).json({ ok: true, ...packageResponse });
    } catch (error) {
      return errorResponse(res, error, 'AI_REVIEW_PACKAGE_FAILED', '生成 AI Review Package 失败。');
    }
  });

  return router;
}

export { AI_SIGNED_URL_TTL_SECONDS } from './aiDirectorService';
