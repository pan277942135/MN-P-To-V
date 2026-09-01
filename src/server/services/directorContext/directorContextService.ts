import { getFirestoreInstance, markFirestoreUnavailable } from '../../db/firestore';
import {
  directorAssetRepository,
  type DirectorAssetRepositoryLike,
} from '../../repositories/directorAssetRepository';
import {
  firestoreDirectorProjectRepository,
  type DirectorCloudRestoreBundle,
} from '../../repositories/firestoreDirectorProjectRepository';
import {
  assetRegistrySyncService,
  type AssetRegistrySyncServiceLike,
} from '../assetRegistry/assetRegistrySyncService';
import {
  DIRECTOR_CONTEXT_SCHEMA,
  type DirectorContext,
  type DirectorContextAsset,
  type DirectorContextEpisode,
  type DirectorContextProject,
  type DirectorContextShot,
  type DirectorShotContext,
} from '../../../services/directorContext/directorContextTypes';
import type { DirectorAssetRecord } from '../../../services/assetRegistry/assetRegistryTypes';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function text(...values: unknown[]): string {
  for (const value of values) {
    const next = clean(value);
    if (next) return next;
  }
  return '';
}

function numericOrder(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return 0;
}

function contextError(code: string, message: string, statusCode: number): DirectorContextError {
  return new DirectorContextError(code, message, statusCode);
}

export class DirectorContextError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'DirectorContextError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface DirectorContextShotLocation {
  projectId: string;
  episodeId: string;
}

export interface DirectorContextSourceLike {
  isAvailable(): boolean;
  getRestoreBundle(projectId: string, episodeId?: string): Promise<DirectorCloudRestoreBundle | null>;
  findShotLocation(shotUid: string): Promise<DirectorContextShotLocation | null>;
}

class FirestoreDirectorContextSource implements DirectorContextSourceLike {
  public isAvailable(): boolean {
    return firestoreDirectorProjectRepository.isAvailable();
  }

  public getRestoreBundle(projectId: string, episodeId?: string) {
    return firestoreDirectorProjectRepository.getRestoreBundle(projectId, episodeId);
  }

  public async findShotLocation(shotUidInput: string): Promise<DirectorContextShotLocation | null> {
    const shotUid = clean(shotUidInput);
    const db = getFirestoreInstance();
    if (!shotUid || !db) {
      throw contextError(
        'DIRECTOR_CONTEXT_STORAGE_UNAVAILABLE',
        'Director Context Firestore 当前不可用。',
        503,
      );
    }

    try {
      // Director Cloud persists a projection for every Shot, including Shots
      // without assets. The collection-group lookup keeps Shot Context useful
      // when Asset Registry is empty.
      const shots = await db.collectionGroup('shots')
        .where('shotUid', '==', shotUid)
        .limit(1)
        .get();
      const shot = shots.docs[0]?.data() || {};
      const location = {
        projectId: clean(shot.projectId),
        episodeId: clean(shot.episodeId),
      };
      if (location.projectId && location.episodeId) return location;

      // Older or partially migrated records may have Registry rows without a
      // persisted per-Shot projection. The fallback is still read-only.
      const assets = await db.collection('director_assets')
        .where('shotUid', '==', shotUid)
        .limit(1)
        .get();
      const asset = assets.docs[0]?.data() || {};
      const assetLocation = {
        projectId: clean(asset.projectId),
        episodeId: clean(asset.episodeId),
      };
      return assetLocation.projectId && assetLocation.episodeId ? assetLocation : null;
    } catch (error) {
      markFirestoreUnavailable(error);
      throw error;
    }
  }
}

function briefFrom(bundle: DirectorCloudRestoreBundle): Record<string, any> {
  return objectValue(bundle.stages?.brief);
}

function storyboardFrom(bundle: DirectorCloudRestoreBundle): Record<string, any> {
  return objectValue(bundle.stages?.storyboard);
}

function buildProject(bundle: DirectorCloudRestoreBundle, projectId: string): DirectorContextProject {
  const project = objectValue(bundle.project);
  const episode = objectValue(bundle.episode);
  const brief = briefFrom(bundle);
  return {
    projectId,
    title: text(project.projectTitle, project.title, episode.projectTitle, brief.title, projectId),
    creativeBrief: text(project.creativeBrief, brief.creativeBrief, brief.summary),
    targetFormat: text(project.targetFormat, brief.targetFormat),
    aspectRatio: text(project.aspectRatio, brief.aspectRatio, '9:16'),
  };
}

