import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import { VideoInspector } from '../services/video/videoInspector';
import { VideoIdentityQaService } from '../services/qa/videoIdentityQaService';
import type { IdentitySpec } from '../types';

const identitySpec: IdentitySpec = {
  lockedTraits: [
    { traitName: 'face', expectedValue: 'same character', sourceText: 'identity master' },
  ],
};

function createAiResponse(payload: unknown): any {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: JSON.stringify(payload) }),
    },
  };
}

const timestamps = [0, 0.79, 1.58, 2.37, 3.16, 3.95];
const samples = timestamps.map((timestampSec, index) => ({
  timestampSec,
  buffer: Buffer.from(`real-frame-${index}`),
  mimeType: 'image/jpeg',
}));

function basePayload(scores: number[]) {
  return {
    frameAssessments: scores.map((identityScore, frameIndex) => ({
      frameIndex,
      identityScore,
      qualityScore: 96,
      notes: `frame ${frameIndex} checked`,
      criticalIssues: [],
    })),
    temporalConsistencyScore: 96,
    motionNaturalnessScore: 94,
    anatomyScore: 95,
    sceneContinuityScore: 94,
    promptComplianceScore: 95,
    criticalIssues: [],
    repairInstruction: '',
    summary: 'sampled frame QA complete',
  };
}

describe('M2-2 Video Identity QA', () => {
  it('builds sample timestamps from real duration instead of fixed 8s magic values', () => {
    const fourSecond = VideoInspector.buildSampleTimestamps(4, 6, 24);
    const sixSecond = VideoInspector.buildSampleTimestamps(6, 6, 24);

    expect(fourSecond).toHaveLength(6);
    expect(fourSecond[0]).toBe(0);
    expect(fourSecond.at(-1)).toBeLessThan(4);
    expect(sixSecond.at(-1)).toBeLessThan(6);
    expect(fourSecond).not.toEqual([0, 1.6, 3.2, 4.8, 6.4, 7.8]);
    expect(sixSecond).not.toEqual(fourSecond);
  });

  it('parses real ffmpeg metadata without hard-coded duration, resolution or fps', () => {
    const metadata = VideoInspector.parseProbeOutput(`
      Duration: 00:00:04.25, start: 0.000000, bitrate: 4100 kb/s
      Stream #0:0: Video: h264, yuv420p(progressive), 720x1280, 29.97 fps, 29.97 tbr
    `);

    expect(metadata.durationSeconds).toBe(4.25);
    expect(metadata.width).toBe(720);
    expect(metadata.height).toBe(1280);
    expect(metadata.fps).toBe(29.97);
  });

  it('computes aggregate identity scores from per-frame model evidence and preserves real timestamps', async () => {
    const ai = createAiResponse(basePayload([98, 97, 96, 95, 94, 93]));

    const report = await VideoIdentityQaService.qaVideoIdentity({
      ai,
      analysisModel: 'gemini-test',
      samples,
      approvedFirstFrame: Buffer.from('approved-first-frame'),
      masterImages: [Buffer.from('master')],
      identitySpec,
    });

    expect(report.gateStatus).toBe('pass');
    expect(report.pass).toBe(true);
    expect(report.averageIdentityScore).toBe(95.5);
    expect(report.minimumIdentityScore).toBe(93);
    expect(report.worstFrameTimestamp).toBe(3.95);
    expect(report.frameReports.map((frame) => frame.timestampSec)).toEqual(timestamps);
    expect(report.frameReports.map((frame) => frame.identityScore)).toEqual([98, 97, 96, 95, 94, 93]);
  });

  it('returns review with a coarse drift segment for recoverable sampled-frame identity drift', async () => {
    const ai = createAiResponse(basePayload([98, 97, 95, 88, 86, 95]));

    const report = await VideoIdentityQaService.qaVideoIdentity({
      ai,
      analysisModel: 'gemini-test',
      samples,
      approvedFirstFrame: Buffer.from('approved-first-frame'),
      masterImages: [Buffer.from('master')],
      identitySpec,
    });

    expect(report.gateStatus).toBe('review');
    expect(report.pass).toBe(false);
    expect(report.identityDriftDetected).toBe(true);
    expect(report.worstFrameTimestamp).toBe(3.16);
    expect(report.identityDriftSegments).toEqual([
      {
        startTimestampSec: 2.37,
        endTimestampSec: 3.16,
        minimumIdentityScore: 86,
        severity: 'review',
      },
    ]);
  });

  it('fails hard when a sampled frame has severe identity loss', async () => {
    const ai = createAiResponse(basePayload([98, 97, 95, 72, 91, 94]));

    const report = await VideoIdentityQaService.qaVideoIdentity({
      ai,
      analysisModel: 'gemini-test',
      samples,
      approvedFirstFrame: Buffer.from('approved-first-frame'),
      masterImages: [Buffer.from('master')],
      identitySpec,
    });

    expect(report.gateStatus).toBe('fail');
    expect(report.minimumIdentityScore).toBe(72);
    expect(report.worstFrameTimestamp).toBe(2.37);
    expect(report.identityDriftSegments[0].severity).toBe('fail');
  });

  it('fails closed when model omits a per-frame assessment instead of inventing scores', async () => {
    const payload = basePayload([98, 97, 96, 95, 94]);
    const ai = createAiResponse(payload);

    await expect(
      VideoIdentityQaService.qaVideoIdentity({
        ai,
        analysisModel: 'gemini-test',
        samples,
        approvedFirstFrame: Buffer.from('approved-first-frame'),
        masterImages: [Buffer.from('master')],
        identitySpec,
      })
    ).rejects.toThrow('frameAssessments 数量与真实抽帧数量不一致');
  });

  it('contains no synthetic-frame fallback and no orchestrator 100-point QA bypass', () => {
    const inspectorSource = fs.readFileSync(
      new URL('../services/video/videoInspector.ts', import.meta.url),
      'utf8'
    );
    const orchestratorSource = fs.readFileSync(
      new URL('../services/tasks/taskOrchestrator.ts', import.meta.url),
      'utf8'
    );

    expect(inspectorSource).not.toContain('dummyFrame');
    expect(inspectorSource).not.toContain('sharp({');
    expect(orchestratorSource).not.toContain('identityScore: 100');
    expect(orchestratorSource).toContain('IdentityLockService.evaluateIdentityGate');
    expect(orchestratorSource).toContain('VideoIdentityQaService.qaVideoIdentity');
  });
});
