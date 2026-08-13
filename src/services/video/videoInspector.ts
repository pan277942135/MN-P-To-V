import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import ffmpegPath from 'ffmpeg-static';
import { redactSecrets } from '../../utils/redactSecrets';

const execFileAsync = promisify(execFile);

export interface ExtractedVideoFrame {
  timestampSec: number;
  buffer: Buffer;
  mimeType: 'image/jpeg';
}

export interface VideoInspectionResult {
  valid: boolean;
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  extractedFrames: ExtractedVideoFrame[];
  extractedFrameBuffers: Buffer[];
  sampleTimestampsSec: number[];
  issueReason?: string;
}

export interface VideoProbeMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
}

export class VideoInspector {
  static verifyMp4Container(buffer: Buffer): boolean {
    if (!buffer || buffer.length < 100) return false;

    // Check MP4 magic byte signature 'ftyp' at offset 4.
    return buffer.toString('ascii', 4, 8) === 'ftyp';
  }

  /**
   * Parse authoritative metadata emitted by ffmpeg for the real input file.
   * No duration/resolution/fps defaults are allowed here: missing metadata is an error.
   */
  static parseProbeOutput(stderr: string): VideoProbeMetadata {
    const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    if (!durationMatch) {
      throw new Error('video_probe_duration_missing');
    }

    const durationSeconds =
      Number(durationMatch[1]) * 3600 +
      Number(durationMatch[2]) * 60 +
      Number(durationMatch[3]);

    const videoLine = stderr
      .split(/\r?\n/)
      .find((line) => line.includes('Video:'));
    if (!videoLine) {
      throw new Error('video_probe_stream_missing');
    }

    const resolutionMatch = /\b(\d{2,5})x(\d{2,5})\b/.exec(videoLine);
    if (!resolutionMatch) {
      throw new Error('video_probe_resolution_missing');
    }

    const fpsMatch = /(\d+(?:\.\d+)?)\s*(?:fps|tbr)\b/.exec(videoLine);
    if (!fpsMatch) {
      throw new Error('video_probe_fps_missing');
    }

    const width = Number(resolutionMatch[1]);
    const height = Number(resolutionMatch[2]);
    const fps = Number(fpsMatch[1]);

    if (
      !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
      !Number.isFinite(width) || width <= 0 ||
      !Number.isFinite(height) || height <= 0 ||
      !Number.isFinite(fps) || fps <= 0
    ) {
      throw new Error('video_probe_metadata_invalid');
    }

    return { durationSeconds, width, height, fps };
  }

  /**
   * Build six evenly distributed sample timestamps from the real duration.
   * The final sample is moved one frame (or at least 50 ms) before EOS so ffmpeg
   * does not seek beyond the last decodable frame.
   */
  static buildSampleTimestamps(
    durationSeconds: number,
    sampleCount = 6,
    fps = 24
  ): number[] {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
    if (!Number.isInteger(sampleCount) || sampleCount <= 0) return [];
    if (!Number.isFinite(fps) || fps <= 0) return [];

    const frameDuration = 1 / fps;
    const safeEnd = Math.max(0, durationSeconds - Math.max(0.05, frameDuration));
    if (sampleCount === 1 || safeEnd === 0) return [0];

    const timestamps: number[] = [];
    for (let i = 0; i < sampleCount; i++) {
      const t = (safeEnd * i) / (sampleCount - 1);
      timestamps.push(Number(t.toFixed(3)));
    }
    return timestamps;
  }

  private static async probeVideoFile(inputMp4Path: string): Promise<VideoProbeMetadata> {
    if (!ffmpegPath) {
      throw new Error('ffmpeg_binary_unavailable');
    }

    let stderr = '';
    try {
      const result = await execFileAsync(ffmpegPath, ['-hide_banner', '-i', inputMp4Path]);
      stderr = String(result.stderr || '');
    } catch (err: any) {
      // `ffmpeg -i <file>` intentionally exits non-zero when no output is specified,
      // but still emits authoritative stream metadata to stderr.
      stderr = String(err?.stderr || err?.message || '');
    }

    return this.parseProbeOutput(stderr);
  }

