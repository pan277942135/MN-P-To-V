import type {
  DirectorAssetPreview,
  DirectorAssetPreviewResponse,
  DirectorAssetPreviewStatus,
  DirectorAssetRecord,
} from '../../../services/assetRegistry/assetRegistryTypes';
import {
  directorAssetRepository,
  type DirectorAssetRepositoryLike,
} from '../../repositories/directorAssetRepository';
import {
  directorGcsStore,
  type DirectorPreviewVariant,
} from '../../storage/directorGcsStore';
import {
  ImagePreviewService,
  type ImagePreviewGeneratorLike,
  type ImagePreviewGenerationResult,
} from './imagePreviewService';
import {
  VideoPreviewService,
  type VideoPreviewGeneratorLike,
  type VideoPreviewGenerationResult,
} from './videoPreviewService';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

type PreviewContentVariant = DirectorPreviewVariant | 'original';

function contentUrl(assetId: string, variant: PreviewContentVariant, frameIndex?: number): string {
  const base = `/api/director/assets/${encodeURIComponent(assetId)}/preview/content/${variant}`;
  return variant === 'frame' && frameIndex ? `${base}/${frameIndex}` : base;
}

function pathUrl(
  assetId: string,
  variant: PreviewContentVariant,
  pathValue: unknown,
  frameIndex?: number,
): string {
  const path = clean(pathValue);
  if (/^https?:\/\//i.test(path) || path.startsWith('/')) return path;
  return contentUrl(assetId, variant, frameIndex);
}

export function createPendingAssetPreview(asset: DirectorAssetRecord): DirectorAssetPreview {
  return {
    status: 'PENDING',
    generatedAt: '',
    thumbnailPath: '',
    previewPath: '',
    mediumPreviewPath: '',
    videoPreviewPath: '',
    framePaths: [],
    width: numberOrZero(asset.metadata.width),
    height: numberOrZero(asset.metadata.height),
    durationSeconds: numberOrZero(asset.metadata.durationSeconds),
  };
}

const emptyPreview = createPendingAssetPreview;

function statusOf(preview: DirectorAssetPreview | undefined): DirectorAssetPreviewStatus {
  return preview?.status || 'PENDING';
}

/**
 * Converts private GCS object paths into same-origin gateway URLs. AI agents
 * and the browser can consume these URLs without receiving bucket credentials.
 */
export function describeDirectorAssetPreview(asset: DirectorAssetRecord): DirectorAssetPreviewResponse {
  const stored = asset.preview || emptyPreview(asset);
  const thumbnailPath = stored.thumbnailPath || (asset.assetType === 'IMAGE' ? asset.storage.thumbnailPath : '');
  const mediumPath = stored.mediumPreviewPath || (asset.assetType === 'IMAGE' ? stored.previewPath : '');
  const videoPath = stored.videoPreviewPath || (asset.assetType === 'VIDEO' ? stored.previewPath : '');
  const thumbnailUrl = asset.assetType === 'IMAGE'
    ? pathUrl(asset.assetId, 'thumbnail', thumbnailPath)
    : asset.assetType === 'VIDEO' && thumbnailPath
      ? pathUrl(asset.assetId, 'thumbnail', thumbnailPath)
      : '';
  const mediumUrl = asset.assetType === 'IMAGE'
    ? pathUrl(asset.assetId, 'medium', mediumPath)
    : '';
  const videoPreviewUrl = asset.assetType === 'VIDEO'
    ? pathUrl(asset.assetId, 'video-preview', videoPath)
    : '';
  const frameUrls = (stored.framePaths || []).map((_, index) => contentUrl(asset.assetId, 'frame', index + 1));
  const audioUrl = asset.assetType === 'AUDIO'
    ? contentUrl(asset.assetId, 'original')
    : '';

  return {
    assetId: asset.assetId,
    preview: {
      status: statusOf(asset.preview),
      generatedAt: clean(stored.generatedAt),
      thumbnailUrl,
      mediumUrl,
      videoUrl: videoPreviewUrl,
      videoPreviewUrl,
      frames: frameUrls,
      frameUrls,
      audioUrl,
      width: numberOrZero(stored.width || asset.metadata.width),
      height: numberOrZero(stored.height || asset.metadata.height),
      durationSeconds: numberOrZero(stored.durationSeconds || asset.metadata.durationSeconds),
      ...(clean(stored.error) ? { error: clean(stored.error) } : {}),
    },
  };
}

export interface AssetPreviewGatewayLike {
  describeAssetPreview(asset: DirectorAssetRecord): DirectorAssetPreviewResponse;
  enqueueAssetPreview(asset: DirectorAssetRecord): boolean;
  enqueueProjectPreviews(assets: DirectorAssetRecord[]): number;
  generateAssetPreview(asset: DirectorAssetRecord): Promise<DirectorAssetPreview>;
}

function generatedPreview(
  output: ImagePreviewGenerationResult | VideoPreviewGenerationResult | null,
  asset: DirectorAssetRecord,
): DirectorAssetPreview {
  const base = emptyPreview(asset);
  return {
    ...base,
    ...(output || {}),
    status: 'READY',
    generatedAt: new Date().toISOString(),
    sourcePath: clean(asset.storage.path),
  };
}

function processingPreview(asset: DirectorAssetRecord): DirectorAssetPreview {
  const current = asset.preview || emptyPreview(asset);
  return {
    ...current,
    status: 'PROCESSING',
    error: '',
    sourcePath: clean(asset.storage.path),
  };
}

export class AssetPreviewService implements AssetPreviewGatewayLike {
  private readonly pending = new Map<string, DirectorAssetRecord>();
  private readonly active = new Set<string>();
  private readonly jobs = new Map<string, Promise<unknown>>();
  private readonly concurrency: number;

  constructor(
    private readonly repository: DirectorAssetRepositoryLike = directorAssetRepository,
    private readonly imageService: ImagePreviewGeneratorLike = new ImagePreviewService(),
    private readonly videoService: VideoPreviewGeneratorLike = new VideoPreviewService(),
    concurrency = 2,
  ) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
  }

  public describeAssetPreview(asset: DirectorAssetRecord): DirectorAssetPreviewResponse {
    return describeDirectorAssetPreview(asset);
  }

  public enqueueAssetPreview(asset: DirectorAssetRecord): boolean {
    if (!asset.assetId || asset.status === 'DELETED') return false;
    // Treat an already queued job as queued for batch API accounting. The
    // registry may have scheduled the same asset moments earlier.
    if (this.pending.has(asset.assetId) || this.active.has(asset.assetId)) return true;
    if (asset.preview?.status === 'READY' && asset.preview.sourcePath === clean(asset.storage.path)) return false;

    this.pending.set(asset.assetId, asset);
    void this.repository.updateAsset(asset.assetId, { preview: processingPreview(asset) }).catch((error) => {
      console.warn(`[Asset Preview] processing marker skipped for ${asset.assetId}:`, error instanceof Error ? error.message : String(error));
    });
    this.drain();
    return true;
  }

  public enqueueProjectPreviews(assets: DirectorAssetRecord[]): number {
    const candidates = assets.filter((asset) => asset.status !== 'DELETED');
    return candidates.reduce((queued, asset) => queued + (this.enqueueAssetPreview(asset) ? 1 : 0), 0);
  }

  private drain(): void {
    while (this.active.size < this.concurrency && this.pending.size > 0) {
      const next = this.pending.entries().next().value as [string, DirectorAssetRecord] | undefined;
      if (!next) return;
      const [assetId, asset] = next;
      this.pending.delete(assetId);
      this.active.add(assetId);
      const job = this.generateAssetPreview(asset)
        .catch((error) => {
          console.warn(`[Asset Preview] generation skipped for ${assetId}:`, error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          this.active.delete(assetId);
          this.jobs.delete(assetId);
          this.drain();
        });
      this.jobs.set(assetId, job);
    }
  }

  public async generateAssetPreview(assetInput: DirectorAssetRecord): Promise<DirectorAssetPreview> {
    const asset = await this.repository.getAsset(assetInput.assetId) || assetInput;
    if (asset.status === 'DELETED') return asset.preview || emptyPreview(asset);
    if (asset.preview?.status === 'READY' && asset.preview.sourcePath === clean(asset.storage.path)) {
      return asset.preview;
    }

    const processing = processingPreview(asset);
    await this.repository.updateAsset(asset.assetId, { preview: processing });
    try {
      let output: ImagePreviewGenerationResult | VideoPreviewGenerationResult | null = null;
      if (asset.assetType === 'IMAGE') {
        output = await this.imageService.generate(asset);
      } else if (asset.assetType === 'VIDEO') {
        output = await this.videoService.generate(asset);
      } else {
        // Audio/text/model assets do not need derived visual files to be
        // consumable. They are marked READY and continue to use the original
        // gateway source URL; image/video assets always take the generators.
        output = null;
      }

      const ready = generatedPreview(output, asset);
      const updated = await this.repository.updateAsset(asset.assetId, { preview: ready });
      return updated?.preview || ready;
    } catch (error) {
      const failed: DirectorAssetPreview = {
        ...processing,
        status: 'FAILED',
        generatedAt: new Date().toISOString(),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      };
      // Preview is deliberately non-blocking. Even when this update fails, the
      // production Asset Registry record remains ACTIVE and the original path
      // is untouched.
      await this.repository.updateAsset(asset.assetId, { preview: failed }).catch((updateError) => {
        console.warn(`[Asset Preview] failed marker skipped for ${asset.assetId}:`, updateError instanceof Error ? updateError.message : String(updateError));
      });
      return failed;
    }
  }

  /** Test/maintenance hook; normal production callers use the non-blocking queue. */
  public async waitForIdle(): Promise<void> {
    while (this.pending.size > 0 || this.active.size > 0 || this.jobs.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

export const assetPreviewService = new AssetPreviewService();
