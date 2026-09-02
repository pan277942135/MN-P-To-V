import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import {
  AI_DIRECTOR_CONTEXT_SCHEMA,
  type AiAssetPreview,
  type AiAssetPreviewResponse,
  type AiDirectorAsset,
  type AiDirectorContext,
  type AiDirectorEpisode,
  type AiDirectorProject,
  type AiDirectorShot,
  type AiDirectorScope,
  type AiReviewPackageFile,
  type AiReviewPackageResponse,
} from '../../../services/aiDirector/aiDirectorTypes';
import type {
  DirectorAssetMetadata,
  DirectorAssetPreviewStatus,
  DirectorAssetRecord,
} from '../../../services/assetRegistry/assetRegistryTypes';
import type {
  DirectorContext,
  DirectorShotContext,
} from '../../../services/directorContext/directorContextTypes';
import { calculateAspectRatio } from '../../../services/formatPolicy/formatPolicy';
import {
  directorAssetRepository,
  type DirectorAssetRepositoryLike,
} from '../../repositories/directorAssetRepository';
import {
  assetRegistrySyncService,
  type AssetRegistrySyncServiceLike,
} from '../assetRegistry/assetRegistrySyncService';
import {
  directorContextService,
} from '../directorContext/directorContextService';
import {
  aiDirectorStorage,
  AiDirectorStorageError,
  resolveAiObjectRef,
  type AiDirectorStorageLike,
  type AiObjectRef,
} from '../../storage/aiDirectorStorage';

const AI_SIGNED_URL_TTL_SECONDS = 15 * 60;
const MAX_CONTACT_SHEET_IMAGES = 500;
const CONTACT_SHEET_TILE_WIDTH = 240;
const CONTACT_SHEET_TILE_HEIGHT = 180;
const CONTACT_SHEET_COLUMNS = 5;

export interface AiDirectorContextSourceLike {
  getProjectContexts(projectId: string): Promise<DirectorContext[]>;
  getShotContext(shotUid: string): Promise<DirectorShotContext>;
}