function buildEpisode(bundle: DirectorCloudRestoreBundle, requestedEpisodeId?: string): DirectorContextEpisode {
  const project = objectValue(bundle.project);
  const episode = objectValue(bundle.episode);
  const brief = briefFrom(bundle);
  const storyboard = storyboardFrom(bundle);
  const episodeId = text(episode.episodeId, requestedEpisodeId, project.activeEpisodeId);
  return {
    episodeId,
    title: text(
      episode.title,
      episode.episodeTitle,
      brief.episodeTitle,
      storyboard.episodeTitle,
      episode.projectTitle,
      project.projectTitle,
      episodeId,
    ),
    summary: text(
      episode.summary,
      episode.synopsis,
      brief.episodeSummary,
      brief.summary,
      storyboard.summary,
      brief.creativeBrief,
    ),
    status: text(episode.status, bundle.productionStatus?.episodeStatus, 'DRAFT'),
  };
}

function previewPath(asset: DirectorAssetRecord): string {
  return clean(asset.storage.previewPath)
    || `/api/director/assets/${encodeURIComponent(asset.assetId)}/preview`;
}

function buildAsset(asset: DirectorAssetRecord): DirectorContextAsset {
  const preview = previewPath(asset);
  return {
    assetId: asset.assetId,
    type: asset.assetType,
    mediaType: asset.mediaType,
    thumbnail: clean(asset.storage.thumbnailPath) || preview,
    preview,
    metadata: { ...asset.metadata },
    reviewStatus: asset.review.status,
    shotUid: asset.shotUid,
    status: asset.status,
    sourceType: asset.source.type,
    description: text(asset.relations.description, asset.relations.shotPurpose),
  };
}

function buildShot(
  rawInput: Record<string, any>,
  index: number,
  assetsByShot: Map<string, DirectorContextAsset[]>,
): DirectorContextShot | null {
  const raw = objectValue(rawInput);
  const storyboard = objectValue(raw.storyboard);
  const blueprint = objectValue(raw.keyframeBlueprint);
  const shotUid = text(raw.shotUid, raw.shotId, storyboard.uid, storyboard.shotUid, blueprint.shotUid);
  if (!shotUid) return null;

  const title = text(raw.title, storyboard.title, blueprint.shotTitle, shotUid);
  const scene = text(raw.scene, storyboard.scene, blueprint.scene);
  const action = text(raw.action, storyboard.action, blueprint.keyMoment);
  const explicitVisualDescription = text(raw.visualDescription, storyboard.visualDescription, blueprint.visualDescription);
  const storyPurpose = text(
    raw.storyPurpose,
    raw.purpose,
    storyboard.storyPurpose,
    storyboard.purpose,
    blueprint.storyPurpose,
  );
  const visualDescription = explicitVisualDescription || [
    scene ? `场景：${scene}` : '',
    action ? `动作：${action}` : '',
  ].filter(Boolean).join('；');
  const video = objectValue(raw.video);
  const videoBlueprint = objectValue(raw.videoBlueprint);
  const keyframeQa = objectValue(raw.keyframeQa);
  const keyframeAsset = objectValue(raw.keyframeAsset);
  return {
    shotUid,
    order: numericOrder(raw.order, storyboard.order) || index + 1,
    title,
    storyPurpose,
    visualDescription,
    camera: text(raw.camera, storyboard.camera, blueprint.composition),
    action,
    dialogue: text(raw.dialogue, raw.voiceover, storyboard.dialogue, storyboard.voiceover),
    status: text(raw.status, video.status, videoBlueprint.status, keyframeQa.autoStatus, keyframeQa.status, keyframeAsset.status, 'DRAFT'),
    assets: assetsByShot.get(shotUid) || [],
  };
}

function buildAssetSummary(assets: DirectorContextAsset[]) {
  return {
    total: assets.length,
    images: assets.filter((asset) => asset.type === 'IMAGE').length,
    videos: assets.filter((asset) => asset.type === 'VIDEO').length,
    audio: assets.filter((asset) => asset.type === 'AUDIO').length,
  };
}

export class DirectorContextService {
  constructor(
    private readonly source: DirectorContextSourceLike = new FirestoreDirectorContextSource(),
    private readonly assets: DirectorAssetRepositoryLike = directorAssetRepository,
    private readonly assetSync: AssetRegistrySyncServiceLike = assetRegistrySyncService,
  ) {}

