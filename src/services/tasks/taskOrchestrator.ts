import { GoogleGenAI } from '@google/genai';
import type {
  GenerationTask,
  CharacterProfile,
  AttemptRecord,
} from '../../types';
import { SceneAnalyzer } from '../scene/sceneAnalyzer';
import { FirstFrameGenerator } from '../image/firstFrameGenerator';
import { VisualQaService } from '../qa/visualQaService';
import { VideoGenerator, type VideoStartResult } from '../video/videoGenerator';
import { VideoInspector } from '../video/videoInspector';
import { CredentialService, type ActiveSession } from '../google/credentialService';
import { GeminiClientFactory } from '../google/geminiClient';
import { ModelRouter } from '../google/modelRouter';
import { redactSecrets } from '../../utils/redactSecrets';

import { safeCreateObjectURL } from '../../utils/imageHelper';

export class TaskOrchestrator {
  static async executeTask(
    connectionId: string,
    task: GenerationTask,
    character: CharacterProfile,
    onTaskUpdated: (updatedTask: GenerationTask) => Promise<void>
  ): Promise<GenerationTask> {
    const session = CredentialService.getSession(connectionId);
    if (!session) {
      task.status = 'failed';
      task.error = {
        code: 'CONNECTION_EXPIRED',
        stage: task.progressStage,
        messageChinese: '算力连接已失效，请重新连接后继续',
        technicalMessageRedacted: 'Session expired',
        httpStatus: 401,
        retryable: true,
        recommendedAction: '进入算力设置重新测试并连接',
      };
      await onTaskUpdated(task);
      return task;
    }

    const ai = await GeminiClientFactory.getClientForSession(session);
    const effectiveModels = ModelRouter.getEffectiveModels(
      session,
      task.settings.advancedModelConfig
    );

    try {
      // 直通模式：跳过 1、2、3、5 步骤，首帧直接取上传图片
      task.status = 'generating_first_frame';
      task.progressStage = '直通模式：首帧直接取上传图片';
      task.progressPercent = 40;
      await onTaskUpdated(task);

      const candidateId = `ff_scene_${crypto.randomUUID().slice(0, 8)}`;
      task.firstFrameCandidates = [
        {
          id: candidateId,
          blob: task.sceneImageBlob,
          dataUrl: safeCreateObjectURL(task.sceneImageBlob),
          width: 1080,
          height: 1920,
          mimeType: task.sceneImageBlob.type || 'image/jpeg',
          createdAt: Date.now(),
          qaReport: {
            pass: true,
            identityScore: 100,
            sourcePersonResidualScore: 0,
            scenePreservationScore: 100,
            posePreservationScore: 100,
            outfitPreservationScore: 100,
            anatomyScore: 100,
            faceDetails: '保持原图面部',
            hairDetails: '保持原图发型',
            bodyDetails: '保持原图姿态',
            summary: '直通模式：首帧直接使用上传图片，跳过重绘与质检',
            issues: [],
          },
        },
      ];
      task.selectedFirstFrameId = candidateId;

      task.promptScript = {
        subjectAction: task.userPromptChinese || '角色保持自然动态',
        facialExpression: '自然表情',
        gaze: '面向镜头',
        handAction: '自然微动',
        bodyMotion: '微幅呼吸变幻',
        cameraMotion: '平稳推拉',
        environmentMotion: '自然光影',
        lighting: '原图光照',
        audio: '无',
        timeline: [
          { timeRange: '0s-4s', description: '自然动作变幻' },
          { timeRange: '4s-8s', description: '动作延续' },
        ],
        negativeConstraints: ['deformed', 'flicker', 'distortion'],
        primaryVisualStyle: task.settings.primaryStyle || '照片级写实',
        secondaryVisualStyle: task.settings.secondaryStyle || '',
        styleStrength: task.settings.styleStrength ?? 0.5,
      };

      task.normalizedPromptEnglish = `${task.userPromptChinese || 'A character with natural motion'}, 8s cinematic video, highly detailed`;

      // Check Pause for First Frame Approval
      if (task.settings.pauseForFirstFrameApproval) {
        task.status = 'waiting_first_frame_approval';
        task.progressStage = '等待用户确认首帧';
        task.progressPercent = 50;
        await onTaskUpdated(task);
        return task;
      }

      // Step 6: Start Video Generation
      return await this.continueVideoPipeline(connectionId, task, character, onTaskUpdated);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isVeoDataIssue = msg.includes('Veo 渲染完成') || msg.includes('未找到视频') || msg.includes('URI');
      task.status = 'failed';
      task.error = {
        code: isVeoDataIssue ? 'VEO_DATA_EMPTY' : 'PIPELINE_ERROR',
        stage: task.progressStage,
        messageChinese: redactSecrets(msg),
        technicalMessageRedacted: redactSecrets(msg),
        httpStatus: 500,
        retryable: true,
        recommendedAction: isVeoDataIssue
          ? '可在历史列表中直接点击【一键重试】重新发起渲染'
          : '可在历史列表中点击【一键重试】，如多次失败请检查算力连接',
      };
      await onTaskUpdated(task);
      return task;
    }
  }

