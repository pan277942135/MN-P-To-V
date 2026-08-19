import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export const CHATGPT_GATEWAY_VERSION = 'chatgpt-gateway-v1';

function configuredApiKey(): string {
  return String(process.env.CHATGPT_GATEWAY_API_KEY || '').trim();
}

function bearerToken(req: Request): string {
  const authorization = String(req.header('authorization') || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : '';
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function chatgptGatewayEnabled(): boolean {
  return configuredApiKey().length >= 24;
}

export function requireChatgptGatewayAuth(req: Request, res: Response, next: NextFunction) {
  const expected = configuredApiKey();
  if (expected.length < 24) {
    return res.status(503).json({
      error: {
        code: 'CHATGPT_GATEWAY_DISABLED',
        message: 'ChatGPT gateway is not configured on this environment.',
      },
    });
  }
  const supplied = bearerToken(req);
  if (!supplied || !constantTimeEqual(supplied, expected)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="zaojing-chatgpt"');
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Valid ChatGPT gateway bearer token required.' } });
  }
  return next();
}

export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction) {
  const key = String(req.header('idempotency-key') || req.header('x-idempotency-key') || '').trim();
  if (key.length < 16 || key.length > 200) {
    return res.status(400).json({
      error: {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'A stable Idempotency-Key header between 16 and 200 characters is required for video creation.',
      },
    });
  }
  req.headers['x-idempotency-key'] = key;
  return next();
}
