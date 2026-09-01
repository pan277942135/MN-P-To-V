import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import type { DirectorAssetRecord } from '../../../services/assetRegistry/assetRegistryTypes';
import {
  directorGcsStore,
  type DirectorPreviewObjectRef,
} from '../../storage/directorGcsStore';
import type { AssetPreviewObjectStoreLike } from './imagePreviewService';

const execFileAsync = promisify(execFile);
const PREVIEW_SCALE = 'scale=w=640:h=640:force_original_aspect_ratio=decrease';
const FRAME_SCALE = 'scale=w=640:h=640:force_original_aspect_ratio=decrease';

function resolveFfmpegExecutable(): string {
  if (ffmpegPath && existsSync(ffmpegPath)) return ffmpegPath;
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  return 'ffmpeg';
}

export interface FfmpegRunnerLike {
  run(args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const defaultFfmpegRunner: FfmpegRunnerLike = {
  async run(args) {
    const executable = resolveFfmpegExecutable();
    try {
      const result = await execFileAsync(executable, ['-nostdin', ...args], {
        maxBuffer: 8 * 1024 * 1024,
      });
      return {
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
      };
    } catch (error: any) {
      const combined = `${String(error?.stdout || '')}\n${String(error?.stderr || '')}`.trim();
      const wrapped = new Error(combined || error?.message || 'FFmpeg execution failed.');
      (wrapped as any).stdout = error?.stdout;
      (wrapped as any).stderr = error?.stderr;
      throw wrapped;
    }
  },
};

export interface ParsedVideoMetadata {
  width: number;
  height: number;
  durationSeconds: number;
}

export function parseVideoMetadata(log: string): ParsedVideoMetadata {
  const durationMatch = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  const dimensionsMatch = log.match(/\b(\d{2,6})x(\d{2,6})\b/);
  const durationSeconds = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;
  return {
    width: dimensionsMatch ? Number(dimensionsMatch[1]) : 0,
    height: dimensionsMatch ? Number(dimensionsMatch[2]) : 0,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
  };
}

export function previewFrameTimes(durationSeconds: number): number[] {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  if (!duration) return [0, 0, 0, 0, 0];
  const finalTime = duration > 0.1 ? Math.max(0, duration - 0.05) : Math.max(0, duration * 0.99);
  return [0, duration * 0.25, duration * 0.5, duration * 0.75, finalTime];
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sourceObject(asset: DirectorAssetRecord): { bucket: string; objectPath: string } {
  const rawPath = clean(asset.storage.path);
  const match = rawPath.match(/^gs:\/\/([^/]+)\/(.+)$/i);
  return {
    bucket: clean(asset.storage.bucket) || (match ? match[1] : ''),
    objectPath: match ? match[2] : rawPath,
  };
}

function extensionForMime(mimeType: string): string {
  const normalized = clean(mimeType).toLowerCase();
  if (normalized.includes('webm')) return '.webm';
  if (normalized.includes('quicktime')) return '.mov';
  return '.mp4';
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error || 'Preview generation failed.');
  return value.split('\n').map((line) => line.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 500)
    || 'Preview generation failed.';
}

export interface VideoPreviewGenerationResult {
  width: number;
  height: number;
  durationSeconds: number;
  thumbnailPath: string;
  mediumPreviewPath: string;
  previewPath: string;
  videoPreviewPath: string;
  framePaths: string[];
}

export interface VideoPreviewGeneratorLike {
  generate(asset: DirectorAssetRecord): Promise<VideoPreviewGenerationResult>;
}

export class VideoPreviewService implements VideoPreviewGeneratorLike {
  constructor(
    private readonly objectStore: AssetPreviewObjectStoreLike = directorGcsStore,
    private readonly runner: FfmpegRunnerLike = defaultFfmpegRunner,
  ) {}

  async generate(asset: DirectorAssetRecord): Promise<VideoPreviewGenerationResult> {
    const source = sourceObject(asset);
    if (!source.bucket || !source.objectPath) throw new Error('DIRECTOR_PREVIEW_SOURCE_NOT_FOUND');
    const sourceFile = await this.objectStore.getAsset(source);
    if (!sourceFile.buffer?.length) throw new Error('DIRECTOR_PREVIEW_VIDEO_EMPTY');

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zaojing-preview-'));
    const inputPath = path.join(tempDir, `source${extensionForMime(sourceFile.mimeType || asset.metadata.mimeType)}`);
    const outputPath = path.join(tempDir, 'preview.mp4');
    try {
      await writeFile(inputPath, sourceFile.buffer);
      let probeLog = '';
      try {
        const probe = await this.runner.run(['-hide_banner', '-i', inputPath, '-f', 'null', '-']);
        probeLog = `${probe.stderr}\n${probe.stdout}`;
      } catch (error: any) {
        probeLog = `${String(error?.stderr || '')}\n${String(error?.stdout || '')}`;
        // A valid input can still return a non-zero probe status when a stream
        // contains recoverable timestamps; metadata parsing decides whether it
        // is usable instead of hiding the evidence.
        if (!probeLog.trim()) throw error;
      }
      const metadata = parseVideoMetadata(probeLog);
      if (!metadata.width || !metadata.height || !metadata.durationSeconds) {
        throw new Error('DIRECTOR_PREVIEW_VIDEO_METADATA_INVALID');
      }

      await this.runner.run([
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inputPath,
        '-vf',
        PREVIEW_SCALE,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-movflags',
        '+faststart',
        '-pix_fmt',
        'yuv420p',
        '-an',
        outputPath,
      ]);

      const previewBuffer = await readFile(outputPath);
      const videoPreviewRef = await this.objectStore.putPreview({
        projectId: asset.projectId,
        assetId: asset.assetId,
        variant: 'video-preview',
        mimeType: 'video/mp4',
        buffer: previewBuffer,
      });

      const framePaths: string[] = [];
      for (const [index, time] of previewFrameTimes(metadata.durationSeconds).entries()) {
        const framePath = path.join(tempDir, `frame_${String(index + 1).padStart(3, '0')}.jpg`);
        await this.runner.run([
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-ss',
          time.toFixed(3),
          '-i',
          inputPath,
          '-frames:v',
          '1',
          '-vf',
          FRAME_SCALE,
          '-q:v',
          '2',
          framePath,
        ]);
        const frameBuffer = await readFile(framePath);
        const frameRef = await this.objectStore.putPreview({
          projectId: asset.projectId,
          assetId: asset.assetId,
          variant: 'frame',
          frameIndex: index + 1,
          mimeType: 'image/jpeg',
          buffer: frameBuffer,
        });
        framePaths.push(frameRef.objectPath);
      }

      return {
        ...metadata,
        thumbnailPath: framePaths[0] || '',
        mediumPreviewPath: videoPreviewRef.objectPath,
        previewPath: videoPreviewRef.objectPath,
        videoPreviewPath: videoPreviewRef.objectPath,
        framePaths,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export const videoPreviewService = new VideoPreviewService();