  static async continueVideoPipeline(
    connectionId: string,
    task: GenerationTask,
    character: CharacterProfile,
    onTaskUpdated: (updatedTask: GenerationTask) => Promise<void>
  ): Promise<GenerationTask> {
    const session = CredentialService.getSession(connectionId);
    if (!session) {
      task.status = 'failed';
      task.error = {
        code: 'CONNECTION_EXPIRED',
        stage: task.progressStage,
        messageChinese: '算力连接已失效，请重新连接',
        technicalMessageRedacted: 'Session expired',
        httpStatus: 401,
        retryable: true,
        recommendedAction: '进入算力设置重新连接',
      };
      await onTaskUpdated(task);
      return task;
    }

    const ai = await GeminiClientFactory.getClientForSession(session);
    const effectiveModels = ModelRouter.getEffectiveModels(
      session,
      task.settings.advancedModelConfig
    );

    const selectedFF =
      task.firstFrameCandidates.find((c) => c.id === task.selectedFirstFrameId) ||
      task.firstFrameCandidates[0];

    if (!selectedFF) {
      throw new Error('缺失合格首帧数据');
    }

    const firstFrameBuf = Buffer.from(await selectedFF.blob.arrayBuffer());

    let videoPass = false;
    let videoAttempts = 0;
    let directionalRepair: string | undefined = undefined;

    const videoMasterRefs = character.referenceImages.slice(0, 3);
    const videoMasterBuffers = await Promise.all(
      videoMasterRefs.map(async (r) => Buffer.from(await r.blob.arrayBuffer()))
    );
    const videoMasterMimeTypes = videoMasterRefs.map((r) => r.mimeType || 'image/jpeg');

    while (!videoPass && videoAttempts <= 2) {
      videoAttempts++;
      const startTime = Date.now();

      task.status = 'starting_video';
      task.progressStage = `启动视频引擎 (第 ${videoAttempts} 轮)`;
      task.progressPercent = 60 + (videoAttempts - 1) * 10;
      await onTaskUpdated(task);

      const startResult: VideoStartResult = await VideoGenerator.startVideoGeneration(
        ai,
        session,
        effectiveModels.videoModel,
        firstFrameBuf,
        selectedFF.mimeType,
        videoMasterBuffers,
        videoMasterMimeTypes,
        task.normalizedPromptEnglish,
        character.identitySpec!,
        task.previousInteractionId,
        directionalRepair,
        task.sceneMode,
        character.description
      );

      if (startResult.interactionId) {
        task.previousInteractionId = startResult.interactionId;
      }

      let videoBuf: Buffer | undefined = startResult.videoBuffer;

      if (!videoBuf && startResult.operationName) {
        // Poll Veo Operation
        task.status = 'polling_video';
        task.progressStage = '轮询 Veo 算力生成进度 (最长等待 12 分钟)';
        task.externalOperationName = startResult.operationName;
        await onTaskUpdated(task);

        let polledDone = false;
        let pollCount = 0;

        while (!polledDone && pollCount < 72) {
          // 72 * 10s = 720s (12 mins)
          pollCount++;
          await new Promise((res) => setTimeout(res, 10000));

          const pollRes = await VideoGenerator.pollVeoOperation(
            ai,
            session,
            startResult.operationName
          );

          if (pollRes.done) {
            polledDone = true;
            if (pollRes.error) {
              throw new Error(`Veo 视频生成任务错误: ${pollRes.error}`);
            }
            videoBuf = pollRes.videoBuffer;
          } else {
            task.progressStage = `轮询 Veo 算力生成进度 (已轮询 ${pollCount} 次)`;
            await onTaskUpdated(task);
          }
        }

        if (!videoBuf) {
          throw new Error('Veo 视频生成轮询超时');
        }
      }

      // Step 7: Validating Video
      task.status = 'validating_video';
      task.progressStage = '检验 8s MP4 容器与画面合法性';
      task.progressPercent = 85;
      await onTaskUpdated(task);

      const inspection = await VideoInspector.inspectAndExtractFrames(videoBuf!);
      if (!inspection.valid) {
        throw new Error(`视频画质检查未通过: ${inspection.issueReason}`);
      }

      // Step 8: QA Video Frames
      task.status = 'qa_video';
      task.progressStage = '抽取 6 关键帧执行 95+ 分身份与连贯性质检';
      task.progressPercent = 92;
      await onTaskUpdated(task);

      const sceneArrayBuf = await task.sceneImageBlob.arrayBuffer();
      const sceneBuffer = Buffer.from(sceneArrayBuf);

      const videoQaReport = await VisualQaService.qaVideoFrames(
        ai,
        effectiveModels.analysisModel,
        inspection.extractedFrameBuffers,
        firstFrameBuf,
        videoMasterBuffers,
        character.identitySpec!,
        character.description,
        sceneBuffer
      );

      task.qaReport = videoQaReport;

      const videoBlob = new Blob([new Uint8Array(videoBuf!)], { type: 'video/mp4' });
      task.videoResult = {
        blob: videoBlob,
        mimeType: 'video/mp4',
        sizeBytes: inspection.sizeBytes,
        durationSeconds: inspection.durationSeconds,
        width: inspection.width,
        height: inspection.height,
        fps: 24,
        diagnostics: startResult.diagnostics,
      };

      const attemptRecord: AttemptRecord = {
        attemptIndex: task.attempts.length + 1,
        actionType: videoAttempts === 1 ? 'video_start' : 'video_repair',
        model: effectiveModels.videoModel,
        startTime,
        endTime: Date.now(),
        success: videoQaReport.pass,
        qaScore: videoQaReport.averageIdentityScore,
        triggeredRetry: !videoQaReport.pass && videoAttempts <= 2,
        notes: videoQaReport.summary,
      };
      task.attempts.push(attemptRecord);

      if (videoQaReport.pass) {
        videoPass = true;
        task.status = 'completed';
        task.progressStage = '生成与质检全部完成';
        task.progressPercent = 100;
      } else {
        directionalRepair = videoQaReport.repairInstruction || '恢复主体身份与 Approved 首帧一致';
        if (videoAttempts >= 2) {
          task.status = 'completed_with_warning';
          task.progressStage = '生成完成 (带质检警告)';
          task.progressPercent = 100;
        }
      }

      task.updatedAt = Date.now();
      await onTaskUpdated(task);
    }

    return task;
  }
}
