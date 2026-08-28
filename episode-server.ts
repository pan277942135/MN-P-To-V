import type { Server } from 'node:http';
import express from 'express';
import type { EpisodeSpec, ShotSpec } from './src/domain/episode/episodeTypes';
import type { ShotProductionServiceLike } from './src/server/services/shotProductionService';
import { firestoreEpisodeRepository } from './src/server/repositories/firestoreEpisodeRepository';
import { firestoreShotRepository } from './src/server/repositories/firestoreShotRepository';
import { hasCompleteDurableKeyframeAsset } from './src/server/services/keyframeInputResolver';
import {
  createDefaultEpisodeProductionRunner,
  type EpisodeProductionRunInput,
  type EpisodeProductionRunResult,
} from './src/server/services/episodeProductionRunner';
import { taskStateMachineService } from './src/server/services/taskStateMachineService';

export interface EpisodeProductionRunnerLike {
  run(input: EpisodeProductionRunInput): Promise<EpisodeProductionRunResult>;
}

export interface EpisodeReadRepositoryLike {
  isAvailable(): boolean;
  getEpisode(id: string): Promise<EpisodeSpec | null>;
  listEpisodes(limitCount?: number): Promise<EpisodeSpec[]>;
}

export interface ShotReadRepositoryLike {
  isAvailable(): boolean;
  listShotsByEpisode(episodeId: string, limitCount?: number): Promise<ShotSpec[]>;
}

export interface EpisodeServerDependencies {
  episodeProductionRunner?: EpisodeProductionRunnerLike;
  shotProductionService?: ShotProductionServiceLike;
  episodeRepository?: EpisodeReadRepositoryLike;
  shotRepository?: ShotReadRepositoryLike;
}

function isPublicPreviewReadOnly(): boolean {
  return process.env.PUBLIC_PREVIEW_READ_ONLY === '1';
}

function isProductionRunEnabled(): boolean {
  return !isPublicPreviewReadOnly() && process.env.DIRECTOR_PRODUCTION_RUN_ENABLED !== '0';
}

function directorCapabilities() {
  return {
    readOnlyPreview: isPublicPreviewReadOnly(),
    productionRunEnabled: isProductionRunEnabled(),
  };
}

function hasDurableLocation(shot: ShotSpec): boolean {
  return Boolean(
    String(shot.keyframe.outputBucket || '').trim() ||
    String(shot.keyframe.outputObjectPath || '').trim(),
  );
}

function directorShotView(shot: ShotSpec) {
  const durableKeyframeReady = hasCompleteDurableKeyframeAsset(shot);
  let state: 'READY' | 'BLOCKED' | 'COMPLETED' = 'BLOCKED';
  let reasonCode: string | undefined;

  if (shot.status === 'COMPLETED' && shot.video.status === 'PASS') {
    state = 'COMPLETED';
  } else if (shot.status === 'FAILED') {
    reasonCode = shot.video.failureCode || 'SHOT_FAILED';
  } else if (shot.keyframe.status !== 'PASS') {
    reasonCode = shot.keyframe.status === 'REVIEW' || shot.status === 'KEYFRAME_REVIEW'
      ? 'KEYFRAME_REVIEW_REQUIRED'
      : 'KEYFRAME_NOT_PASS';
  } else if (durableKeyframeReady) {
    state = 'READY';
  } else if (hasDurableLocation(shot)) {
    reasonCode = 'KEYFRAME_DURABLE_ASSET_INVALID';
  } else {
    reasonCode = 'OPENAI_FILE_REF_REQUIRED';
  }

  return {
    ...shot,
    director: {
      state,
      durableKeyframeReady,
      ...(reasonCode ? { reasonCode } : {}),
    },
  };
}

function directorSummary(shots: ShotSpec[], currentShotId?: string) {
  const ordered = [...shots].sort((a, b) => a.order - b.order);
  const completed = ordered.filter((shot) => shot.status === 'COMPLETED' && shot.video.status === 'PASS').length;
  const keyframePass = ordered.filter((shot) => shot.keyframe.status === 'PASS').length;
  const durableReady = ordered.filter((shot) => hasCompleteDurableKeyframeAsset(shot)).length;
  const videoPass = ordered.filter((shot) => shot.video.status === 'PASS').length;
  const failed = ordered.filter((shot) => shot.status === 'FAILED').length;
  const current = currentShotId || ordered.find((shot) => !(shot.status === 'COMPLETED' && shot.video.status === 'PASS'))?.shotId || null;
  const incomplete = ordered.filter((shot) => !(shot.status === 'COMPLETED' && shot.video.status === 'PASS'));

  return {
    totalShots: ordered.length,
    completed,
    keyframePass,
    durableReady,
    videoPass,
    failed,
    currentShotId: current,
    percent: ordered.length > 0 ? Math.round((completed / ordered.length) * 100) : 0,
    canRunWithoutLegacyFileRefs: incomplete.every((shot) => hasCompleteDurableKeyframeAsset(shot)),
  };
}

