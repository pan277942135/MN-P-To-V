import crypto from 'crypto';
import type {
  GenerationTask,
  CharacterProfile,
  AttemptRecord,
} from '../../types';
import { IdentityLockService } from '../character/identityLockService';
import { VideoGenerator, type VideoStartResult } from '../video/videoGenerator';
import { VideoInspector } from '../video/videoInspector';
import { VideoIdentityQaService } from '../qa/videoIdentityQaService';
import { CredentialService } from '../google/credentialService';
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
      const masterRefs = character.referenceImages.slice(0, 3);
      if (masterRefs.length === 0) {
        throw new Error('identity_reference_missing: 当前角色没有可用于身份锁定的母板图');
      }

      const masterBuffers = await Promise.all(
        masterRefs.map(async (ref) => Buffer.from(await ref.blob.arrayBuffer()))
      );
      const masterMimeTypes = masterRefs.map((ref) => ref.mimeType || 'image/jpeg');
      const sceneBuffer = Buffer.from(await task.sceneImageBlob.arrayBuffer());
      const sceneMimeType = task.sceneImageBlob.type || 'image/jpeg';

      const imageIsTargetCharacter = task.sceneMode === 'animate_existing_character';

      task.status = 'generating_first_frame';
      task.progressStage = imageIsTargetCharacter
        ? '目标角色原图：跳过重建，进入母板身份质检'
        : '根据角色母板重建首帧身份';
      task.progressPercent = 35;
      await onTaskUpdated(task);

      const rebuilt = await IdentityLockService.rebuildFirstFrame({
        ai,
        imageModelName: effectiveModels.imageModel,
        sceneImageBuffer: sceneBuffer,
        sceneMimeType,
        identitySpec: character.identitySpec,
        masterBuffers,
        masterMimeTypes,
        sceneMode: task.sceneMode,
        userPrompt: task.userPromptChinese,
        imageIsTargetCharacter,
      });

      const candidate = rebuilt.candidateFirstFrame;
      const candidateBuffer = Buffer.from(await candidate.blob.arrayBuffer());

      task.status = 'qa_first_frame';
      task.progressStage = '首帧与角色母板执行 Identity Gate';
      task.progressPercent = 45;
      await onTaskUpdated(task);

      const identityGate = await IdentityLockService.evaluateIdentityGate({
        ai,
        analysisModel: effectiveModels.analysisModel,
        masterImageBuffer: masterBuffers[0],
        masterMimeType: masterMimeTypes[0],
        sceneImageBuffer: sceneBuffer,
        sceneMimeType,
        candidateBuffer,
        candidateMimeType: candidate.mimeType || sceneMimeType,
        identitySpec: character.identitySpec,
        sceneMode: task.sceneMode,
        imageIsTargetCharacter,
        manualApproved: false,
      });

      candidate.qaReport = identityGate.identityQaReport;
      candidate.dataUrl = candidate.dataUrl || safeCreateObjectURL(candidate.blob);
      task.firstFrameCandidates = [candidate];
      task.selectedFirstFrameId = candidate.id;
      task.identitySourceMode = rebuilt.sourceMode;
      task.firstFrameIdentityQaStatus = identityGate.status;
      task.identityQaScore = identityGate.identityQaScore;
      task.identityCriticalIssues = identityGate.identityCriticalIssues;

      if (identityGate.status === 'fail') {
        task.status = 'failed';
        task.progressStage = '首帧身份质检失败';
        task.progressPercent = 50;
        task.error = {
          code: 'IDENTITY_QA_FAILED',
          stage: 'qa_first_frame',
          messageChinese: identityGate.identityQaReport.summary || '首帧与角色母板身份不一致',
          technicalMessageRedacted: 'First-frame identity gate failed',
          httpStatus: 422,
          retryable: true,
          recommendedAction: identityGate.identityQaReport.issues?.[0]?.repairInstruction || '重新生成首帧后再次执行身份质检',
        };
        task.updatedAt = Date.now();
        await onTaskUpdated(task);
        return task;
      }

      const durationSeconds = task.settings.durationSeconds || 6;
      const half = Number((durationSeconds / 2).toFixed(1));
      const prepared = IdentityLockService.prepareI2VSubmission({
        userPrompt: task.userPromptChinese || 'Natural subtle breathing motion and gentle posture shift.',
        durationSeconds,
        // REVIEW is not allowed to auto-start Veo, but its approved continuation must keep
        // the exact same compiled motion prompt rather than rebuilding from an empty string.
        identityGatePassed: identityGate.status !== 'fail',
      });

      task.promptScript = {
        subjectAction: task.userPromptChinese || '角色保持自然动态',
        facialExpression: '自然、稳定、符合原图表情',
        gaze: '保持原图视线逻辑，不强制重新居中或转正',
        handAction: '保持自然且符合原图遮挡关系',
        bodyMotion: '自然呼吸与轻微重心变化',
        cameraMotion: '默认固定机位，除非用户明确要求相机运动',
        environmentMotion: '仅允许符合场景物理规律的轻微环境动态',
        lighting: '保持原图光照与色温连续',
        audio: '无',
        timeline: [
          { timeRange: `0s-${half}s`, description: '建立自然动作并保持身份稳定' },
          { timeRange: `${half}s-${durationSeconds}s`, description: '延续动作，避免后段换脸与五官漂移' },
        ],
        negativeConstraints: [
          'face drift',
          'identity swap',
          'eye flicker',
          'frontalization',
          'pose normalization',
          'extra limbs',
          'object disappearance',
        ],
        primaryVisualStyle: task.settings.primaryStyle || '照片级写实',
        secondaryVisualStyle: task.settings.secondaryStyle || '',
        styleStrength: task.settings.styleStrength ?? 0.5,
      };

      task.normalizedPromptEnglish = prepared.compiledMotionPrompt || task.userPromptChinese;

      // Review status always requires an explicit human continuation. A normal PASS may
      // also pause when the user enabled first-frame approval.
      if (identityGate.status === 'review' || task.settings.pauseForFirstFrameApproval) {
        task.status = 'waiting_first_frame_approval';
        task.progressStage = identityGate.status === 'review'
          ? 'Identity Gate 需要人工确认首帧'
          : '等待用户确认首帧';
        task.progressPercent = 50;
        task.updatedAt = Date.now();
        await onTaskUpdated(task);
        return task;
      }

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
      task.updatedAt = Date.now();
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

    if (task.firstFrameIdentityQaStatus === 'fail') {
      throw new Error('IDENTITY_GATE_BLOCKED: 首帧身份质检失败，不允许启动视频生成');
    }

    const ai = await GeminiClientFactory.getClientForSession(session);
    const effectiveModels = ModelRouter.getEffectiveModels(
      session,
      task.settings.advancedModelConfig
    );

    const selectedFF =
      task.firstFrameCandidates.find((candidate) => candidate.id === task.selectedFirstFrameId) ||
      task.firstFrameCandidates[0];

    if (!selectedFF) {
      throw new Error('缺失合格首帧数据');
    }

    const firstFrameBuf = Buffer.from(await selectedFF.blob.arrayBuffer());
    const videoMasterRefs = character.referenceImages.slice(0, 3);
    if (videoMasterRefs.length === 0) {
      throw new Error('identity_reference_missing: 视频身份质检缺失角色母板');
    }

    const videoMasterBuffers = await Promise.all(
      videoMasterRefs.map(async (ref) => Buffer.from(await ref.blob.arrayBuffer()))
    );
    const videoMasterMimeTypes = videoMasterRefs.map((ref) => ref.mimeType || 'image/jpeg');

    const maxVideoAttempts = 2;
    let directionalRepair: string | undefined;

    for (let videoAttempts = 1; videoAttempts <= maxVideoAttempts; videoAttempts++) {
      const startTime = Date.now();

      task.status = videoAttempts === 1 ? 'starting_video' : 'repairing';
      task.progressStage = `启动视频引擎 (第 ${videoAttempts}/${maxVideoAttempts} 轮)`;
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
        character.identitySpec,
        task.previousInteractionId,
        directionalRepair,
        task.sceneMode,
        character.description,
        task.settings.durationSeconds,
        task.id
      );

      if (startResult.interactionId) {
        task.previousInteractionId = startResult.interactionId;
      }

      let videoBuf: Buffer | undefined = startResult.videoBuffer;

      if (!videoBuf && startResult.operationName) {
        task.status = 'polling_video';
        task.progressStage = '轮询 Veo 算力生成进度 (最长等待 12 分钟)';
        task.externalOperationName = startResult.operationName;
        await onTaskUpdated(task);

        let polledDone = false;
        let pollCount = 0;

        while (!polledDone && pollCount < 72) {
          pollCount++;
          await new Promise((resolve) => setTimeout(resolve, 10000));

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

      if (!videoBuf) {
        throw new Error('Veo 渲染完成但未取得真实视频 artifact');
      }

      task.status = 'validating_video';
      task.progressStage = '读取真实 MP4 元数据并抽取视频关键帧';
      task.progressPercent = 85;
      await onTaskUpdated(task);

      const inspection = await VideoInspector.inspectAndExtractFrames(videoBuf);
      if (!inspection.valid) {
        throw new Error(`视频画质检查未通过: ${inspection.issueReason}`);
      }

      task.status = 'qa_video';
      task.progressStage = `对 ${inspection.extractedFrames.length} 个真实抽帧执行逐帧 Identity QA`;
      task.progressPercent = 92;
      await onTaskUpdated(task);

      const videoQaReport = await VideoIdentityQaService.qaVideoIdentity({
        ai,
        analysisModel: effectiveModels.analysisModel,
        samples: inspection.extractedFrames,
        approvedFirstFrame: firstFrameBuf,
        approvedFirstFrameMimeType: selectedFF.mimeType,
        masterImages: videoMasterBuffers,
        masterMimeTypes: videoMasterMimeTypes,
        identitySpec: character.identitySpec,
        characterDescription: character.description,
      });

      task.qaReport = videoQaReport;
      task.identityQaStatus = videoQaReport.gateStatus;
      task.identityFrameScores = videoQaReport.frameReports.map((frame) => frame.identityScore);
      task.identityDriftDetected = videoQaReport.identityDriftDetected;
      task.worstFrameTimestamp = videoQaReport.worstFrameTimestamp;
      task.retryCount = Math.max(0, videoAttempts - 1);

      const videoBlob = new Blob([new Uint8Array(videoBuf)], { type: 'video/mp4' });
      task.videoResult = {
        blob: videoBlob,
        mimeType: 'video/mp4',
        sizeBytes: inspection.sizeBytes,
        durationSeconds: inspection.durationSeconds,
        width: inspection.width,
        height: inspection.height,
        fps: inspection.fps,
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
        triggeredRetry: !videoQaReport.pass && videoAttempts < maxVideoAttempts,
        notes: `[${videoQaReport.gateStatus}] ${videoQaReport.summary}`,
      };
      task.attempts.push(attemptRecord);

      if (videoQaReport.gateStatus === 'pass') {
        task.status = 'completed';
        task.progressStage = '生成与逐帧身份质检全部完成';
        task.progressPercent = 100;
        task.updatedAt = Date.now();
        await onTaskUpdated(task);
        return task;
      }

      directionalRepair =
        videoQaReport.repairInstruction ||
        '恢复所有视频帧与 Approved First Frame 和角色母板的一致身份特征';

      if (videoAttempts < maxVideoAttempts) {
        task.progressStage = `Identity QA ${videoQaReport.gateStatus}，按最差帧问题执行定向重试`;
        task.updatedAt = Date.now();
        await onTaskUpdated(task);
        continue;
      }

      if (videoQaReport.gateStatus === 'review') {
        task.status = 'completed_with_warning';
        task.progressStage = '视频生成完成，但 Identity QA 需要人工复核';
        task.progressPercent = 100;
        task.updatedAt = Date.now();
        await onTaskUpdated(task);
        return task;
      }

      task.status = 'failed';
      task.progressStage = '视频身份质检失败';
      task.progressPercent = 100;
      task.error = {
        code: 'VIDEO_IDENTITY_QA_FAILED',
        stage: 'qa_video',
        messageChinese: `视频身份一致性未通过：${videoQaReport.summary}`,
        technicalMessageRedacted: 'Video identity QA gate failed after maximum attempts',
        httpStatus: 422,
        retryable: true,
        recommendedAction: directionalRepair,
      };
      task.updatedAt = Date.now();
      await onTaskUpdated(task);
      return task;
    }

    throw new Error('VIDEO_QA_CONTROL_FLOW_ERROR: 未得到可接受的视频质检终态');
  }
}
