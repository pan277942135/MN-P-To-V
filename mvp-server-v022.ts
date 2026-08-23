import express from 'express';
import { createHeadOnlyImageRouter } from './src/mvp/headOnlyImageRouter';

const PORT = Number(process.env.PORT || 8080);

export async function createMvpAppV022() {
  const app = express();

  // Mount image editing before the legacy video app so /api/mvp/images/* is handled
  // by the dedicated HEAD-ONLY pipeline without changing the proven video routes.
  app.use('/api/mvp/images', createHeadOnlyImageRouter());

  const previousVitest = process.env.VITEST;
  process.env.VITEST = 'mvp-v022-wrapper';
  const legacyModule = await import('./mvp-server-v021');
  if (previousVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = previousVitest;

  const legacyApp = await legacyModule.createMvpAppV021();
  app.use(legacyApp);
  return app;
}

export async function startMvpServerV022() {
  const app = await createMvpAppV022();
  return app.listen(PORT, '0.0.0.0', () => {
    console.log(`[MVP_HEAD_ONLY_V022] listening on :${PORT}; imageMode=HEAD_ONLY_CHARACTER_SWAP`);
  });
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) void startMvpServerV022();
