import fs from 'node:fs';

function replaceOnce(path, needle, replacement) {
  const source = fs.readFileSync(path, 'utf8');
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${path}: expected exactly one patch anchor, found ${count}`);
  fs.writeFileSync(path, source.replace(needle, replacement));
}
function insertBefore(path, marker, insertion) {
  replaceOnce(path, marker, `${insertion}${marker}`);
}

const inspectorPath = 'src/services/video/videoInspector.ts';
replaceOnce(
  inspectorPath,
  `  sampleTimestampsSec: number[];\n  issueReason?: string;`,
  `  sampleTimestampsSec: number[];\n  samplingStrategyVersion?: 'dense_temporal_v1';\n  identityQaTargetIntervalSec?: number;\n  issueReason?: string;`
);
replaceOnce(
  inspectorPath,
  `export class VideoInspector {\n  static verifyMp4Container(buffer: Buffer): boolean {`,
  `export class VideoInspector {\n  static readonly IDENTITY_QA_SAMPLING_VERSION = 'dense_temporal_v1' as const;\n  static readonly IDENTITY_QA_TARGET_INTERVAL_SEC = 0.5;\n  static readonly IDENTITY_QA_MIN_SAMPLES = 6;\n  static readonly IDENTITY_QA_MAX_SAMPLES = 16;\n\n  static verifyMp4Container(buffer: Buffer): boolean {`
);
replaceOnce(
  inspectorPath,
  `  /**\n   * Build six evenly distributed sample timestamps from the real duration.\n   * The final sample is moved one frame (or at least 50 ms) before EOS so ffmpeg\n   * does not seek beyond the last decodable frame.\n   */`,
  `  /**\n   * Build evenly distributed sample timestamps from the real duration.\n   * The final sample is moved one frame (or at least 50 ms) before EOS so ffmpeg\n   * does not seek beyond the last decodable frame.\n   */`
);
insertBefore(
  inspectorPath,
  `  private static async probeVideoFile(inputMp4Path: string): Promise<VideoProbeMetadata> {`,
  `  static computeIdentityQaSampleCount(\n    durationSeconds: number,\n    targetIntervalSec = this.IDENTITY_QA_TARGET_INTERVAL_SEC,\n    minSamples = this.IDENTITY_QA_MIN_SAMPLES,\n    maxSamples = this.IDENTITY_QA_MAX_SAMPLES\n  ): number {\n    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;\n    if (!Number.isFinite(targetIntervalSec) || targetIntervalSec <= 0) return 0;\n    if (!Number.isInteger(minSamples) || !Number.isInteger(maxSamples) || minSamples <= 0 || maxSamples < minSamples) {\n      return 0;\n    }\n\n    // +1 preserves both temporal endpoints. For the common Veo durations this yields:\n    // 4s -> 9 frames, 6s -> 13 frames, 8s -> capped at 16 frames.\n    const requested = Math.ceil(durationSeconds / targetIntervalSec) + 1;\n    return Math.min(maxSamples, Math.max(minSamples, requested));\n  }\n\n  static buildIdentityQaSampleTimestamps(durationSeconds: number, fps = 24): number[] {\n    const sampleCount = this.computeIdentityQaSampleCount(durationSeconds);\n    if (sampleCount <= 0) return [];\n    return this.buildSampleTimestamps(durationSeconds, sampleCount, fps);\n  }\n\n`
);
replaceOnce(
  inspectorPath,
  `      const timestamps = this.buildSampleTimestamps(\n        metadata.durationSeconds,\n        6,\n        metadata.fps\n      );\n\n      if (timestamps.length !== 6) {`,
  `      const expectedSampleCount = this.computeIdentityQaSampleCount(metadata.durationSeconds);\n      const timestamps = this.buildIdentityQaSampleTimestamps(\n        metadata.durationSeconds,\n        metadata.fps\n      );\n\n      if (expectedSampleCount <= 0 || timestamps.length !== expectedSampleCount) {`
);
replaceOnce(
  inspectorPath,
  `          issueReason: 'video_sampling_plan_invalid: 无法根据真实时长生成 6 个抽帧时间点',`,
  `          samplingStrategyVersion: this.IDENTITY_QA_SAMPLING_VERSION,\n          identityQaTargetIntervalSec: this.IDENTITY_QA_TARGET_INTERVAL_SEC,\n          issueReason: \`video_sampling_plan_invalid: 无法根据真实时长生成动态身份 QA 抽帧计划（expected=\${expectedSampleCount}, actual=\${timestamps.length}）\`,`
);
replaceOnce(
  inspectorPath,
  `          sampleTimestampsSec,\n          issueReason: \`video_frame_extraction_incomplete: 抽帧失败时间点 \${failedTimestamps.join(', ')}\`,`,
  `          sampleTimestampsSec,\n          samplingStrategyVersion: this.IDENTITY_QA_SAMPLING_VERSION,\n          identityQaTargetIntervalSec: this.IDENTITY_QA_TARGET_INTERVAL_SEC,\n          issueReason: \`video_frame_extraction_incomplete: 抽帧失败时间点 \${failedTimestamps.join(', ')}\`,`
);
replaceOnce(
  inspectorPath,
  `          sampleTimestampsSec,\n          issueReason: '视频所有真实抽帧完全相同（视频流冻结或静态假视频）',`,
  `          sampleTimestampsSec,\n          samplingStrategyVersion: this.IDENTITY_QA_SAMPLING_VERSION,\n          identityQaTargetIntervalSec: this.IDENTITY_QA_TARGET_INTERVAL_SEC,\n          issueReason: '视频所有真实抽帧完全相同（视频流冻结或静态假视频）',`
);
replaceOnce(
  inspectorPath,
  `        extractedFrameBuffers,\n        sampleTimestampsSec,\n      };`,
  `        extractedFrameBuffers,\n        sampleTimestampsSec,\n        samplingStrategyVersion: this.IDENTITY_QA_SAMPLING_VERSION,\n        identityQaTargetIntervalSec: this.IDENTITY_QA_TARGET_INTERVAL_SEC,\n      };`
);

const qaPath = 'src/services/qa/videoIdentityQaService.ts';
replaceOnce(
  qaPath,
  `export interface VideoIdentityQaReport extends VideoQaReport {\n  gateStatus: VideoIdentityGateStatus;`,
  `export interface IdentityQaSamplingManifest {\n  version: string;\n  sampleCount: number;\n  timestampsSec: number[];\n  firstTimestampSec: number;\n  lastTimestampSec: number;\n  maximumGapSec: number;\n}\n\nexport interface VideoIdentityQaReport extends VideoQaReport {\n  gateStatus: VideoIdentityGateStatus;`
);
replaceOnce(
  qaPath,
  `  identityDriftSegments: IdentityDriftSegment[];\n}`,
  `  identityDriftSegments: IdentityDriftSegment[];\n  samplingManifest: IdentityQaSamplingManifest;\n}`
);
replaceOnce(
  qaPath,
  `    identitySpec: IdentitySpec;\n    characterDescription?: string;`,
  `    identitySpec: IdentitySpec;\n    characterDescription?: string;\n    samplingStrategyVersion?: string;`
);
replaceOnce(
  qaPath,
  `      identitySpec,\n      characterDescription = '',\n    } = params;`,
  `      identitySpec,\n      characterDescription = '',\n      samplingStrategyVersion = 'unspecified',\n    } = params;`
);
replaceOnce(
  qaPath,
  `    if (samples.some((sample) => !sample.buffer?.length || !Number.isFinite(sample.timestampSec))) {\n      throw new Error('VIDEO_QA_INPUT_INVALID: 抽帧数据或真实时间戳无效');\n    }\n\n    const parts: any[] = [];`,
  `    if (samples.some((sample) => !sample.buffer?.length || !Number.isFinite(sample.timestampSec))) {\n      throw new Error('VIDEO_QA_INPUT_INVALID: 抽帧数据或真实时间戳无效');\n    }\n    for (let i = 1; i < samples.length; i++) {\n      if (samples[i].timestampSec <= samples[i - 1].timestampSec) {\n        throw new Error('VIDEO_QA_INPUT_INVALID: 抽帧时间戳必须严格递增');\n      }\n    }\n\n    const timestampsSec = samples.map((sample) => Number(sample.timestampSec.toFixed(3)));\n    let maximumGapSec = 0;\n    for (let i = 1; i < timestampsSec.length; i++) {\n      maximumGapSec = Math.max(maximumGapSec, timestampsSec[i] - timestampsSec[i - 1]);\n    }\n    const samplingManifest: IdentityQaSamplingManifest = {\n      version: samplingStrategyVersion,\n      sampleCount: timestampsSec.length,\n      timestampsSec,\n      firstTimestampSec: timestampsSec[0],\n      lastTimestampSec: timestampsSec[timestampsSec.length - 1],\n      maximumGapSec: Number(maximumGapSec.toFixed(3)),\n    };\n\n    const parts: any[] = [];`
);
replaceOnce(
  qaPath,
  `        identityDriftSegments,\n      };`,
  `        identityDriftSegments,\n        samplingManifest,\n      };`
);

const durableQaPath = 'src/server/services/durableVideoIdentityQaService.ts';
replaceOnce(
  durableQaPath,
  `      identitySpec: task.identitySpec,\n      characterDescription: task.characterDescription || '',`,
  `      identitySpec: task.identitySpec,\n      characterDescription: task.characterDescription || '',\n      samplingStrategyVersion: inspection.samplingStrategyVersion || 'unspecified',`
);

const existingTestPath = 'src/__tests__/m22VideoIdentityQa.test.ts';
replaceOnce(
  existingTestPath,
  `  it('builds sample timestamps from real duration instead of fixed 8s magic values', () => {`,
  `  it('builds dense identity QA sample plans from real duration instead of a fixed six-frame blind spot', () => {\n    expect(VideoInspector.computeIdentityQaSampleCount(2)).toBe(6);\n    expect(VideoInspector.computeIdentityQaSampleCount(4)).toBe(9);\n    expect(VideoInspector.computeIdentityQaSampleCount(6)).toBe(13);\n    expect(VideoInspector.computeIdentityQaSampleCount(8)).toBe(16);\n    expect(VideoInspector.computeIdentityQaSampleCount(30)).toBe(16);\n\n    const fourSecondDense = VideoInspector.buildIdentityQaSampleTimestamps(4, 24);\n    const eightSecondDense = VideoInspector.buildIdentityQaSampleTimestamps(8, 24);\n    expect(fourSecondDense).toHaveLength(9);\n    expect(eightSecondDense).toHaveLength(16);\n    expect(Math.max(...eightSecondDense.slice(1).map((t, i) => t - eightSecondDense[i]))).toBeLessThanOrEqual(0.54);\n    expect(eightSecondDense[0]).toBe(0);\n    expect(eightSecondDense.at(-1)).toBeLessThan(8);\n  });\n\n  it('builds sample timestamps from real duration instead of fixed 8s magic values', () => {`
);
replaceOnce(
  existingTestPath,
  `    expect(report.frameReports.map((frame) => frame.identityScore)).toEqual([98, 97, 96, 95, 94, 93]);`,
  `    expect(report.frameReports.map((frame) => frame.identityScore)).toEqual([98, 97, 96, 95, 94, 93]);\n    expect(report.samplingManifest).toEqual({\n      version: 'unspecified',\n      sampleCount: 6,\n      timestampsSec: timestamps,\n      firstTimestampSec: 0,\n      lastTimestampSec: 3.95,\n      maximumGapSec: 0.79,\n    });`
);

fs.writeFileSync('src/__tests__/denseTemporalIdentitySamplingSourceContract.test.ts', `import { readFileSync } from 'node:fs';\nimport { describe, expect, it } from 'vitest';\n\nconst inspector = readFileSync('src/services/video/videoInspector.ts', 'utf8');\nconst qa = readFileSync('src/services/qa/videoIdentityQaService.ts', 'utf8');\nconst durableQa = readFileSync('src/server/services/durableVideoIdentityQaService.ts', 'utf8');\n\ndescribe('dense temporal identity sampling source contract', () => {\n  it('uses a duration-adaptive dense sampling policy with a bounded QA payload', () => {\n    expect(inspector).toContain("IDENTITY_QA_SAMPLING_VERSION = 'dense_temporal_v1'");\n    expect(inspector).toContain('IDENTITY_QA_TARGET_INTERVAL_SEC = 0.5');\n    expect(inspector).toContain('IDENTITY_QA_MIN_SAMPLES = 6');\n    expect(inspector).toContain('IDENTITY_QA_MAX_SAMPLES = 16');\n    expect(inspector).toContain('computeIdentityQaSampleCount');\n    expect(inspector).toContain('buildIdentityQaSampleTimestamps');\n    expect(inspector).toContain('expectedSampleCount');\n  });\n\n  it('records exact temporal coverage in every successful identity QA report', () => {\n    expect(qa).toContain('samplingManifest: IdentityQaSamplingManifest');\n    expect(qa).toContain('maximumGapSec');\n    expect(qa).toContain('timestampsSec');\n    expect(qa).toContain('抽帧时间戳必须严格递增');\n    expect(durableQa).toContain("samplingStrategyVersion: inspection.samplingStrategyVersion || 'unspecified'");\n  });\n\n  it('does not regress the inspector back to a fixed six-frame extraction plan', () => {\n    const inspectMethod = inspector.slice(inspector.indexOf('static async inspectAndExtractFrames'));\n    expect(inspectMethod).toContain('buildIdentityQaSampleTimestamps');\n    expect(inspectMethod).not.toContain('metadata.durationSeconds,\\n        6,\\n        metadata.fps');\n  });\n});\n`);

console.log('Applied dense temporal identity sampling patch.');
