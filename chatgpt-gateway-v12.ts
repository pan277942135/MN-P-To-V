import express from 'express';
import { createChatGptImageRouter } from './chatgpt-image-router';

const PORT = Number(process.env.PORT || 8080);

export async function createChatGptGatewayV12App() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // New image routes are mounted first. Requests not handled here (for example the
  // existing /v1/images/preflight route) fall through to the proven v1 gateway.
  app.use('/v1/images', createChatGptImageRouter());

  const previousVitest = process.env.VITEST;
  process.env.VITEST = 'chatgpt-gateway-v12-wrapper';
  const legacyModule = await import('./chatgpt-gateway');
  if (previousVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = previousVitest;

  app.use(legacyModule.createChatGptGatewayApp());
  return app;
}

export async function startChatGptGatewayV12() {
  const app = await createChatGptGatewayV12App();
  return app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ZAOJING_CHATGPT_GATEWAY_V12] listening on :${PORT}; headOnlyImages=true`);
  });
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) void startChatGptGatewayV12();
