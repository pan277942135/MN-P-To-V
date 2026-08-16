import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const inspector = readFileSync('src/services/video/videoInspector.ts', 'utf8');
const qa = readFileSync('src/services/qa/videoIdentityQaService.ts', 'utf8');
const durableQa = readFileSync('src/server/services/durableVideoIdentityQaService.ts', 'utf8');

describe('dense temporal identity sampling source contract', () => {
  it('uses a duration-adaptive dense sampling policy with a bounded QA payload', () => {
    expect(inspector).toContain("IDENTITY_QA_SAMPLING_VERSION = 'dense_temporal_v1'");
    expect(inspector).toContain('IDENTITY_QA_TARGET_INTERVAL_SEC = 0.5');
    expect(inspector).toContain('IDENTITY_QA_MIN_SAMPLES = 6');
    expect(inspector).toContain('IDENTITY_QA_MAX_SAMPLES = 16');
    expect(inspector).toContain('computeIdentityQaSampleCount');
    expect(inspector).toContain('buildIdentityQaSampleTimestamps');
    expect(inspector).toContain('expectedSampleCount');
  });

  it('records exact temporal coverage in every successful identity QA report', () => {
    expect(qa).toContain('samplingManifest: IdentityQaSamplingManifest');
    expect(qa).toContain('maximumGapSec');
    expect(qa).toContain('timestampsSec');
    expect(qa).toContain('抽帧时间戳必须严格递增');
    expect(durableQa).toContain("samplingStrategyVersion: inspection.samplingStrategyVersion || 'unspecified'");
  });

  it('does not regress the inspector back to a fixed six-frame extraction plan', () => {
    const inspectMethod = inspector.slice(inspector.indexOf('static async inspectAndExtractFrames'));
    expect(inspectMethod).toContain('buildIdentityQaSampleTimestamps');
    expect(inspectMethod).not.toContain('metadata.durationSeconds,\n        6,\n        metadata.fps');
  });
});