function buildDirectorSnapshot(episode: EpisodeSpec, shots: ShotSpec[]) {
  const ordered = [...shots].sort((a, b) => a.order - b.order);
  return {
    episode,
    shots: ordered.map(directorShotView),
    summary: directorSummary(ordered, episode.currentShotId),
    capabilities: directorCapabilities(),
  };
}

async function loadBaseServerModule() {
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
  const baseApp = await baseServer.createApp(
    dependencies.shotProductionService
      ? { s01ProductionService: dependencies.shotProductionService }
      : {},
  );
  const episodeProductionRunner =
    dependencies.episodeProductionRunner || createDefaultEpisodeProductionRunner();
  const episodeRepository = dependencies.episodeRepository || firestoreEpisodeRepository;
  const shotRepository = dependencies.shotRepository || firestoreShotRepository;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  app.use((req, res, next) => {
    const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
    if (isPublicPreviewReadOnly() && req.path.startsWith('/api/') && !safeMethod) {
      return res.status(423).json({
        ok: false,
        error: 'PREVIEW_READ_ONLY',
        message: '当前 Cloud Run 为公开只读 Preview；所有写操作和 Provider 调用均已锁定。',
      });
    }
    return next();
  });

  app.get('/api/director/capabilities', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, ...directorCapabilities() });
  });

  app.get('/api/episodes', async (req, res) => {
    if (!episodeRepository.isAvailable() || !shotRepository.isAvailable()) {
      return res.status(503).json({
        ok: false,
        error: 'EPISODE_STORAGE_UNAVAILABLE',
        message: 'Episode/Shot Firestore 当前不可用。',
      });
    }

    const rawLimit = Number(req.query.limit || 20);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.floor(rawLimit))) : 20;
    try {
      const episodes = await episodeRepository.listEpisodes(limit);
      const items = await Promise.all(
        episodes.map(async (episode) => {
          const shots = await shotRepository.listShotsByEpisode(episode.id, 20);
          return buildDirectorSnapshot(episode, shots);
        }),
      );
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, items, capabilities: directorCapabilities() });
    } catch (error: any) {
      return res.status(500).json({
        ok: false,
        error: 'EPISODE_READ_FAILED',
        message: error?.message || String(error),
      });
    }
  });

  app.get('/api/episodes/:episodeId', async (req, res) => {
    if (!episodeRepository.isAvailable() || !shotRepository.isAvailable()) {
      return res.status(503).json({
        ok: false,
        error: 'EPISODE_STORAGE_UNAVAILABLE',
        message: 'Episode/Shot Firestore 当前不可用。',
      });
    }

    const episodeId = String(req.params.episodeId || '').trim();
    if (!episodeId) {
      return res.status(400).json({ ok: false, error: 'EPISODE_ID_REQUIRED', message: 'episodeId 不能为空。' });
    }

    try {
      const episode = await episodeRepository.getEpisode(episodeId);
      if (!episode) {
        return res.status(404).json({
          ok: false,
          error: 'EPISODE_NOT_FOUND',
          message: `找不到 Episode ${episodeId}。`,
        });
      }
      const shots = await shotRepository.listShotsByEpisode(episodeId, 20);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, ...buildDirectorSnapshot(episode, shots) });
    } catch (error: any) {
      return res.status(500).json({
        ok: false,
        error: 'EPISODE_READ_FAILED',
        message: error?.message || String(error),
        episodeId,
      });
    }
  });

  app.post('/api/episodes/:episodeId/run', async (req, res) => {
    if (!isProductionRunEnabled()) {
      return res.status(423).json({
        ok: false,
        error: 'EPISODE_PRODUCTION_DISABLED',
        message: '当前环境未开放 Episode Production 执行。',
        episodeId: String(req.params.episodeId || '').trim(),
      });
    }

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

  app.use(baseApp);

  return app;
}

export async function startServer(): Promise<Server> {
  const app = await createApp();
  const configuredPort = Number(process.env.PORT || 3000);
  const port = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 3000;

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);

    if (process.env.P0_DISABLE_STARTUP_RECOVERY === '1') {
      console.log('[Recovery Engine] Startup recovery disabled for local/runtime preview.');
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
