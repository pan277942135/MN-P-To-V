import type { Server } from 'node:http';
import express from 'express';
import type { EpisodeServerDependencies } from './episode-server';
import { createDirectorCloudPersistenceRouter } from './src/server/services/directorCloudPersistenceRouter';

async function loadEpisodeServerModule() {
  const previousVitest = process.env.VITEST;
  process.env.VITEST = previousVitest || 'director-cloud-wrapper';
  try {
    return await import('./episode-server');
  } finally {
    if (previousVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = previousVitest;
  }
}

export async function createApp(dependencies: EpisodeServerDependencies = {}) {
  const episodeServer = await loadEpisodeServerModule();
  const episodeApp = await episodeServer.createApp(dependencies);
  const app = express();
  app.disable('x-powered-by');

  // Step 4.0 persistence routes are mounted before the Episode preview read-only gate.
  // This router enforces its own explicit persistence-intent header and only writes
  // Director metadata/assets; it does not enable Episode/Veo production execution.
  app.use('/api/director/persistence', createDirectorCloudPersistenceRouter());
  app.use(episodeApp);
  return app;
}

export async function startServer(): Promise<Server> {
  const app = await createApp();
  const configuredPort = Number(process.env.PORT || 3000);
  const port = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 3000;
  return app.listen(port, '0.0.0.0', () => {
    console.log(`Director Cloud server listening on http://0.0.0.0:${port}`);
  });
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  void startServer();
}
