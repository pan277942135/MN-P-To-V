import type { Server } from 'node:http';
import express from 'express';
import type { EpisodeServerDependencies } from './episode-server';
import { createDirectorCloudPersistenceRouter } from './src/server/services/directorCloudPersistenceRouter';
import { createProjectBindingRouter } from './src/server/services/projectBindingRouter';
import { createDirectorAssetRouter } from './src/server/services/assetRegistry/assetRegistryRouter';
import { createDirectorContextRouter } from './src/server/services/directorContext/directorContextRouter';
import { createProjectSessionRouter } from './src/server/services/projectSessionRouter';
import { createFirestoreDiagnosticRouter } from './src/server/services/firestoreDiagnosticRouter';

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
  // Project Binding is the anonymous, bearer-code entry point for cross-device
  // restore. It is mounted before the Episode preview gate like cloud persistence.
  app.use('/api/director/project-binding', createProjectBindingRouter());
  // Asset Registry is a query/index layer over the existing production assets.
  // It is mounted beside cloud persistence so best-effort registration can still
  // complete in the public Director preview without changing the production gate.
  app.use('/api/director', createDirectorAssetRouter());
  // AI Director Context is a read-only composition of the existing Director
  // Cloud Shot/Blueprint data and the Asset Registry. It does not create a new
  // source of truth or open any provider execution path.
  app.use('/api/director', createDirectorContextRouter());
  // Project Session is the single read entry point for the Director UI. It
  // composes the existing production snapshot with Registry assets; it does
  // not replace either source or alter the binding restore contract.
  app.use('/api/director/project-session', createProjectSessionRouter());
  app.use('/api/debug/firestore', createFirestoreDiagnosticRouter());
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
