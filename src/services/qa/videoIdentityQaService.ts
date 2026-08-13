import { GoogleGenAI, Type } from '@google/genai';
import type { IdentitySpec, VideoQaReport, VideoFrameQaItem } from '../../types';
import { callWithRetry } from '../../utils/retryHelper';
import { redactSecrets } from '../../utils/redactSecrets';

export type VideoIdentityGateStatus = 'pass' | 'review' | 'fail';

export interface VideoFrameSample {
  buffer: Buffer;
  timestampSec: number;
  mimeType?: string;
}

export interface IdentityDriftSegment {
  startTimestampSec: number;
  endTimestampSec: number;
  minimumIdentityScore: number;
  severity: 'review' | 'fail';
}

export interface VideoIdentityQaReport extends VideoQaReport {
  gateStatus: VideoIdentityGateStatus;
  identityDriftDetected: boolean;
  worstFrameTimestamp: number | null;
  identityDriftSegments: IdentityDriftSegment[];
}

interface FrameAssessment {
  frameIndex: number;
  identityScore: number;
  qualityScore: number;
  notes: string;
  criticalIssues: string[];
}

export class VideoIdentityQaService {
  private static assertScore(name: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`VIDEO_QA_PARSE_FAILED: invalid ${name}`);
    }
    return value;
  }

  static buildDriftSegments(
    frameReports: VideoFrameQaItem[],
    perFrameCriticalIssues: Map<number, string[]>
  ): IdentityDriftSegment[] {
    const segments: IdentityDriftSegment[] = [];
    let active:
      | {
          startIndex: number;
          endIndex: number;
          minimumIdentityScore: number;
          severity: 'review' | 'fail';
        }
      | undefined;

    const flush = () => {
      if (!active) return;
      segments.push({
        startTimestampSec: frameReports[active.startIndex].timestampSec,
        endTimestampSec: frameReports[active.endIndex].timestampSec,
        minimumIdentityScore: active.minimumIdentityScore,
        severity: active.severity,
      });
      active = undefined;
    };

    for (let i = 0; i < frameReports.length; i++) {
      const frame = frameReports[i];
      const critical = (perFrameCriticalIssues.get(frame.frameIndex) || []).length > 0;
      const drift = frame.identityScore < 90 || critical;

      if (!drift) {
        flush();
        continue;
      }

      const severity: 'review' | 'fail' = critical || frame.identityScore < 80 ? 'fail' : 'review';
      if (!active) {
        active = {
          startIndex: i,
          endIndex: i,
          minimumIdentityScore: frame.identityScore,
          severity,
        };
        continue;
      }

      active.endIndex = i;
      active.minimumIdentityScore = Math.min(active.minimumIdentityScore, frame.identityScore);
      if (severity === 'fail') active.severity = 'fail';
    }

    flush();
    return segments;
  }

  static async qaVideoIdentity(params: {
    ai: GoogleGenAI;
    analysisModel: string;
    samples: VideoFrameSample[];
    approvedFirstFrame: Buffer;
    approvedFirstFrameMimeType?: string;
    masterImages: Buffer[];
    masterMimeTypes?: string[];
    identitySpec: IdentitySpec;
    characterDescription?: string;
  }): Promise<VideoIdentityQaReport> {
    const {
      ai,
      analysisModel,
      samples,
      approvedFirstFrame,
      approvedFirstFrameMimeType = 'image/jpeg',
      masterImages,
      masterMimeTypes = [],
      identitySpec,
      characterDescription = '',
    } = params;

    if (!samples || samples.length < 2) {
      throw new Error('VIDEO_QA_INPUT_INVALID: 至少需要 2 个真实视频抽帧');
    }
    if (!masterImages || masterImages.length === 0) {
      throw new Error('VIDEO_QA_INPUT_INVALID: 缺失角色母板，视频身份质检必须 fail-closed');
    }
    if (samples.some((sample) => !sample.buffer?.length || !Number.isFinite(sample.timestampSec))) {
      throw new Error('VIDEO_QA_INPUT_INVALID: 抽帧数据或真实时间戳无效');
    }

    const parts: any[] = [];

    masterImages.slice(0, 3).forEach((buffer, index) => {
      parts.push({
        inlineData: {
          mimeType: masterMimeTypes[index] || 'image/jpeg',
          data: buffer.toString('base64'),
        },
      });
      parts.push({ text: `[MASTER_${index}]: target character identity reference` });
    });

    parts.push({
      inlineData: {
        mimeType: approvedFirstFrameMimeType,
        data: approvedFirstFrame.toString('base64'),
      },
    });
    parts.push({ text: '[APPROVED_FIRST_FRAME]: approved identity anchor before video generation' });

    samples.forEach((sample, index) => {
      parts.push({
        inlineData: {
          mimeType: sample.mimeType || 'image/jpeg',
          data: sample.buffer.toString('base64'),
        },
      });
      parts.push({
        text: `[VIDEO_FRAME_${index}]: real extracted frame at ${sample.timestampSec.toFixed(3)} seconds`,
      });
    });

    const promptText = `
你是角色一致性视频质检专家。请逐帧比对目标角色母板、已批准首帧和真实视频抽帧。

角色描述：${characterDescription}
IdentitySpec：${JSON.stringify(identitySpec)}

强制规则：
1. 必须对 VIDEO_FRAME_0 ... VIDEO_FRAME_${samples.length - 1} 每一帧独立输出 identityScore，禁止用平均分代替逐帧分数。
2. identityScore 只评价身份一致性：脸型、五官结构、眼型/瞳色、发型发色、明确锁定的身份特征。
3. qualityScore 评价该帧可见主体的画面完整性与解剖稳定性。
4. 时间戳由系统提供，模型不得自行推测或修改。
5. 出现换脸、人物身份变化、眼睛/五官严重漂移、头发身份突变等，写入该帧 criticalIssues。
6. temporalConsistencyScore 评价跨帧身份连续性与是否瞬间漂移。
7. 不得因为 IdentitySpec 未声明的外观细节自行扣分。
8. 输出 frameAssessments 数量必须严格等于 ${samples.length}，frameIndex 必须覆盖 0..${samples.length - 1} 且不重复。

输出严格 JSON。
`;
    parts.push({ text: promptText });

    try {
      const response = await callWithRetry(
        () =>
          ai.models.generateContent({
            model: analysisModel || 'gemini-3.6-flash',
            contents: [{ role: 'user', parts }],
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  frameAssessments: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        frameIndex: { type: Type.INTEGER },
                        identityScore: { type: Type.INTEGER },
                        qualityScore: { type: Type.INTEGER },
                        notes: { type: Type.STRING },
                        criticalIssues: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                        },
                      },
                      required: [
                        'frameIndex',
                        'identityScore',
                        'qualityScore',
                        'notes',
                        'criticalIssues',
                      ],
                    },
                  },
                  temporalConsistencyScore: { type: Type.INTEGER },
                  motionNaturalnessScore: { type: Type.INTEGER },
                  anatomyScore: { type: Type.INTEGER },
                  sceneContinuityScore: { type: Type.INTEGER },
                  promptComplianceScore: { type: Type.INTEGER },
                  criticalIssues: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  repairInstruction: { type: Type.STRING },
                  summary: { type: Type.STRING },
                },
                required: [
                  'frameAssessments',
                  'temporalConsistencyScore',
                  'motionNaturalnessScore',
                  'anatomyScore',
                  'sceneContinuityScore',
                  'promptComplianceScore',
                  'criticalIssues',
                  'repairInstruction',
                  'summary',
                ],
              },
            },
          }),
        { actionName: 'M2-2 视频逐帧身份质检' }
      );

      const parsed = JSON.parse(response.text?.trim() || '{}');
      if (!Array.isArray(parsed.frameAssessments) || parsed.frameAssessments.length !== samples.length) {
        throw new Error('VIDEO_QA_PARSE_FAILED: frameAssessments 数量与真实抽帧数量不一致');
      }

      const byIndex = new Map<number, FrameAssessment>();
      for (const raw of parsed.frameAssessments) {
        if (!Number.isInteger(raw?.frameIndex) || raw.frameIndex < 0 || raw.frameIndex >= samples.length) {
          throw new Error('VIDEO_QA_PARSE_FAILED: frameIndex 非法');
        }
        if (byIndex.has(raw.frameIndex)) {
          throw new Error('VIDEO_QA_PARSE_FAILED: frameIndex 重复');
        }

        byIndex.set(raw.frameIndex, {
          frameIndex: raw.frameIndex,
          identityScore: this.assertScore('identityScore', raw.identityScore),
          qualityScore: this.assertScore('qualityScore', raw.qualityScore),
          notes: typeof raw.notes === 'string' ? raw.notes : '',
          criticalIssues: Array.isArray(raw.criticalIssues)
            ? raw.criticalIssues.filter((item: unknown) => typeof item === 'string')
            : [],
        });
      }

      const frameReports: VideoFrameQaItem[] = samples.map((sample, index) => {
        const assessment = byIndex.get(index);
        if (!assessment) {
          throw new Error(`VIDEO_QA_PARSE_FAILED: 缺失 frameIndex ${index}`);
        }
        return {
          timestampSec: sample.timestampSec,
          frameIndex: index,
          identityScore: assessment.identityScore,
          qualityScore: assessment.qualityScore,
          notes: assessment.notes,
        };
      });

      const identityScores = frameReports.map((frame) => frame.identityScore);
      const averageIdentityScore = Number(
        (identityScores.reduce((sum, score) => sum + score, 0) / identityScores.length).toFixed(1)
      );
      const minimumIdentityScore = Math.min(...identityScores);
      const worstFrame = frameReports.find((frame) => frame.identityScore === minimumIdentityScore);

      const temporalConsistencyScore = this.assertScore(
        'temporalConsistencyScore',
        parsed.temporalConsistencyScore
      );
      const motionNaturalnessScore = this.assertScore(
        'motionNaturalnessScore',
        parsed.motionNaturalnessScore
      );
      const anatomyScore = this.assertScore('anatomyScore', parsed.anatomyScore);
      const sceneContinuityScore = this.assertScore(
        'sceneContinuityScore',
        parsed.sceneContinuityScore
      );
      const promptComplianceScore = this.assertScore(
        'promptComplianceScore',
        parsed.promptComplianceScore
      );

      const perFrameCriticalIssues = new Map<number, string[]>();
      const criticalIssues: string[] = Array.isArray(parsed.criticalIssues)
        ? parsed.criticalIssues.filter((item: unknown) => typeof item === 'string')
        : [];

      for (const [index, assessment] of byIndex.entries()) {
        perFrameCriticalIssues.set(index, assessment.criticalIssues);
        for (const issue of assessment.criticalIssues) {
          criticalIssues.push(`frame_${index}@${samples[index].timestampSec.toFixed(3)}s: ${issue}`);
        }
      }

      const fullPass =
        averageIdentityScore >= 95 &&
        minimumIdentityScore >= 90 &&
        temporalConsistencyScore >= 90 &&
        motionNaturalnessScore >= 88 &&
        anatomyScore >= 88 &&
        criticalIssues.length === 0;

      const hardFail =
        minimumIdentityScore < 80 ||
        temporalConsistencyScore < 75 ||
        anatomyScore < 75 ||
        criticalIssues.length > 0;

      const gateStatus: VideoIdentityGateStatus = fullPass
        ? 'pass'
        : hardFail
          ? 'fail'
          : 'review';

      const identityDriftDetected =
        minimumIdentityScore < 90 || temporalConsistencyScore < 90 || criticalIssues.length > 0;

      const identityDriftSegments = this.buildDriftSegments(
        frameReports,
        perFrameCriticalIssues
      );

      return {
        pass: gateStatus === 'pass',
        gateStatus,
        averageIdentityScore,
        minimumIdentityScore,
        temporalConsistencyScore,
        motionNaturalnessScore,
        anatomyScore,
        sceneContinuityScore,
        promptComplianceScore,
        frameReports,
        criticalIssues,
        repairInstruction:
          typeof parsed.repairInstruction === 'string'
            ? parsed.repairInstruction
            : '保持所有视频帧与已批准首帧和角色母板的身份特征一致',
        summary:
          typeof parsed.summary === 'string'
            ? parsed.summary
            : gateStatus === 'pass'
              ? '视频逐帧身份质检通过'
              : '视频存在身份一致性风险',
        identityDriftDetected,
        worstFrameTimestamp: worstFrame?.timestampSec ?? null,
        identityDriftSegments,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`视频身份质检失败: ${redactSecrets(msg)}`);
    }
  }
}
