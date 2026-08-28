import type { Server } from 'node:http';
import type { ShotProductionServiceLike } from './src/server/services/shotProductionService';
import {
  createDefaultEpisodeProductionRunner,
  type EpisodeProductionRunInput,
  type EpisodeProductionRunResult,
} from './src/server/services/episodeProductionRunner';
import { taskStateMachineService } from './src/server/services/taskStateMachineService';

export interface EpisodeProductionRunnerLike {
  run(input: EpisodeProductionRunInput): Promise<EpisodeProductionRunResult>;
}

export interface EpisodeServerDependencies {
  episodeProductionRunner?: EpisodeProductionRunnerLike;
  shotProductionService?: ShotProductionServiceLike;
}

async function loadBaseServerModule() {
  // server.ts historically self-starts outside test/Vitest. Set a temporary sentinel so
  // this wrapper can compose its Express app first, then own the single listen() call.
  const previousVitest = process.env.VITEST;
  process.env.VITEST = previousVitest || 'episode-production-wrapper';
  try {
    return await import('./server');
  } finally {
    if (previousVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = previousVitest;
  }
}

export async function createApp(dependencies: EpisodeServerDependencies = {}) {
  const baseServer = await loadBaseServerModule();
  const app = await baseServer.createApp(
    dependencies.shotProductionService
      ? { s01ProductionService: dependencies.shotProductionService }
      : {},
  );
  const episodeProductionRunner =
    dependencies.episodeProductionRunner || createDefaultEpisodeProductionRunner();

  app.post('/api/episodes/:episodeId/run', async (req, res) => {
    const episodeId = String(req.params.episodeId || '').trim();
    const rawInputs = req.body?.shots ?? req.body?.shotInputs ?? {};
    const shots = rawInputs && typeof rawInputs === 'object' && !Array.isArray(rawInputs)
      ? rawInputs
      : {};

    try {
      const result = await episodeProductionRunner.run({ episodeId, shots });
      return res.status(200).json({ ok: true, ...result });
    } catch (error: any) {
      const statusCode = Number(error?.statusCode);
      const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
        ? statusCode
        : 502;
      const code = typeof error?.code === 'string' && error.code.trim()
        ? error.code.trim()
        : 'EPISODE_PRODUCTION_FAILED';
      return res.status(status).json({
        ok: false,
        error: code,
        message: error instanceof Error ? error.message : String(error),
        episodeId,
      });
    }
  });

  return app;
}

export async function startServer(): Promise<Server> {
  const app = await createApp();
  const configuredPort = Number(process.env.PORT || 3000);
  const port = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 3000;

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);

    // Preserve the P0-5 durable startup recovery contract from server.ts.
    if (process.env.P0_DISABLE_STARTUP_RECOVERY === '1') {
      console.log('[Recovery Engine] Startup recovery disabled for local runtime smoke.');
      return;
    }
    void taskStateMachineService
      .recoverAbandonedTasks()
      .then(({ recoveredCount, evaluatedCount }) => {
        console.log(
          `[Recovery Engine] Durable startup scan complete: evaluated=${evaluatedCount}, recovered=${recoveredCount}.`,
        );
      })
      .catch((error) => {
        console.error('[Recovery Engine Initialization Error]:', error);
      });
  });

  return server;
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  void startServer();
}