  public isAvailable(): boolean {
    return this.source.isAvailable();
  }

  public async getDirectorContext(projectIdInput: string): Promise<DirectorContext> {
    const projectId = clean(projectIdInput);
    if (!projectId) {
      throw contextError('DIRECTOR_PROJECT_ID_REQUIRED', 'projectId 不能为空。', 400);
    }
    return this.buildContext(projectId);
  }

  public async getEpisodeContext(projectIdInput: string, episodeIdInput: string): Promise<DirectorContext> {
    const projectId = clean(projectIdInput);
    const episodeId = clean(episodeIdInput);
    if (!projectId) {
      throw contextError('DIRECTOR_PROJECT_ID_REQUIRED', 'projectId 不能为空。', 400);
    }
    if (!episodeId) {
      throw contextError('DIRECTOR_EPISODE_ID_REQUIRED', 'episodeId 不能为空。', 400);
    }
    return this.buildContext(projectId, episodeId);
  }

  public async getShotContext(shotUidInput: string): Promise<DirectorShotContext> {
    const shotUid = clean(shotUidInput);
    if (!shotUid) {
      throw contextError('DIRECTOR_SHOT_UID_REQUIRED', 'shotUid 不能为空。', 400);
    }
    if (!this.source.isAvailable()) {
      throw contextError('DIRECTOR_CONTEXT_STORAGE_UNAVAILABLE', 'Director Context Firestore 当前不可用。', 503);
    }

    const location = await this.source.findShotLocation(shotUid);
    if (!location) {
      throw contextError('DIRECTOR_SHOT_NOT_FOUND', `找不到 Shot ${shotUid}。`, 404);
    }

    const context = await this.buildContext(location.projectId, location.episodeId);
    const shot = context.shots.find((item) => item.shotUid === shotUid);
    if (!shot) {
      throw contextError('DIRECTOR_SHOT_NOT_FOUND', `找不到 Shot ${shotUid}。`, 404);
    }
    return {
      ...shot,
      projectId: location.projectId,
      episodeId: location.episodeId,
      purpose: shot.storyPurpose,
    };
  }

  private async buildContext(projectId: string, episodeId?: string): Promise<DirectorContext> {
    if (!this.source.isAvailable()) {
      throw contextError('DIRECTOR_CONTEXT_STORAGE_UNAVAILABLE', 'Director Context Firestore 当前不可用。', 503);
    }

    const bundle = await this.source.getRestoreBundle(projectId, episodeId);
    if (!bundle) {
      throw contextError('DIRECTOR_PROJECT_NOT_FOUND', '找不到指定 Director 项目或 Episode。', 404);
    }

    const registryAssets = await this.loadAssets(projectId, episodeId || clean(bundle.episode?.episodeId));
    const contextAssets = registryAssets
      .filter((asset) => asset.status !== 'DELETED')
      .map(buildAsset);
    const assetsByShot = new Map<string, DirectorContextAsset[]>();
    for (const asset of contextAssets) {
      const list = assetsByShot.get(asset.shotUid) || [];
      list.push(asset);
      assetsByShot.set(asset.shotUid, list);
    }

    const shots = bundle.shots
      .map((shot, index) => buildShot(shot, index, assetsByShot))
      .filter((shot): shot is DirectorContextShot => Boolean(shot))
      .sort((left, right) => left.order - right.order);

    return {
      schema: DIRECTOR_CONTEXT_SCHEMA,
      project: buildProject(bundle, projectId),
      episode: buildEpisode(bundle, episodeId),
      shots,
      assetSummary: buildAssetSummary(contextAssets),
    };
  }

  private async loadAssets(projectId: string, episodeId: string): Promise<DirectorAssetRecord[]> {
    // Existing Director Cloud records predate Asset Registry. Project Context
    // triggers the same best-effort projection as Asset Library, but never lets
    // Registry availability determine whether the AI context can be read.
    try {
      await this.assetSync.syncProjectAssets(projectId, episodeId || undefined);
    } catch (error) {
      console.warn('[Director Context] Asset Registry projection skipped:', error instanceof Error ? error.message : String(error));
    }

    if (!this.assets.isAvailable()) return [];
    try {
      return await this.assets.listAssets({ projectId, episodeId: episodeId || undefined });
    } catch (error) {
      console.warn('[Director Context] Asset Registry read skipped:', error instanceof Error ? error.message : String(error));
      return [];
    }
  }
}

export const directorContextService = new DirectorContextService();

export { FirestoreDirectorContextSource };