  static async inspectAndExtractFrames(videoBuffer: Buffer): Promise<VideoInspectionResult> {
    const sizeBytes = videoBuffer.length;
    const emptyResult = (issueReason: string): VideoInspectionResult => ({
      valid: false,
      sizeBytes,
      durationSeconds: 0,
      width: 0,
      height: 0,
      fps: 0,
      extractedFrames: [],
      extractedFrameBuffers: [],
      sampleTimestampsSec: [],
      issueReason,
    });

    if (sizeBytes < 100 * 1024) {
      return emptyResult('视频文件小于 100KB，属于非完整 MP4 视频');
    }

    if (!this.verifyMp4Container(videoBuffer)) {
      return emptyResult('非合法 MP4 容器标识 (ftyp)');
    }

    if (!ffmpegPath) {
      return emptyResult('ffmpeg_binary_unavailable: 无法执行真实视频元数据与抽帧检查');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaojing_video_'));
    const inputMp4Path = path.join(tempDir, 'input.mp4');
    fs.writeFileSync(inputMp4Path, videoBuffer);

    let metadata: VideoProbeMetadata;
    const extractedFrames: ExtractedVideoFrame[] = [];

    try {
      metadata = await this.probeVideoFile(inputMp4Path);
      const timestamps = this.buildSampleTimestamps(
        metadata.durationSeconds,
        6,
        metadata.fps
      );

      if (timestamps.length !== 6) {
        return {
          valid: false,
          sizeBytes,
          ...metadata,
          extractedFrames: [],
          extractedFrameBuffers: [],
          sampleTimestampsSec: timestamps,
          issueReason: 'video_sampling_plan_invalid: 无法根据真实时长生成 6 个抽帧时间点',
        };
      }

      const failedTimestamps: number[] = [];

      for (let i = 0; i < timestamps.length; i++) {
        const timestampSec = timestamps[i];
        const outFramePath = path.join(tempDir, `frame_${i}.jpg`);

        try {
          await execFileAsync(ffmpegPath, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            timestampSec.toFixed(3),
            '-i',
            inputMp4Path,
            '-frames:v',
            '1',
            '-q:v',
            '2',
            '-y',
            outFramePath,
          ]);

          if (!fs.existsSync(outFramePath)) {
            failedTimestamps.push(timestampSec);
            continue;
          }

          const frameBuffer = fs.readFileSync(outFramePath);
          if (frameBuffer.length === 0) {
            failedTimestamps.push(timestampSec);
            continue;
          }

          extractedFrames.push({
            timestampSec,
            buffer: frameBuffer,
            mimeType: 'image/jpeg',
          });
        } catch (err) {
          console.warn(
            `[VideoInspector] frame extraction failed at ${timestampSec}s:`,
            redactSecrets(err)
          );
          failedTimestamps.push(timestampSec);
        }
      }

      const sampleTimestampsSec = timestamps;
      const extractedFrameBuffers = extractedFrames.map((frame) => frame.buffer);

      // Fail closed. Never synthesize placeholder frames when real extraction fails.
      if (failedTimestamps.length > 0 || extractedFrames.length !== timestamps.length) {
        return {
          valid: false,
          sizeBytes,
          ...metadata,
          extractedFrames,
          extractedFrameBuffers,
          sampleTimestampsSec,
          issueReason: `video_frame_extraction_incomplete: 抽帧失败时间点 ${failedTimestamps.join(', ')}`,
        };
      }

      let identicalCount = 0;
      for (let i = 1; i < extractedFrameBuffers.length; i++) {
        if (extractedFrameBuffers[i].equals(extractedFrameBuffers[i - 1])) {
          identicalCount++;
        }
      }

      if (identicalCount >= extractedFrameBuffers.length - 1) {
        return {
          valid: false,
          sizeBytes,
          ...metadata,
          extractedFrames,
          extractedFrameBuffers,
          sampleTimestampsSec,
          issueReason: '视频所有真实抽帧完全相同（视频流冻结或静态假视频）',
        };
      }

      return {
        valid: true,
        sizeBytes,
        ...metadata,
        extractedFrames,
        extractedFrameBuffers,
        sampleTimestampsSec,
      };
    } catch (err) {
      return emptyResult(`video_probe_or_extraction_failed: ${redactSecrets(err)}`);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Temp cleanup failure must not change QA truth.
      }
    }
  }
}