export class AiDirectorServiceError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly reason?: string;

  constructor(code: string, message: string, statusCode: number, reason?: string) {
    super(message);
    this.name = 'AiDirectorServiceError';
    this.code = code;
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeSegment(value: string): string {
  return clean(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function metadataFor(asset: DirectorAssetRecord): AiDirectorAsset['metadata'] {
  const metadata: DirectorAssetMetadata = asset.metadata;
  const width = numberOrZero(metadata.width);
  const height = numberOrZero(metadata.height);
  const aspectRatio = clean(metadata.aspectRatio) || calculateAspectRatio(width, height);
  return {
    width,
    height,
    aspectRatio,
    ratio: aspectRatio,
    durationSeconds: numberOrZero(metadata.durationSeconds),
    fileSize: numberOrZero(metadata.fileSize),
    mimeType: clean(metadata.mimeType),
  };
}

function previewStatus(asset: DirectorAssetRecord): DirectorAssetPreviewStatus {
  return asset.preview?.status || 'PENDING';
}

function activeAssets(assets: DirectorAssetRecord[]): DirectorAssetRecord[] {
  return assets.filter((asset) => asset.status !== 'DELETED');
}

function sourceObject(asset: DirectorAssetRecord, value: unknown): AiObjectRef | null {
  return resolveAiObjectRef(value, clean(asset.storage.bucket));
}

function projectPackagePrefix(projectId: string, packageId: string): string {
  return path.posix.join(
    'projects',
    safeSegment(projectId),
    'review_package',
    safeSegment(packageId),
  );
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

function extensionForMime(mimeType: string, fallback: string): string {
  const normalized = clean(mimeType).toLowerCase();
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('gif')) return '.gif';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg';
  if (normalized.includes('webm')) return '.webm';
  if (normalized.includes('quicktime')) return '.mov';
  if (normalized.includes('mpeg') || normalized.includes('mp4')) return '.mp4';
  return fallback;
}

function publicPreviewFile(pathValue: string, url: string, contentType: string): AiReviewPackageFile {
  return { path: pathValue, url, contentType };
}

export class AiDirectorService {
  constructor(
    private readonly contextSource: AiDirectorContextSourceLike = directorContextService,
    private readonly assets: DirectorAssetRepositoryLike = directorAssetRepository,
    private readonly assetSync: AssetRegistrySyncServiceLike = assetRegistrySyncService,
    private readonly storage: AiDirectorStorageLike = aiDirectorStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public async getProjectContext(projectIdInput: string, scopes: AiDirectorScope[]): Promise<AiDirectorContext> {
    const projectId = clean(projectIdInput);
    if (!projectId) throw new AiDirectorServiceError('AI_PROJECT_ID_REQUIRED', 'projectId 不能为空。', 400);
    let contexts: DirectorContext[];
    try {
      contexts = await this.contextSource.getProjectContexts(projectId);
    } catch (error: any) {
      if (Number(error?.statusCode || error?.status) >= 400) throw error;
      throw new AiDirectorServiceError('AI_PROJECT_CONTEXT_FAILED', '读取 AI 项目上下文失败。', 503);
    }
    if (!contexts.length) {
      throw new AiDirectorServiceError('AI_PROJECT_NOT_FOUND', '找不到指定 Director 项目。', 404);
    }
    const registryAssets = await this.loadAssets(projectId);
    return this.composeProjectContext(projectId, contexts, registryAssets, scopes);
  }

  public async getShotContext(
    projectIdInput: string,
    shotUidInput: string,
    scopes: AiDirectorScope[],
  ): Promise<AiDirectorShot & { purpose: string }> {
    const projectId = clean(projectIdInput);
    const shotUid = clean(shotUidInput);
    if (!projectId) throw new AiDirectorServiceError('AI_PROJECT_ID_REQUIRED', 'projectId 不能为空。', 400);
    if (!shotUid) throw new AiDirectorServiceError('AI_SHOT_UID_REQUIRED', 'shotUid 不能为空。', 400);

    let sourceShot: DirectorShotContext;
    try {
      sourceShot = await this.contextSource.getShotContext(shotUid);
    } catch (error: any) {
      if (Number(error?.statusCode || error?.status) >= 400) throw error;
      throw new AiDirectorServiceError('AI_SHOT_CONTEXT_FAILED', '读取 AI Shot 上下文失败。', 503);
    }
    if (sourceShot.projectId !== projectId) {
      throw new AiDirectorServiceError('AI_PROJECT_ACCESS_DENIED', 'Token 无权读取该项目的 Shot。', 403);
    }

    const registryAssets = await this.loadAssets(projectId, sourceShot.episodeId, shotUid);
    const shotAssets = activeAssets(registryAssets)
      .filter((asset) => asset.episodeId === sourceShot.episodeId && asset.shotUid === shotUid);
    const assets = await Promise.all(shotAssets.map((asset) => this.toAiAsset(asset, scopes)));
    const blueprint = sourceShot.blueprint || {};
    return {
      projectId,
      episodeId: sourceShot.episodeId,
      shotUid: sourceShot.shotUid,
      order: sourceShot.order,
      title: sourceShot.title,
      storyPurpose: sourceShot.storyPurpose,
      purpose: sourceShot.storyPurpose,
      visualRequirement: sourceShot.visualDescription,
      camera: sourceShot.camera,
      action: sourceShot.action,
      dialogue: sourceShot.dialogue,
      status: sourceShot.status,
      ...(sourceShot.storyboard ? { storyboard: sourceShot.storyboard } : {}),
      ...(sourceShot.formatPolicy ? { formatPolicy: sourceShot.formatPolicy } : {}),
      blueprint,
      ...(sourceShot.videoBlueprint ? { videoBlueprint: sourceShot.videoBlueprint } : {}),
      assets,
    };
  }

  public async getAssetPreview(projectIdInput: string, assetIdInput: string): Promise<AiAssetPreviewResponse> {
    const projectId = clean(projectIdInput);
    const assetId = clean(assetIdInput);
    if (!projectId) throw new AiDirectorServiceError('AI_PROJECT_ID_REQUIRED', 'projectId 不能为空。', 400);
    if (!assetId) throw new AiDirectorServiceError('AI_ASSET_ID_REQUIRED', 'assetId 不能为空。', 400);
    if (!this.assets.isAvailable()) {
      throw new AiDirectorServiceError('AI_ASSET_STORAGE_UNAVAILABLE', 'Asset Registry 当前不可用。', 503);
    }

    let asset: DirectorAssetRecord | null;
    try {
      asset = await this.assets.getAsset(assetId);
    } catch {
      throw new AiDirectorServiceError('AI_ASSET_READ_FAILED', '读取 Asset Registry 失败。', 503);
    }
    if (!asset || asset.status === 'DELETED') {
      throw new AiDirectorServiceError('AI_ASSET_NOT_FOUND', '找不到指定资产。', 404);
    }
    if (asset.projectId !== projectId) {
      throw new AiDirectorServiceError('AI_PROJECT_ACCESS_DENIED', 'Token 无权读取该项目的资产。', 403);
    }

    return {
      assetId,
      type: asset.assetType,
      preview: await this.signedPreview(asset),
    };
  }

  public async generateReviewPackage(
    projectIdInput: string,
    scopes: AiDirectorScope[],
  ): Promise<AiReviewPackageResponse> {
    const projectId = clean(projectIdInput);
    if (!projectId) throw new AiDirectorServiceError('AI_PROJECT_ID_REQUIRED', 'projectId 不能为空。', 400);

    const context = await this.getProjectContext(projectId, scopes);
    const packageId = `pkg_${crypto.randomUUID()}`;
    const generatedAt = new Date(this.now()).toISOString();
    const expiresAtDate = new Date(this.now() + AI_SIGNED_URL_TTL_SECONDS * 1000);
    const expiresAt = expiresAtDate.toISOString();
    const prefix = projectPackagePrefix(projectId, packageId);
    const packageAssets = context.assets;
    const packageSourceAssets = await this.loadAssets(projectId);
    const rawAssetsById = new Map(packageSourceAssets.map((asset) => [asset.assetId, asset]));
    const imagePreviews: AiReviewPackageFile[] = [];
    const videoPreviews: AiReviewPackageFile[] = [];

    const projectFile = await this.putPackageJson(prefix, 'project.json', context.project, expiresAtDate);
    const contextFile = await this.putPackageJson(prefix, 'context.json', context, expiresAtDate);

    const hasPreviewScope = scopes.includes('preview');
    const previewAssets = hasPreviewScope ? packageAssets : [];
    for (const asset of previewAssets) {
      try {
        if (asset.type === 'IMAGE') {
          const stored = await this.copyImagePreview(prefix, asset, expiresAtDate, rawAssetsById.get(asset.assetId));
          if (stored) imagePreviews.push(stored);
        } else if (asset.type === 'VIDEO') {
          const stored = await this.copyVideoPreview(prefix, asset, expiresAtDate, rawAssetsById.get(asset.assetId));
          if (stored) videoPreviews.push(stored);
        }
      } catch (error) {
        // A package remains useful when one derived preview is unavailable.
        // The registry and the original asset are never modified here.
        console.warn(`[AI Review Package] preview skipped for ${asset.assetId}:`, error instanceof Error ? error.message : String(error));
      }
    }

    const manifestAssets = packageAssets.map((asset) => {
      const packagePreview = [...imagePreviews, ...videoPreviews]
        .find((preview) => preview.path.includes(`/${safeSegment(asset.assetId)}.`));
      return {
        assetId: asset.assetId,
        shotUid: asset.shotUid,
        type: asset.type,
        previewUrl: packagePreview?.url || '',
        metadata: {
          width: asset.metadata.width,
          height: asset.metadata.height,
          ratio: asset.metadata.ratio,
          durationSeconds: asset.metadata.durationSeconds,
          mimeType: asset.metadata.mimeType,
        },
      };
    });
    const manifestFile = await this.putPackageJson(prefix, 'asset_manifest.json', {
      projectId,
      generatedAt,
      assets: manifestAssets,
    }, expiresAtDate);

    const contactSheet = await this.buildContactSheet(hasPreviewScope
      ? packageAssets.filter((asset) => asset.type === 'IMAGE')
      : [], rawAssetsById);
    const contactSheetObject = await this.storage.putObject({
      objectPath: path.posix.join(prefix, 'contact_sheet.jpg'),
      buffer: contactSheet,
      mimeType: 'image/jpeg',
    });
    const contactSheetFile = publicPreviewFile(
      'contact_sheet.jpg',
      await this.storage.getSignedUrl(contactSheetObject, expiresAtDate),
      'image/jpeg',
    );

    return {
      packageId,
      projectId,
      generatedAt,
      expiresAt,
      files: {
        project: projectFile,
        context: contextFile,
        assetManifest: manifestFile,
        contactSheet: contactSheetFile,
        imagePreviews,
        videoPreviews,
      },
      assetCount: packageAssets.length,
      previewCount: imagePreviews.length + videoPreviews.length,
    };
  }

  private composeProjectContext(
    projectId: string,
    contexts: DirectorContext[],
    registryAssets: DirectorAssetRecord[],
    scopes: AiDirectorScope[],
  ): Promise<AiDirectorContext> {
    const assets = activeAssets(registryAssets);
    const first = contexts[0];
    const project: AiDirectorProject = {
      projectId,
      title: first.project.title,
      creativeBrief: first.project.creativeBrief,
      targetFormat: first.project.targetFormat,
      aspectRatio: first.project.aspectRatio,
      formatPolicy: first.project.formatPolicy,
    };
    const episodes: AiDirectorEpisode[] = contexts
      .map((context) => ({
        episodeId: context.episode.episodeId,
        title: context.episode.title,
        summary: context.episode.summary,
        status: context.episode.status,
      }))
      .filter((episode) => episode.episodeId);
    const shots = contexts.flatMap((context) => context.shots.map((shot) => ({
      projectId,
      episodeId: context.episode.episodeId,
      shotUid: shot.shotUid,
      order: shot.order,
      title: shot.title,
      storyPurpose: shot.storyPurpose,
      visualRequirement: shot.visualDescription,
      camera: shot.camera,
      action: shot.action,
      dialogue: shot.dialogue,
      status: shot.status,
      ...(shot.storyboard ? { storyboard: shot.storyboard } : {}),
      ...(shot.formatPolicy ? { formatPolicy: shot.formatPolicy } : {}),
      blueprint: shot.blueprint || {},
      ...(shot.videoBlueprint ? { videoBlueprint: shot.videoBlueprint } : {}),
      assets: [],
    })));
    return Promise.all(assets.map((asset) => this.toAiAsset(asset, scopes))).then((aiAssets) => {
      const assetsByShot = new Map<string, AiDirectorAsset[]>();
      for (const asset of aiAssets) {
        const key = `${asset.episodeId}:${asset.shotUid}`;
        const list = assetsByShot.get(key) || [];
        list.push(asset);
        assetsByShot.set(key, list);
      }
      return {
        schema: AI_DIRECTOR_CONTEXT_SCHEMA,
        project,
        episodes,
        shots: shots.map((shot) => ({
          ...shot,
          assets: assetsByShot.get(`${shot.episodeId}:${shot.shotUid}`) || [],
        })),
        assets: aiAssets,
        assetSummary: {
          total: aiAssets.length,
          images: aiAssets.filter((asset) => asset.type === 'IMAGE').length,
          videos: aiAssets.filter((asset) => asset.type === 'VIDEO').length,
          audio: aiAssets.filter((asset) => asset.type === 'AUDIO').length,
        },
      };
    });
  }

  private async loadAssets(projectId: string, episodeId?: string, shotUid?: string): Promise<DirectorAssetRecord[]> {
    try {
      await this.assetSync.syncProjectAssets(projectId, episodeId || undefined);
    } catch (error) {
      console.warn('[AI Director] Asset Registry projection skipped:', error instanceof Error ? error.message : String(error));
    }
    if (!this.assets.isAvailable()) return [];
    try {
      if (shotUid) return await this.assets.listShotAssets(shotUid, projectId);
      return await this.assets.listAssets({ projectId, episodeId: episodeId || undefined });
    } catch (error) {
      console.warn('[AI Director] Asset Registry read skipped:', error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  private async toAiAsset(asset: DirectorAssetRecord, scopes: AiDirectorScope[]): Promise<AiDirectorAsset> {
    const result: AiDirectorAsset = {
      assetId: asset.assetId,
      projectId: asset.projectId,
      episodeId: asset.episodeId,
      shotUid: asset.shotUid,
      type: asset.assetType,
      mediaType: asset.mediaType,
      status: asset.status,
      metadata: metadataFor(asset),
      review: asset.review,
      sourceType: asset.source.type,
      relations: asset.relations,
    };
    if (scopes.includes('preview')) result.preview = await this.signedPreview(asset);
    return result;
  }

  private async signedPreview(asset: DirectorAssetRecord): Promise<AiAssetPreview> {
    const expiresAt = new Date(this.now() + AI_SIGNED_URL_TTL_SECONDS * 1000);
    const stored = asset.preview;
    const original = clean(asset.storage.path);
    const thumbnailPath = clean(stored?.thumbnailPath)
      || clean(asset.storage.thumbnailPath)
      || (asset.assetType === 'IMAGE' ? original : '');
    const mediumPath = clean(stored?.mediumPreviewPath)
      || clean(stored?.previewPath)
      || clean(asset.storage.previewPath)
      || (asset.assetType === 'IMAGE' ? original : '');
    const videoPath = clean(stored?.videoPreviewPath)
      || clean(stored?.previewPath)
      || clean(asset.storage.previewPath)
      || (asset.assetType === 'VIDEO' ? original : '');
    const framePaths = (stored?.framePaths || []).map(clean).filter(Boolean);
    const fallbackBucket = clean(asset.storage.bucket) || this.safeStorageBucket();
    const [thumbnailUrl, mediumUrl, videoUrl, frames, audioUrl] = await Promise.all([
      asset.assetType === 'IMAGE' || (asset.assetType === 'VIDEO' && Boolean(thumbnailPath))
        ? this.signOptional(thumbnailPath, fallbackBucket, expiresAt)
        : Promise.resolve(''),
      asset.assetType === 'IMAGE' ? this.signOptional(mediumPath, fallbackBucket, expiresAt) : Promise.resolve(''),
      asset.assetType === 'VIDEO' ? this.signOptional(videoPath, fallbackBucket, expiresAt) : Promise.resolve(''),
      Promise.all(framePaths.map((framePath) => this.signOptional(framePath, fallbackBucket, expiresAt))),
      asset.assetType === 'AUDIO' ? this.signOptional(original, fallbackBucket, expiresAt) : Promise.resolve(''),
    ]);
    return {
      status: previewStatus(asset),
      expiresAt: expiresAt.toISOString(),
      thumbnailUrl,
      mediumUrl,
      videoUrl,
      videoPreviewUrl: videoUrl,
      frames,
      frameUrls: frames,
      audioUrl,
    };
  }

  private safeStorageBucket(): string {
    try {
      return clean(this.storage.bucketName());
    } catch {
      return '';
    }
  }

  private async signOptional(value: string, fallbackBucket: string, expiresAt: Date): Promise<string> {
    if (!value) return '';
    const ref = resolveAiObjectRef(value, fallbackBucket);
    if (!ref) {
      throw new AiDirectorServiceError('AI_PREVIEW_PATH_INVALID', '资产预览位置不是受支持的 GCS 对象。', 502);
    }
    try {
      return await this.storage.getSignedUrl(ref, expiresAt);
    } catch (error: any) {
      const reason = error instanceof AiDirectorStorageError ? error.errorCode : 'SIGNING_CONFIG_ERROR';
      throw new AiDirectorServiceError('AI_PREVIEW_SIGNING_FAILED', '生成资产 Signed URL 失败。', 503, reason);
    }
  }

  private async putPackageJson(
    prefix: string,
    filename: string,
    payload: unknown,
    expiresAt: Date,
  ): Promise<AiReviewPackageFile> {
    const objectPath = path.posix.join(prefix, filename);
    const object = await this.storage.putObject({
      objectPath,
      buffer: jsonBuffer(payload),
      mimeType: 'application/json',
    });
    return publicPreviewFile(
      filename,
      await this.storage.getSignedUrl(object, expiresAt),
      'application/json',
    );
  }

  private async readAssetObject(asset: AiDirectorAsset, rawAssetInput?: DirectorAssetRecord): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const rawAsset = rawAssetInput || await this.assets.getAsset(asset.assetId);
    if (!rawAsset) return null;
    const stored = rawAsset.preview;
    const candidates = rawAsset.assetType === 'IMAGE'
      ? [stored?.mediumPreviewPath, stored?.previewPath, rawAsset.storage.previewPath, rawAsset.storage.path]
      : [stored?.videoPreviewPath, stored?.previewPath, rawAsset.storage.previewPath, rawAsset.storage.path];
    const fallbackBucket = clean(rawAsset.storage.bucket) || this.safeStorageBucket();
    for (const candidate of candidates.map(clean).filter(Boolean)) {
      const ref = sourceObject(rawAsset, candidate) || resolveAiObjectRef(candidate, fallbackBucket);
      if (!ref) continue;
      try {
        return await this.storage.getObject(ref);
      } catch {
        // Try the next derived/original location. A missing preview should not
        // make a package impossible to produce.
      }
    }
    return null;
  }

  private async copyImagePreview(
    prefix: string,
    asset: AiDirectorAsset,
    expiresAt: Date,
    rawAsset?: DirectorAssetRecord,
  ): Promise<AiReviewPackageFile | null> {
    const source = await this.readAssetObject(asset, rawAsset);
    if (!source?.buffer?.length) return null;
    const buffer = await sharp(source.buffer).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    const objectPath = path.posix.join(prefix, 'previews', 'images', `${safeSegment(asset.assetId)}.jpg`);
    const object = await this.storage.putObject({ objectPath, buffer, mimeType: 'image/jpeg' });
    return publicPreviewFile(
      path.posix.join('previews', 'images', `${safeSegment(asset.assetId)}.jpg`),
      await this.storage.getSignedUrl(object, expiresAt),
      'image/jpeg',
    );
  }

  private async copyVideoPreview(
    prefix: string,
    asset: AiDirectorAsset,
    expiresAt: Date,
    rawAsset?: DirectorAssetRecord,
  ): Promise<AiReviewPackageFile | null> {
    const source = await this.readAssetObject(asset, rawAsset);
    if (!source?.buffer?.length) return null;
    const extension = extensionForMime(source.mimeType || asset.metadata.mimeType, '.mp4');
    const objectPath = path.posix.join(prefix, 'previews', 'videos', `${safeSegment(asset.assetId)}${extension}`);
    const object = await this.storage.putObject({ objectPath, buffer: source.buffer, mimeType: source.mimeType || 'video/mp4' });
    return publicPreviewFile(
      path.posix.join('previews', 'videos', `${safeSegment(asset.assetId)}${extension}`),
      await this.storage.getSignedUrl(object, expiresAt),
      source.mimeType || 'video/mp4',
    );
  }

  private async buildContactSheet(assets: AiDirectorAsset[], rawAssetsById = new Map<string, DirectorAssetRecord>()): Promise<Buffer> {
    const tiles: Array<{ assetId: string; buffer: Buffer }> = [];
    for (const asset of assets.slice(0, MAX_CONTACT_SHEET_IMAGES)) {
      try {
        const source = await this.readAssetObject(asset, rawAssetsById.get(asset.assetId));
        if (!source?.buffer?.length) continue;
        const tile = await sharp(source.buffer)
          .resize({ width: CONTACT_SHEET_TILE_WIDTH, height: CONTACT_SHEET_TILE_HEIGHT, fit: 'contain', background: '#111827' })
          .jpeg({ quality: 84, mozjpeg: true })
          .toBuffer();
        tiles.push({ assetId: asset.assetId, buffer: tile });
      } catch {
        // Contact sheets are an optional derived artifact.
      }
    }

    const tileCount = Math.max(1, tiles.length);
    const rows = Math.ceil(tileCount / CONTACT_SHEET_COLUMNS);
    const width = CONTACT_SHEET_COLUMNS * CONTACT_SHEET_TILE_WIDTH;
    const height = rows * CONTACT_SHEET_TILE_HEIGHT;
    const composites = tiles.map((tile, index) => ({
      input: tile.buffer,
      left: (index % CONTACT_SHEET_COLUMNS) * CONTACT_SHEET_TILE_WIDTH,
      top: Math.floor(index / CONTACT_SHEET_COLUMNS) * CONTACT_SHEET_TILE_HEIGHT,
    }));
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: '#111827',
      },
    })
      .composite(composites)
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();
  }
}

export const aiDirectorService = new AiDirectorService();

export { AI_SIGNED_URL_TTL_SECONDS };
