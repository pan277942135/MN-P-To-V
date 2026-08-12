import React, { useState, useEffect, useRef, useMemo } from 'react';
import { characterRepository } from '../repositories/characterRepository';
import { taskRepository } from '../repositories/taskRepository';
import { parseJsonResponse, safeFetchApi } from '../utils/apiClient';
import { getRefImageUrl, refToBlob, safeCreateObjectURL } from '../utils/imageHelper';
import type {
  CharacterProfile,
  GenerationTask,
  SceneCrop,
  SceneMode,
  ErrorSource,
  ErrorFailureStage,
  GenerationConfig,
} from '../types';
import { PromptCompiler, MotionIntensity } from '../services/prompt/PromptCompiler';
import { FirstFrameChecker } from '../services/image/firstFrameCheck';
import { downloadVideoFile } from '../utils/downloadHelper';
import { GcsLocationCard } from '../components/GcsLocationCard';
import { useConnection } from '../context/ConnectionContext';
import {
  Film,
  Crop,
  Sparkles,
  Download,
  AlertTriangle,
  RefreshCw,
  Maximize2,
  Info,
  ShieldAlert,
  RotateCcw,
  Sliders,
  Video,
  CheckCircle2,
  Copy,
  Check,
  Database,
  ExternalLink,
} from 'lucide-react';
import { copyExecutionParamsToClipboard, getExplicitTaskFailureReason } from '../utils/taskHelper';

export interface StylePreset {
  id: string;
  name: string;
  badge?: string;
  desc: string;
  matchKeys: string[];
}

const EASY_STYLE_PRESETS: StylePreset[] = [
  {
    id: 'photo_realism',
    name: '写实照片',
    badge: '最常用',
    desc: '真实相机拍摄、细节清晰自然',
    matchKeys: ['写实照片', '照片级写实', '商业广告', '纪录片'],
  },
  {
    id: 'cinematic',
    name: '电影剧照',
    badge: '大片感',
    desc: '电影景深构图、精美光影故事感',
    matchKeys: ['电影剧照', '高级时尚杂志', '奇幻史诗'],
  },
  {
    id: 'vlog_lifestyle',
    name: '手机 Vlog',
    badge: '接地气',
    desc: '原相机真实记录、生活化氛围',
    matchKeys: ['手机 Vlog', '手机原相机 Vlog', '韩国生活方式短视频'],
  },
  {
    id: 'retro_film',
    name: '复古胶片',
    badge: '怀旧感',
    desc: '胶片颗粒质感、温润暖色调',
    matchKeys: ['复古胶片', '黑白电影'],
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克',
    badge: '科幻',
    desc: '霓虹夜景冷光、未来感科技风',
    matchKeys: ['赛博朋克', '科幻未来', '超现实主义'],
  },
  {
    id: 'anime_3d',
    name: '二次元/3D',
    badge: '动漫CG',
    desc: '精美动漫CG建模、灵动鲜艳色彩',
    matchKeys: ['二次元/3D', '3D 动画', '2D 插画', '黏土定格'],
  },
];

export const StudioPage: React.FC<{
  onNavigateToCharacters: () => void;
  onNavigateToSettings: () => void;
  onNavigateToHistory?: () => void;
}> = ({
  onNavigateToCharacters,
  onNavigateToSettings,
  onNavigateToHistory,
}) => {
  const { isConnected, connectionInfo } = useConnection();

  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>(
    () => localStorage.getItem('zaojing_option_selectedCharacterId') || ''
  );

  // Scene image & Crop State
  const [sceneFile, setSceneFile] = useState<File | null>(null);
  const [scenePreviewUrl, setScenePreviewUrl] = useState<string | null>(null);
  const [cropZoom, setCropZoom] = useState<number>(100);
  const [sceneMode, setSceneMode] = useState<SceneMode>(
    () => (localStorage.getItem('zaojing_option_sceneMode') as SceneMode) || 'animate_existing_character'
  );
  const [isBypassReconstruction, setIsBypassReconstruction] = useState<boolean>(() => {
    const saved = localStorage.getItem('zaojing_option_isBypassReconstruction');
    return saved !== null ? saved === 'true' : true;
  });

  // Prompt & Style State
  const [durationSeconds, setDurationSeconds] = useState<number>(() => {
    const saved = localStorage.getItem('zaojing_option_durationSeconds');
    return saved ? Number(saved) : 4;
  });
  const [motionIntensity, setMotionIntensity] = useState<MotionIntensity>(() => {
    const saved = localStorage.getItem('zaojing_option_motionIntensity');
    return (saved as MotionIntensity) || 'natural';
  });
  const [cameraPreset, setCameraPreset] = useState<string>(() => {
    return localStorage.getItem('zaojing_option_cameraPreset') || 'locked_camera';
  });
  const [userPrompt, setUserPrompt] = useState<string>(() => {
    return (
      localStorage.getItem('zaojing_option_userPrompt') ||
      'Create a realistic portrait video based on the uploaded image. A young woman sitting in a cozy atmosphere. Subtle soft smile, gentle eye blink, and hair gently swaying in the breeze. Locked camera, stable framing, consistent lighting.'
    );
  });
  const [customCompiledPrompt, setCustomCompiledPrompt] = useState<string | null>(null);
  const [primaryStyle, setPrimaryStyle] = useState<string>(() => {
    return localStorage.getItem('zaojing_option_primaryStyle') || '电影剧照';
  });
  const [secondaryStyle, setSecondaryStyle] = useState<string>(() => {
    return localStorage.getItem('zaojing_option_secondaryStyle') || '';
  });
  const [styleStrength, setStyleStrength] = useState<number>(() => {
    const saved = localStorage.getItem('zaojing_option_styleStrength');
    return saved ? Number(saved) : 0.6;
  });
  const [pauseForApproval, setPauseForApproval] = useState<boolean>(() => {
    return localStorage.getItem('zaojing_option_pauseForApproval') === 'true';
  });

  // Save option choices to localStorage
  useEffect(() => {
    localStorage.setItem('zaojing_option_durationSeconds', String(durationSeconds));
  }, [durationSeconds]);

  useEffect(() => {
    localStorage.setItem('zaojing_option_motionIntensity', motionIntensity);
  }, [motionIntensity]);

  useEffect(() => {
    localStorage.setItem('zaojing_option_cameraPreset', cameraPreset);
  }, [cameraPreset]);

  useEffect(() => {
    localStorage.setItem('zaojing_option_primaryStyle', primaryStyle);
  }, [primaryStyle]);

  useEffect(() => {
    localStorage.setItem('zaojing_option_secondaryStyle', secondaryStyle);
  }, [secondaryStyle]);

  useEffect(() => {
    localStorage.setItem('zaojing_option_styleStrength', String(styleStrength));
  }, [styleStrength]);

  useEffect(() => {
    localStorage.setItem('zaojing_option_isBypassReconstruction', String(isBypassReconstruction));
  }, [isBypassReconstruction]);

  useEffect(() => {
    localStorage.setItem('zaojing_option_sceneMode', sceneMode);
  }, [sceneMode]);

  useEffect(() => {
    localStorage.setItem('zaojing_option_pauseForApproval', String(pauseForApproval));
  }, [pauseForApproval]);

  useEffect(() => {
    if (userPrompt) {
      localStorage.setItem('zaojing_option_userPrompt', userPrompt);
    }
  }, [userPrompt]);

  useEffect(() => {
    if (selectedCharacterId) {
      localStorage.setItem('zaojing_option_selectedCharacterId', selectedCharacterId);
    }
  }, [selectedCharacterId]);
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState<boolean>(false);
  const [showCompilerInspector, setShowCompilerInspector] = useState<boolean>(false);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);

  const [systemEnv, setSystemEnv] = useState<{
    environment: string;
    isCloudRun: boolean;
    actualPrincipalEmail: string;
    K_SERVICE: string | null;
    K_REVISION: string | null;
    K_CONFIGURATION: string | null;
    buildVersion: string;
    buildTimestamp: string;
    commitHash: string;
    actualModel?: string;
  } | null>(null);

  // Single Source of Truth for Generation Configuration
  const generationConfig: GenerationConfig = useMemo(() => ({
    durationSeconds, // 4, 6, 8
    aspectRatio: '9:16',
    resolution: '1080p',
    sampleCount: 1,
    generateAudio: false,
    modelId: systemEnv?.actualModel || 'veo-3.1-fast-generate-001',
  }), [durationSeconds, systemEnv]);

  const selectedChar = useMemo(() => characters.find((c) => c.id === selectedCharacterId), [characters, selectedCharacterId]);

  // Server-side / Rule-based Prompt Compiler Result
  const compiledResult = useMemo(() => {
    return PromptCompiler.compile({
      durationSeconds: generationConfig.durationSeconds,
      userMotionPrompt: userPrompt,
      motionIntensity,
      characterProfile: selectedChar ? {
        name: selectedChar.name,
        description: selectedChar.description,
        identitySpec: selectedChar.identitySpec,
      } : undefined,
      visualStyle: primaryStyle,
      cameraPreset,
    });
  }, [generationConfig.durationSeconds, userPrompt, motionIntensity, selectedChar, primaryStyle, cameraPreset]);

  // Active Compiled Prompt (Custom or Recommendation)
  const activeCompiledPrompt = customCompiledPrompt !== null ? customCompiledPrompt : compiledResult.compiledPrompt;

  // High-risk Motion Keyword Detector
  const motionRisks = useMemo(() => {
    return PromptCompiler.detectMotionRisks(userPrompt, generationConfig.durationSeconds, motionIntensity);
  }, [userPrompt, generationConfig.durationSeconds, motionIntensity]);

  // First Frame Local Rule Inspection
  const firstFrameCheckResult = useMemo(() => {
    if (scenePreviewUrl) {
      return FirstFrameChecker.checkDataUrl(scenePreviewUrl);
    }
    return null;
  }, [scenePreviewUrl]);

  const handleAutoSuggestPrompt = async () => {
    const storedConnectionId = localStorage.getItem('zaojing_connection_id') || '';
    if (!storedConnectionId) {
      alert('算力连接未建立或已超时，请先在右上角或【算力凭据】管理中连接算力服务');
      return;
    }

    if (!sceneFile && !selectedCharacterId) {
      alert('请先选择角色或上传场景底图，以便 AI 分析图片氛围并生成提示词');
      return;
    }

    setIsGeneratingPrompt(true);
    try {
      const formData = new FormData();
      if (sceneFile) {
        formData.append('sceneImage', sceneFile);
      }
      
      const selectedChar = characters.find((c) => c.id === selectedCharacterId);
      if (selectedChar && selectedChar.referenceImages && selectedChar.referenceImages.length > 0) {
        const refImg = selectedChar.referenceImages[0];
        const blob = await refToBlob(refImg);
        if (blob) {
          formData.append('characterImage', blob, 'character_reference.jpg');
        }
      }
      if (selectedCharacterId) {
        formData.append('characterId', selectedCharacterId);
      }

      // Pass user selected parameters to prompt generator
      formData.append('durationSeconds', String(durationSeconds));
      formData.append('motionIntensity', motionIntensity);
      formData.append('primaryStyle', primaryStyle);
      if (secondaryStyle) formData.append('secondaryStyle', secondaryStyle);
      formData.append('cameraPreset', cameraPreset);
      if (userPrompt) formData.append('userPrompt', userPrompt);

      const { res, data } = await safeFetchApi<{ prompt?: string; error?: string }>('/api/prompts/suggest', {
        method: 'POST',
        headers: {
          'x-connection-id': storedConnectionId,
        },
        body: formData,
      });

      if (!res.ok) {
        throw new Error(data.error || `生成提示词失败 (HTTP ${res.status})`);
      }

      if (data.prompt) {
        setUserPrompt(data.prompt);
        setShowCompilerInspector(true);
      } else {
        alert(data.error || '生成提示词失败，请稍后再试');
      }
    } catch (err: any) {
      console.error('Prompt generation failed:', err);
      alert(err.message || '生成提示词失败: 网络或模型异常');
    } finally {
      setIsGeneratingPrompt(false);
    }
  };

  // Task Execution State
  const [currentTask, setCurrentTask] = useState<GenerationTask | null>(null);
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [isCopiedCurrentTaskParams, setIsCopiedCurrentTaskParams] = useState<boolean>(false);
  const timerRef = useRef<any>(null);

  const handleCopyCurrentTaskParams = async () => {
    if (!currentTask) return;
    const success = await copyExecutionParamsToClipboard(currentTask);
    if (success) {
      setIsCopiedCurrentTaskParams(true);
      setTimeout(() => setIsCopiedCurrentTaskParams(false), 2500);
    }
  };

  // Zoom Modal
  const [zoomImageUrl, setZoomImageUrl] = useState<string | null>(null);

  const handleResetWorkspace = () => {
    setUserPrompt('');
    localStorage.setItem('zaojing_option_userPrompt', '');
    setSceneFile(null);
    setScenePreviewUrl(null);
    setCustomCompiledPrompt(null);
    setCurrentTask(null);
    setIsExecuting(false);
    isSubmittingRef.current = false;
  };

  const loadCharactersAndTask = async () => {
    try {
      const list = await characterRepository.getAll();
      const readyList = (list || []).filter((c) => c && c.status === 'ready');
      setCharacters(readyList);

      let targetCharId = '';
      if (readyList.length === 1) {
        // 只有一个角色时，默认选中
        targetCharId = readyList[0].id;
      } else if (readyList.length > 1) {
        // 有多个角色时，记忆上次的选择
        const savedId = localStorage.getItem('zaojing_option_selectedCharacterId');
        if (savedId && readyList.some((c) => c.id === savedId)) {
          targetCharId = savedId;
        } else {
          targetCharId = readyList[0].id;
        }
      }

      if (targetCharId) {
        setSelectedCharacterId(targetCharId);
        localStorage.setItem('zaojing_option_selectedCharacterId', targetCharId);
      }

      const bringTaskId = sessionStorage.getItem('zaojing_bring_task_id');
      const tasks = await taskRepository.getAll();
      if (tasks && tasks.length > 0) {
        if (bringTaskId) {
          const bringTask = tasks.find((t) => t.id === bringTaskId);
          if (bringTask) {
            setCurrentTask(bringTask);
            if (bringTask.sceneImageBlob) {
              const file = new File([bringTask.sceneImageBlob], 'scene_brought.jpg', { type: bringTask.sceneImageBlob.type || 'image/jpeg' });
              setSceneFile(file);
              setScenePreviewUrl(safeCreateObjectURL(file));
            }
            if (bringTask.characterId && readyList.some((c) => c.id === bringTask.characterId)) {
              setSelectedCharacterId(bringTask.characterId);
              localStorage.setItem('zaojing_option_selectedCharacterId', bringTask.characterId);
            }
            if (bringTask.userPromptChinese) {
              setUserPrompt(bringTask.userPromptChinese);
            }
          }
          sessionStorage.removeItem('zaojing_bring_task_id');
        } else if (!currentTask) {
          setCurrentTask(tasks[0]);
        }
      }
    } catch (e) {
      console.warn('Failed to load characters or tasks:', e);
    }
  };

  useEffect(() => {
    loadCharactersAndTask();
    fetch('/api/system/environment')
      .then((res) => parseJsonResponse(res))
      .then((data) => setSystemEnv(data))
      .catch((e) => console.warn('Failed to load system environment', e));
  }, []);

  useEffect(() => {
    if (isExecuting) {
      setElapsedSeconds(0);
      timerRef.current = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isExecuting]);

  const handleSceneFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSceneFile(file);
    setScenePreviewUrl(safeCreateObjectURL(file));
  };

  const getVideoBlobFromSource = async (src: string): Promise<Blob | null> => {
    if (!src || typeof src !== 'string') return null;
    if (src.startsWith('data:')) {
      try {
        const arr = src.split(',');
        if (arr.length < 2) return null;
        const mime = arr[0].match(/:(.*?);/)?.[1] || 'video/mp4';
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
          u8arr[n] = bstr.charCodeAt(n);
        }
        return new Blob([u8arr], { type: mime });
      } catch (err) {
        console.warn('[getVideoBlobFromSource] base64 decode failed:', err);
        return null;
      }
    }

    try {
      const resp = await fetch(src);
      if (resp.ok) {
        const blob = await resp.blob();
        if (blob && blob.size > 0) {
          return blob;
        }
      }
    } catch (err) {
      console.warn('[getVideoBlobFromSource] fetch stream failed:', err);
    }
    return null;
  };

  const isSubmittingRef = useRef<boolean>(false);

  const handleGenerate = () => {
    if (isSubmittingRef.current || isExecuting) {
      console.warn('[StudioPage] Task is already submitting or executing');
      alert('上一个视频生成任务已在处理中，正在为您转入【任务记录】查看进度...');
      if (onNavigateToHistory) onNavigateToHistory();
      return;
    }

    if (!isConnected || !connectionInfo) {
      alert('请先在算力设置中配置并激活 Google 算力通道');
      onNavigateToSettings();
      return;
    }

    const character = characters.find((c) => c.id === selectedCharacterId);
    if (!character) {
      alert('请先选择一个已核验的虚拟角色');
      return;
    }

    if (!sceneFile) {
      alert('请上传场景基底图');
      return;
    }

    // Direct execution without intercepting popup
    startGenerateTask();
  };

  const startGenerateTask = async () => {
    if (isSubmittingRef.current || isExecuting) {
      console.warn('[StudioPage] Task is already submitting or executing');
      alert('视频任务正在提交中，已为您转入【任务记录】...');
      if (onNavigateToHistory) onNavigateToHistory();
      return;
    }
    isSubmittingRef.current = true;
    setShowConfirmModal(false);
    const character = characters.find((c) => c.id === selectedCharacterId);
    if (!character || !sceneFile) {
      isSubmittingRef.current = false;
      return;
    }

    const storedConnectionId = localStorage.getItem('zaojing_connection_id') || connectionInfo.connectionId;

    const capturedUserPrompt = userPrompt;
    const capturedSceneFile = sceneFile;
    const capturedCompiledPrompt = activeCompiledPrompt;
    const capturedRawUserPrompt = compiledResult.rawUserPrompt;

    const task: GenerationTask = {
      id: `task_${crypto.randomUUID().slice(0, 8)}`,
      characterId: character.id,
      characterName: character.name,
      sceneImageBlob: new Blob([capturedSceneFile], { type: capturedSceneFile.type }),
      sceneCrop: { x: 0, y: 0, width: 1080, height: 1920, zoom: cropZoom },
      sceneMode: isBypassReconstruction ? 'animate_existing_character' : sceneMode,
      userPromptChinese: capturedUserPrompt,
      normalizedPromptEnglish: capturedCompiledPrompt,
      settings: {
        aspectRatio: '9:16',
        durationSeconds,
        resolution: '1080p',
        fps: 24,
        pauseForFirstFrameApproval: pauseForApproval,
        primaryStyle,
        secondaryStyle,
        styleStrength,
      },
      status: 'local_draft',
      progressStage: '确定首帧图像（直通模式直接取上传图片）',
      progressPercent: 30,
      firstFrameCandidates: [],
      retryCount: 0,
      attempts: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    setCurrentTask(task);
    setIsExecuting(true);

    try {
      task.sceneMode = 'animate_existing_character';

      // 1. 直通模式：直接将上传的场景图片作为首帧
      const directBlob = new Blob([capturedSceneFile], { type: capturedSceneFile.type || 'image/jpeg' });
      const directDataUrl = safeCreateObjectURL(capturedSceneFile);
      const candidateId = `ff_scene_${crypto.randomUUID().slice(0, 8)}`;

      task.firstFrameCandidates = [
        {
          id: candidateId,
          blob: directBlob,
          dataUrl: directDataUrl,
          width: 1080,
          height: 1920,
          mimeType: capturedSceneFile.type || 'image/jpeg',
          createdAt: Date.now(),
          qaReport: {
            pass: true,
            identityScore: 100,
            sourcePersonResidualScore: 0,
            scenePreservationScore: 100,
            posePreservationScore: 100,
            outfitPreservationScore: 100,
            anatomyScore: 100,
            faceDetails: '保持原场景图像面部特征',
            hairDetails: '保持原场景图像发型特征',
            bodyDetails: '保持原场景图像肢体姿态',
            summary: '直通模式：首帧直接取上传图片，免重绘与质检',
            issues: [],
          },
        },
      ];
      task.selectedFirstFrameId = candidateId;
      task.normalizedPromptEnglish = capturedCompiledPrompt || `${capturedUserPrompt || 'A natural character action motion video'}, 8s cinematic video, high quality, highly detailed`;

      task.progressStage = '启动视频模型生成 (8s 9:16 MP4)';
      task.progressPercent = 50;
      task.status = 'starting_video';
      setCurrentTask({ ...task });
      await taskRepository.save(task);

      if (pauseForApproval) {
        task.status = 'waiting_first_frame_approval';
        task.progressStage = '等待用户确认首帧';
        task.progressPercent = 60;
        setCurrentTask({ ...task });
        await taskRepository.save(task);
        setIsExecuting(false);
        if (onNavigateToHistory) onNavigateToHistory();
        return;
      }

      // 启动后台视频流水线，并自动重置表单与解锁工作台
      continueTaskVideoPipeline(task, character, capturedSceneFile, capturedCompiledPrompt, capturedRawUserPrompt, directBlob, storedConnectionId);
      
      setUserPrompt('');
      localStorage.setItem('zaojing_option_userPrompt', '');
      setSceneFile(null);
      setScenePreviewUrl(null);
      setCustomCompiledPrompt(null);
      isSubmittingRef.current = false;
      setIsExecuting(false);

      if (onNavigateToHistory) {
        onNavigateToHistory();
      }
    } catch (err: unknown) {
      const struct = (err as any)?.structuredError;
      const source: ErrorSource = struct?.source || (err as any)?.source || 'unknown';
      const failureStage: ErrorFailureStage = struct?.failureStage || (err as any)?.failureStage || 'submit';
      const httpStatus: number | null = struct?.httpStatus ?? (err as any)?.httpStatus ?? (err as any)?.status ?? null;
      const googleStatus = struct?.googleStatus || null;
      const googleReason = struct?.googleReason || null;
      const rawTech = struct?.technicalMessageRedacted || (err instanceof Error ? err.message : String(err));
      const technicalMessageRedacted = typeof rawTech === 'string' ? rawTech : (rawTech ? String(rawTech) : '');

      let userMessage = struct?.userMessage;
      if (!userMessage) {
        if (source === 'authentication' || httpStatus === 401 || httpStatus === 403) {
          userMessage = '当前运行身份未获得 Vertex AI 调用权限。';
        } else if (
          source === 'vertex_submit' &&
          httpStatus === 404 &&
          (googleStatus === 'NOT_FOUND' || technicalMessageRedacted.includes('NOT_FOUND')) &&
          technicalMessageRedacted.includes('publishers/google/models')
        ) {
          userMessage = '当前模型、区域或项目配置无法解析该模型。';
        } else if (source === 'vertex_polling') {
          userMessage = '视频任务已提交，但查询生成进度失败。';
        } else if (source === 'character_api') {
          userMessage = '角色资料不存在或已被删除。';
        } else if (source === 'internal_api') {
          userMessage = '应用服务接口不存在或部署版本不匹配。';
        } else if (source === 'output_download') {
          userMessage = '视频任务可能已完成，但输出文件暂时无法读取。';
        } else {
          userMessage = `生成失败: ${technicalMessageRedacted}`;
        }
      }

      let recommendedAction = '检查算力连接状态或重新生成';
      if (source === 'authentication' || httpStatus === 401 || httpStatus === 403) {
        recommendedAction = '请检查 Cloud Run 服务账号 IAM 角色权限或切换算力模式';
      } else if (source === 'vertex_polling') {
        recommendedAction = '请在【任务记录】或重新尝试生成检查任务状态';
      } else if (source === 'character_api') {
        recommendedAction = '请在【角色库】选择有效角色后再试';
      } else if (source === 'internal_api') {
        recommendedAction = '请刷新页面或检查部署服务 API';
      }

      task.status = 'failed';
      task.error = {
        code: source.toUpperCase(),
        stage: task.progressStage,
        messageChinese: userMessage,
        technicalMessageRedacted,
        httpStatus,
        googleStatus,
        googleReason,
        retryable: source !== 'character_api',
        recommendedAction,
        source,
        failureStage,
        userMessage,
        endpointHost: struct?.endpointHost || (source.startsWith('vertex') ? 'aiplatform.googleapis.com' : null),
        endpointPathRedacted: struct?.endpointPathRedacted || null,
        requestId: struct?.requestId || null,
        traceId: struct?.traceId || null,
        taskId: struct?.taskId || task.id,
        revision: struct?.revision || systemEnv?.K_REVISION || null,
        buildVersion: struct?.buildVersion || '2.0.0-v2.0-cinema',
        actualModel: struct?.actualModel || 'veo-3.1-fast-generate-001',
        projectId: struct?.projectId || 'xp-vertex-project',
        region: struct?.region || 'us-central1',
      };
      setCurrentTask({ ...task });
      await taskRepository.save(task);
      setIsExecuting(false);
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const continueTaskVideoPipeline = async (
    task: GenerationTask,
    character: CharacterProfile,
    capturedSceneFile: File,
    capturedCompiledPrompt: string,
    capturedRawUserPrompt: string,
    ffBlob: Blob,
    connectionId: string
  ) => {
    try {
      const targetDuration = task.settings.durationSeconds || durationSeconds || 6;
      task.status = 'starting_video';
      task.progressStage = `启动视频引擎并开始生成 (${targetDuration}s 9:16 MP4)`;
      task.progressPercent = 75;
      setCurrentTask({ ...task });
      await taskRepository.save(task);

      const videoFormData = new FormData();
      const ffFileToUpload = (task.sceneMode === 'animate_existing_character' && capturedSceneFile)
        ? capturedSceneFile
        : new File([ffBlob], 'ff.jpg', { type: 'image/jpeg' });
      
      videoFormData.append('taskId', task.id);
      videoFormData.append('characterId', character.id);
      videoFormData.append('firstFrame', ffFileToUpload);
      if (capturedSceneFile) {
        videoFormData.append('sceneImage', capturedSceneFile);
      }
      videoFormData.append('sceneMode', task.sceneMode || 'replace_primary_person');
      videoFormData.append('durationSeconds', String(targetDuration));
      const refImgs = character.referenceImages || [];
      for (let idx = 0; idx < Math.min(3, refImgs.length); idx++) {
        const r = refImgs[idx];
        const blob = await refToBlob(r);
        if (blob) {
          videoFormData.append('masterImages', new File([blob], `master_${idx}.jpg`, { type: r.mimeType || blob.type || 'image/jpeg' }));
        }
      }

      videoFormData.append('normalizedPrompt', capturedCompiledPrompt);
      videoFormData.append('rawUserPrompt', capturedRawUserPrompt);
      videoFormData.append('compiledPrompt', capturedCompiledPrompt);
      videoFormData.append('promptCompilerVersion', compiledResult.compilerVersion);
      videoFormData.append('motionIntensity', motionIntensity);
      videoFormData.append('visualStyle', primaryStyle);
      videoFormData.append('cameraPreset', cameraPreset);
      videoFormData.append('identitySpec', JSON.stringify(character.identitySpec || {}));

      // 1. 启动异步视频生成任务 (禁用自动重试，防止并发生成重复任务)
      const { res: startRes, data: startData } = await safeFetchApi('/api/videos/start', {
        method: 'POST',
        headers: { 'x-connection-id': connectionId },
        body: videoFormData,
      }, 0);

      if (!startRes.ok || !startData.accepted || !startData.serverPersisted || !startData.taskId) {
        throw new Error(startData?.error || '启动视频生成任务失败：服务端未接收或未持久化记录');
      }

      // 服务端确认接收后，局部清空用户动作输入框与场景底图 (保留选中的角色、动作强度、风格、时长、运镜等)
      setUserPrompt('');
      localStorage.setItem('zaojing_option_userPrompt', '');
      setSceneFile(null);
      setScenePreviewUrl(null);
      setCustomCompiledPrompt(null);
      isSubmittingRef.current = false;
      setIsExecuting(false);

      const taskId = startData.taskId;
      task.id = taskId; // Adopt server taskId if different

      if (startData.operationName) {
        task.externalOperationName = startData.operationName;
      }
      task.status = startData.status === 'completed' ? 'completed' : 'polling_video';
      task.progressStage = `视频渲染生成中 (${targetDuration}s 9:16 MP4)`;
      setCurrentTask({ ...task });
      await taskRepository.save(task);

      let videoData: any = null;

      if (startData.status === 'completed' && (startData.videoDataUrl || startData.resultVideoUrl)) {
        videoData = startData;
      } else {
        // 2. 轮询等待视频渲染完成 (防止 HTTP 长连接超时)
        let pollDone = false;
        let consecutiveFailures = 0;
        const startTime = Date.now();

        while (!pollDone) {
          await new Promise((r) => setTimeout(r, 10000));
          const elapsedSec = Math.floor((Date.now() - startTime) / 1000);

          task.status = 'polling_video';
          task.progressStage = `视频渲染生成中 (${targetDuration}s 9:16 MP4) - 已渲染 ${elapsedSec}s`;
          task.progressPercent = Math.min(95, 75 + Math.floor(elapsedSec / 6));
          task.updatedAt = Date.now();
          setCurrentTask({ ...task });
          await taskRepository.save(task);

          try {
            const { res: statusRes, data: statusData } = await safeFetchApi(`/api/videos/status/${taskId}`, {
              method: 'GET',
              headers: { 'x-connection-id': connectionId },
            });

            if (statusRes.status === 404 || statusData?.httpStatus === 404) {
              pollDone = true;
              task.status = 'orphaned_local_task';
              task.progressStage = '该任务仅存在于本地缓存，服务端没有对应任务记录';
              task.error = {
                code: 'ORPHANED_LOCAL_TASK',
                stage: 'polling',
                messageChinese: '该任务仅存在于本地缓存，服务端没有对应任务记录。',
                technicalMessageRedacted: 'Server status endpoint returned 404 Not Found',
                httpStatus: 404,
                retryable: false,
                recommendedAction: '点击【删除本地记录】清除该任务',
              };
              task.updatedAt = Date.now();
              setCurrentTask({ ...task });
              await taskRepository.save(task);
              setIsExecuting(false);
              return;
            }

            if (!statusRes.ok) {
              consecutiveFailures++;
              if (consecutiveFailures >= 15) {
                throw new Error(statusData?.error || '多次查询视频生成状态失败，请检查网络或算力连接状态');
              }
              continue;
            }

            consecutiveFailures = 0;

            if (statusData.status === 'completed') {
              if (!statusData.videoDataUrl && !statusData.resultVideoUrl) {
                throw new Error('视频渲染完成，但未能成功传输视频播放地址，请重新生成');
              }
              pollDone = true;
              videoData = statusData;
            } else if (statusData.status === 'polling_timeout') {
              pollDone = true;
              task.status = 'polling_timeout';
              task.progressStage = '云端渲染较慢，已保留 OperationName。可在【任务记录】页面随时「继续查询」';
              task.updatedAt = Date.now();
              setCurrentTask({ ...task });
              await taskRepository.save(task);
              setIsExecuting(false);
              return;
            } else if (statusData.status === 'failed') {
              throw new Error(statusData.error || '视频生成任务异常中断');
            }
          } catch (pollErr: any) {
            const msg = typeof pollErr?.message === 'string' ? pollErr.message : String(pollErr || '');
            if (msg.includes('未能成功传输') || msg.includes('异常中断') || msg.includes('多次查询视频')) {
              throw pollErr;
            }
            consecutiveFailures++;
            if (consecutiveFailures >= 15) {
              throw pollErr;
            }
          }
        }
      }

      const rawVideoUrl = videoData.videoDataUrl || videoData.resultVideoUrl || `/api/videos/stream/${taskId}`;
      const videoBlob = await getVideoBlobFromSource(rawVideoUrl);

      if (videoBlob) {
        task.videoResult = {
          blob: videoBlob,
          mimeType: 'video/mp4',
          sizeBytes: videoData.sizeBytes || videoBlob.size,
          durationSeconds: videoData.durationSeconds,
          width: 1080,
          height: 1920,
          fps: 24,
          diagnostics: videoData.diagnostics,
        };
      }
      task.resultVideoUrl = rawVideoUrl;
      if (videoData.videoUri) task.videoUri = videoData.videoUri;
      if (videoData.outputUri) task.outputUri = videoData.outputUri;
      task.qaReport = videoData.qaReport;
      task.status = 'completed';
      task.progressStage = '合成与全帧视频生成完成';
      task.progressPercent = 100;
      task.updatedAt = Date.now();

      setCurrentTask({ ...task });
      await taskRepository.save(task);
      setIsExecuting(false);
    } catch (pipelineErr: any) {
      console.error('Video pipeline error:', pipelineErr);
      const errMsg = pipelineErr.message || String(pipelineErr);
      task.status = 'failed';
      task.progressStage = '生成失败';
      task.error = {
        code: 'PIPELINE_ERROR',
        stage: '视频生成阶段',
        messageChinese: `生成失败: ${errMsg}`,
        technicalMessageRedacted: errMsg,
        httpStatus: null,
        retryable: true,
        recommendedAction: '请在【任务记录】页面检查算力或重试',
      };
      task.updatedAt = Date.now();
      setCurrentTask({ ...task });
      await taskRepository.save(task);
      setIsExecuting(false);
    }
  };

  const handleContinueApproval = async () => {
    if (!currentTask) return;
    const character = characters.find((c) => c.id === currentTask.characterId);
    if (!character) return;

    const storedConnectionId = localStorage.getItem('zaojing_connection_id') || '';
    const cand = currentTask.firstFrameCandidates[0];
    if (!cand) return;

    const fileToUse = sceneFile || new File([cand.blob], 'ff.jpg', { type: 'image/jpeg' });
    setIsExecuting(true);
    try {
      await continueTaskVideoPipeline(
        currentTask,
        character,
        fileToUse,
        currentTask.normalizedPromptEnglish || activeCompiledPrompt,
        currentTask.userPromptChinese || compiledResult.rawUserPrompt,
        cand.blob,
        storedConnectionId
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      currentTask.status = 'failed';
      currentTask.error = {
        code: 'VIDEO_ERROR',
        stage: currentTask.progressStage,
        messageChinese: `视频生成失败: ${msg}`,
        technicalMessageRedacted: msg,
        httpStatus: 500,
        retryable: true,
        recommendedAction: '稍微重试',
      };
      setCurrentTask({ ...currentTask });
      await taskRepository.save(currentTask);
      setIsExecuting(false);
    }
  };

  return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto space-y-6 sm:space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-extrabold text-white flex items-center gap-2 tracking-tight">
            <Film className="w-5 h-5 text-[#A855F7]" />
            造境创作工作台
          </h2>
          <p className="text-xs sm:text-sm text-[#94A3B8] mt-1">
            三步完成 9:16 场景图裁切、角色重塑、8 秒连续动作标准化与全流程 AI 质检生成。
          </p>
        </div>
        <button
          onClick={handleResetWorkspace}
          className="self-start sm:self-auto px-3 py-1.5 rounded-lg bg-[#16161A] hover:bg-[#25252A] border border-[#2D2D33] text-xs text-[#94A3B8] hover:text-[#CBD5E1] transition flex items-center gap-1.5 shrink-0"
          title="重置并清空当前工作台输入"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>重置工作台</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
        {/* Left Column: Config Panel */}
        <div className="lg:col-span-5 space-y-5 sm:space-y-6 bg-[#0A0A0C] border border-[#1F1F23] rounded-2xl p-4 sm:p-6 shadow-xl">
          {/* Step 1: Character Selector */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#64748B] flex items-center gap-2">
                <span className="w-4 h-4 rounded-full bg-[#7C3AED] text-white text-[10px] flex items-center justify-center font-bold shadow-[0_0_8px_rgba(124,58,237,0.5)]">
                  1
                </span>
                选择归档角色
              </label>
              <button
                onClick={onNavigateToCharacters}
                className="text-xs text-[#A855F7] hover:text-[#C084FC] transition font-medium"
              >
                + 新建角色
              </button>
            </div>

            {characters.length === 0 ? (
              <div className="p-4 rounded-xl bg-[#16161A] border border-[#2D2D33] text-center space-y-2">
                <p className="text-xs text-[#94A3B8]">尚未建立就绪的虚拟角色</p>
                <button
                  onClick={onNavigateToCharacters}
                  className="px-3.5 py-1.5 rounded-lg bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-xs font-semibold shadow-[0_0_12px_rgba(124,58,237,0.3)]"
                >
                  前往角色库建立首个角色
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {characters.map((char) => {
                  const isSelected = char.id === selectedCharacterId;
                  const firstRef = (char.referenceImages || [])[0];

                  return (
                    <div
                      key={char.id}
                      onClick={() => setSelectedCharacterId(char.id)}
                      className={`p-2.5 rounded-xl border cursor-pointer transition flex items-center space-x-2.5 ${
                        isSelected
                          ? 'bg-[#2D1B4D]/60 border-[#7C3AED] text-[#C084FC] shadow-[0_0_12px_rgba(124,58,237,0.15)]'
                          : 'bg-[#16161A] border-[#2D2D33] hover:border-[#3F3F46] text-[#CBD5E1]'
                      }`}
                    >
                      <div className="w-10 h-10 rounded-lg bg-[#0A0A0C] overflow-hidden shrink-0 border border-[#2D2D33]">
                        {firstRef && (
                          <img
                            src={getRefImageUrl(firstRef)}
                            alt={char.name}
                            className="w-full h-full object-cover"
                          />
                        )}
                      </div>
                      <div className="overflow-hidden">
                        <div className="text-xs font-bold truncate text-white">{char.name}</div>
                        <div className="text-[10px] text-[#64748B] truncate">身份锁就绪</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Step 2: Scene Upload & Crop */}
          <div className="space-y-3 pt-5 border-t border-[#1F1F23]">
            <label className="text-[11px] font-bold uppercase tracking-widest text-[#64748B] flex items-center gap-2">
              <span className="w-4 h-4 rounded-full bg-[#7C3AED] text-white text-[10px] flex items-center justify-center font-bold shadow-[0_0_8px_rgba(124,58,237,0.5)]">
                2
              </span>
              场景图上传与 9:16 裁切
            </label>

            {!scenePreviewUrl ? (
              <label className="border-2 border-dashed border-[#2D2D33] hover:border-[#7C3AED]/50 rounded-2xl p-6 flex flex-col items-center justify-center cursor-pointer transition bg-[#0F0F12] text-[#94A3B8] group">
                <Crop className="w-8 h-8 text-[#64748B] group-hover:text-[#A855F7] transition-colors mb-2" />
                <span className="text-xs font-medium text-[#CBD5E1]">点击或拖拽上传场景基底图 (JPEG/PNG)</span>
                <span className="text-[10px] text-[#64748B] mt-1">自动定位主人物进行角色替换</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleSceneFileChange}
                  className="hidden"
                />
              </label>
            ) : (
              <div className="space-y-3">
                <div className="relative aspect-[9/16] w-full max-w-[200px] mx-auto rounded-xl overflow-hidden bg-black border border-[#2D2D33] shadow-lg">
                  <img
                    src={scenePreviewUrl}
                    alt="scene_preview"
                    style={{ transform: `scale(${cropZoom / 100})` }}
                    className="w-full h-full object-cover transition-transform"
                  />
                  <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/80 text-[10px] text-[#CBD5E1] font-mono border border-white/10">
                    9:16 构图
                  </span>
                </div>

                <div className="flex items-center space-x-3 text-xs text-[#94A3B8]">
                  <span>缩放:</span>
                  <input
                    type="range"
                    min="100"
                    max="300"
                    value={cropZoom}
                    onChange={(e) => setCropZoom(Number(e.target.value))}
                    className="w-full accent-[#7C3AED]"
                  />
                  <span className="font-mono text-xs w-8 text-[#E2E8F0]">{cropZoom}%</span>
                </div>

                <div className="flex justify-end items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setSceneFile(null);
                      setScenePreviewUrl(null);
                    }}
                    className="text-xs text-rose-400 hover:text-rose-300 font-medium cursor-pointer"
                  >
                    清空场景图
                  </button>
                  <label className="text-xs text-[#A855F7] hover:text-[#C084FC] cursor-pointer font-medium">
                    更换场景图
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={handleSceneFileChange}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
            )}

            {/* Bypass First-Frame Reconstruction Option */}
            <div className="p-3 bg-[#16161A] border border-[#2D2D33] rounded-xl space-y-2 transition duration-200">
              <label className="flex items-start space-x-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isBypassReconstruction}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setIsBypassReconstruction(checked);
                    const mode = checked ? 'animate_existing_character' : 'replace_primary_person';
                    setSceneMode(mode);
                    if (currentTask) {
                      currentTask.sceneMode = mode;
                      setCurrentTask({ ...currentTask });
                    }
                  }}
                  className="mt-0.5 rounded bg-[#0A0A0C] border-[#2D2D33] text-[#7C3AED] focus:ring-0"
                />
                <div className="text-[11px] leading-relaxed">
                  <span className="text-[#E2E8F0] font-semibold block">
                    场景图已包含所选母板角色 (取消强制首帧重造)
                  </span>
                  <span className="text-[#94A3B8] text-[10px] block mt-0.5">
                    禁止换脸、重绘发型或风格迁移。上传的原场景图将作为最高优先级首帧 (firstFrame)，母板图仅作为辅助身份参考。
                  </span>
                </div>
              </label>
            </div>
          </div>

          {/* Step 3: Prompt & Style Settings */}
          <div className="space-y-4 pt-5 border-t border-[#1F1F23]">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#64748B] flex items-center gap-2">
                <span className="w-4 h-4 rounded-full bg-[#7C3AED] text-white text-[10px] flex items-center justify-center font-bold shadow-[0_0_8px_rgba(124,58,237,0.5)]">
                  3
                </span>
                动作幅度与 Prompt 编译控制
              </label>
            </div>

            {/* Duration Selector */}
            <div>
              <label className="block text-[11px] font-bold text-[#64748B] uppercase tracking-wider mb-2">
                生成视频时长 (秒)
              </label>
              <div className="flex items-center gap-2">
                {[4, 6, 8].map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => setDurationSeconds(sec)}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition duration-150 flex items-center gap-1 cursor-pointer ${
                      durationSeconds === sec
                        ? 'bg-[#7C3AED] text-white shadow-[0_0_12px_rgba(124,58,237,0.35)] border border-[#A855F7]'
                        : 'bg-[#16161A] text-[#94A3B8] hover:text-white border border-[#2D2D33]'
                    }`}
                  >
                    <span>{sec} 秒</span>
                    {sec === 4 && <span className="text-[10px] opacity-80 font-normal">(推荐)</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* Motion Intensity Selector */}
            <div>
              <label className="block text-[11px] font-bold text-[#64748B] uppercase tracking-wider mb-2 flex items-center gap-1">
                <span>动作强度控制 (Motion Intensity)</span>
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { key: 'minimal', label: '微幅动作', desc: '眨眼、呼吸、发丝' },
                  { key: 'natural', label: '自然幅度', desc: '侧头、眼神、手部小动' },
                  { key: 'expressive', label: '大动作', desc: '抬手、明显走动变化' },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setMotionIntensity(item.key as MotionIntensity)}
                    className={`p-2.5 rounded-xl text-left border transition cursor-pointer ${
                      motionIntensity === item.key
                        ? 'bg-[#7C3AED]/20 border-[#7C3AED] text-white shadow-[0_0_10px_rgba(124,58,237,0.2)]'
                        : 'bg-[#16161A] border-[#2D2D33] text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <div className="text-xs font-bold">{item.label}</div>
                    <div className="text-[10px] opacity-70 mt-0.5">{item.desc}</div>
                  </button>
                ))}
              </div>

              {motionIntensity === 'expressive' && (
                <div className="mt-2 p-2 rounded-lg bg-amber-950/40 border border-amber-800/60 text-amber-300 text-[11px] flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                  <span>⚠️ expressive 档位包含较大肢体幅度，存在微小身份漂移风险。</span>
                </div>
              )}
            </div>

            {/* Primary Style Presets */}
            <div>
              <label className="block text-[11px] font-bold text-[#64748B] uppercase tracking-wider mb-2">
                主视觉风格预设 (Visual Style)
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {EASY_STYLE_PRESETS.map((preset) => {
                  const isSelected =
                    primaryStyle === preset.name ||
                    (Array.isArray(preset.matchKeys) && typeof primaryStyle === 'string' && preset.matchKeys.includes(primaryStyle));
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setPrimaryStyle(preset.name);
                        setCustomCompiledPrompt(null);
                      }}
                      className={`p-2.5 rounded-xl text-left border transition cursor-pointer flex flex-col justify-between ${
                        isSelected
                          ? 'bg-[#7C3AED]/20 border-[#7C3AED] text-white shadow-[0_0_12px_rgba(124,58,237,0.25)]'
                          : 'bg-[#16161A] border-[#2D2D33] text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                      }`}
                    >
                      <div className="flex items-center justify-between w-full mb-1">
                        <span className={`text-xs font-bold ${isSelected ? 'text-white' : 'text-zinc-200'}`}>
                          {preset.name}
                        </span>
                        {preset.badge && (
                          <span
                            className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${
                              isSelected
                                ? 'bg-[#7C3AED] text-white'
                                : 'bg-zinc-800 text-zinc-400'
                            }`}
                          >
                            {preset.badge}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-zinc-400 leading-tight">
                        {preset.desc}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Camera Motion Preset */}
            <div>
              <label className="block text-[11px] font-bold text-[#64748B] uppercase tracking-wider mb-2">运镜与机位控制 (Camera Motion & Framing)</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { key: 'locked_camera', label: '锁定机位', sub: 'Locked Camera' },
                  { key: 'slow_push', label: '缓慢推镜', sub: 'Push In' },
                  { key: 'slow_pull', label: '缓慢拉镜', sub: 'Pull Out' },
                  { key: 'subtle_pan', label: '平稳横摇', sub: 'Pan Track' },
                  { key: 'vertical_boom', label: '纵向升降', sub: 'Pedestal Boom' },
                  { key: 'subtle_orbit', label: '弧形环绕', sub: 'Arc Orbit' },
                  { key: 'tracking_shot', label: '平行跟随', sub: 'Tracking' },
                  { key: 'close_up', label: '面部特写', sub: 'Close-Up' },
                ].map((cam) => (
                  <button
                    key={cam.key}
                    type="button"
                    onClick={() => {
                      setCameraPreset(cam.key);
                      setCustomCompiledPrompt(null);
                    }}
                    className={`px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer text-left flex flex-col justify-between ${
                      cameraPreset === cam.key
                        ? 'bg-[#7C3AED] text-white font-semibold shadow-md shadow-purple-900/30 border border-purple-500/40'
                        : 'bg-[#16161A] text-zinc-400 border border-[#2D2D33] hover:text-zinc-200 hover:border-zinc-700'
                    }`}
                  >
                    <span className="font-medium text-xs">{cam.label}</span>
                    <span className={`text-[10px] ${cameraPreset === cam.key ? 'text-purple-200' : 'text-zinc-500'}`}>{cam.sub}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* AI Prompt Generator & User Raw Motion Prompt Input */}
            <div className="pt-2 border-t border-[#1F1F23]">
              <div className="flex items-center justify-between mb-2">
                <label className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider flex items-center gap-1.5">
                  <span>用户动作需求与 Prompt 生成</span>
                </label>
                <button
                  type="button"
                  onClick={handleAutoSuggestPrompt}
                  disabled={isGeneratingPrompt || (!sceneFile && !selectedCharacterId)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 transition duration-150 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shadow-[0_0_12px_rgba(124,58,237,0.3)]"
                  title="根据已选的时长、动作强度、视觉风格与运镜设置，智能分析素材并生成定制提示词"
                >
                  {isGeneratingPrompt ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin text-purple-200" />
                      <span>根据已选参数 AI 思考生成中...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                      <span>【AI 智能生成提示词】</span>
                    </>
                  )}
                </button>
              </div>
              <textarea
                rows={3}
                placeholder="选择完上方时长、动作强度、风格与运镜后，点击【AI 智能生成提示词】自动结合已选参数生成提示词，或在此手动输入自定义动作描述..."
                value={userPrompt}
                onChange={(e) => {
                  setUserPrompt(e.target.value);
                  setCustomCompiledPrompt(null);
                }}
                className="w-full bg-[#16161A] border border-[#2D2D33] rounded-xl p-3 text-xs text-[#E2E8F0] focus:outline-none focus:border-[#7C3AED] transition"
              />
            </div>

            {/* Server Prompt Compiler Inspector Card */}
            <div className="p-3 bg-[#111115] border border-[#2D2D33] rounded-2xl space-y-2">
              <div
                onClick={() => setShowCompilerInspector(!showCompilerInspector)}
                className="flex items-center justify-between cursor-pointer select-none group"
              >
                <div className="flex items-center gap-1.5 font-bold text-xs text-indigo-300 group-hover:text-indigo-200">
                  <Sliders className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Prompt 编译引擎 Inspector (v{compiledResult.compilerVersion})</span>
                </div>
                <div className="flex items-center gap-2">
                  {customCompiledPrompt !== null && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCustomCompiledPrompt(null);
                      }}
                      className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-indigo-300 bg-indigo-950/60 border border-indigo-700/60 hover:bg-indigo-900/80 transition"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>恢复系统推荐</span>
                    </button>
                  )}
                  <span className="text-[11px] text-indigo-400 group-hover:text-indigo-300 font-mono flex items-center gap-1 font-medium">
                    {showCompilerInspector ? '▼ 折叠细节' : '▶ 展开推演细节'}
                  </span>
                </div>
              </div>

              {showCompilerInspector ? (
                <div className="space-y-2 text-[11px] font-mono text-zinc-400 pt-2 border-t border-[#2D2D33]">
                  <div>
                    <span className="text-zinc-500 block text-[10px] uppercase">① 角色身份约束 (Identity Traits)</span>
                    <div className="p-2 bg-[#18181C] rounded-lg text-zinc-300 mt-1 leading-snug">
                      {compiledResult.identityConstraints || '已自动从母板过滤并保留面部/发型特征'}
                    </div>
                  </div>

                  <div>
                    <span className="text-zinc-500 block text-[10px] uppercase">② 运镜与稳定性约束 (Camera & Stability)</span>
                    <div className="p-2 bg-[#18181C] rounded-lg text-zinc-300 mt-1 leading-snug">
                      {compiledResult.cameraConstraints}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-zinc-500 text-[10px] uppercase">③ 最终送入 Veo 引擎的 Compiled Prompt</span>
                      {customCompiledPrompt !== null && <span className="text-amber-400 text-[10px]">(已手动修改)</span>}
                    </div>
                    <textarea
                      rows={4}
                      value={activeCompiledPrompt}
                      onChange={(e) => setCustomCompiledPrompt(e.target.value)}
                      className="w-full bg-[#18181C] border border-[#3F3F46] rounded-lg p-2.5 text-xs text-indigo-100 font-sans focus:outline-none focus:border-[#7C3AED] transition"
                    />
                  </div>
                </div>
              ) : (
                <div className="text-[11px] font-mono text-zinc-500 truncate flex items-center justify-between pt-1 border-t border-[#1E1E24]">
                  <span className="truncate max-w-[80%]">编译结果：{activeCompiledPrompt}</span>
                  <span className="text-[10px] text-zinc-400 shrink-0">点击展开详细细节</span>
                </div>
              )}
            </div>

            {/* Default Engine & Spec Info Card */}
            <div className="p-3 bg-[#16161A] border border-[#2D2D33] rounded-xl space-y-1 text-xs">
              <div className="flex items-center justify-between text-emerald-400 font-semibold">
                <span>默认引擎：{generationConfig.modelId}</span>
                <span className="text-amber-300 font-mono font-bold">
                  预计费用：按 {generationConfig.durationSeconds} 秒计约 ${(generationConfig.durationSeconds * 0.20).toFixed(2)}
                </span>
              </div>
              <div className="text-[11px] text-[#94A3B8] font-mono">
                当前规格：{generationConfig.resolution} / {generationConfig.aspectRatio} / {generationConfig.durationSeconds}秒 / 无音频
              </div>
            </div>
          </div>

          {/* Generate Button */}
          <button
            onClick={handleGenerate}
            disabled={isExecuting || !selectedCharacterId || !sceneFile}
            className="w-full py-3.5 rounded-xl bg-[#7C3AED] hover:bg-[#6D28D9] disabled:bg-[#16161A] disabled:text-[#64748B] text-white font-bold text-sm transition duration-150 shadow-[0_4px_20px_rgba(124,58,237,0.35)] flex items-center justify-center gap-2 cursor-pointer"
          >
            {isExecuting ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>流水线合成中 ({elapsedSeconds}s)...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>一键确认并提交生成 ({generationConfig.durationSeconds}s)</span>
              </>
            )}
          </button>
        </div>

        {/* Right Column: Production Display & Realtime QA */}
        <div className="lg:col-span-7 bg-[#0A0A0C] border border-[#1F1F23] rounded-2xl p-4 sm:p-6 space-y-6 shadow-xl">
          {!currentTask ? (
            <div className="min-h-[400px] flex flex-col items-center justify-center text-center space-y-3 text-zinc-500">
              <Film className="w-12 h-12 text-zinc-700" />
              <p className="text-sm">在左侧设置场景与动作描述，点击「一键执行」开工</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Task Header & Timeline Status */}
              <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        currentTask.status === 'completed'
                          ? 'bg-emerald-500'
                          : currentTask.status === 'failed'
                          ? 'bg-rose-500'
                          : 'bg-indigo-500 animate-pulse'
                      }`}
                    />
                    <span className="font-bold text-zinc-200 text-sm">{currentTask.progressStage}</span>
                  </div>
                  <span className="font-mono text-xs text-indigo-400">{elapsedSeconds}s</span>
                </div>

                <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-indigo-500 h-full transition-all duration-300"
                    style={{ width: `${currentTask.progressPercent}%` }}
                  />
                </div>
              </div>

              {/* Waiting Approval CTA */}
              {currentTask.status === 'waiting_first_frame_approval' && (
                <div className="p-4 rounded-lg bg-indigo-950/40 border border-indigo-800/60 text-xs space-y-3">
                  <div className="font-bold text-indigo-300">首帧构建质检已通过，等待您的确认：</div>
                  <button
                    onClick={handleContinueApproval}
                    className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium"
                  >
                    确认首帧，继续驱动视频生成
                  </button>
                </div>
              )}

              {/* First Frame Candidates Grid */}
              {currentTask.firstFrameCandidates && currentTask.firstFrameCandidates.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-zinc-300">首帧确认 (直通模式直接取上传场景图)</h4>
                  <div className="grid grid-cols-2 gap-3">
                    {(currentTask.firstFrameCandidates || []).map((cand) => (
                      <div
                        key={cand.id}
                        onClick={() =>
                          setZoomImageUrl(cand.dataUrl || safeCreateObjectURL(cand.blob))
                        }
                        className="relative group aspect-[9/16] rounded-lg bg-black overflow-hidden border border-zinc-800 cursor-pointer"
                      >
                        <img
                          src={cand.dataUrl || safeCreateObjectURL(cand.blob)}
                          alt="candidate"
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                          <Maximize2 className="w-5 h-5 text-white" />
                        </div>
                        <div className="absolute bottom-2 left-2 flex flex-col gap-1 text-[10px] font-mono">
                          <span className="px-1.5 py-0.5 rounded bg-black/80 text-emerald-400 border border-emerald-500/30">
                            首帧模式：原图直通
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-black/80 text-zinc-300 border border-zinc-700">
                            身份自动质检：未执行
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-black/80 text-zinc-300 border border-zinc-700">
                            角色母板发送数量：0
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Video Result Player */}
              {(currentTask.videoResult || currentTask.resultVideoUrl) && (() => {
                let activeVideoUrl = currentTask.videoResult?.blob
                  ? safeCreateObjectURL(currentTask.videoResult.blob)
                  : currentTask.resultVideoUrl;
                if (!activeVideoUrl) return null;

                if (activeVideoUrl.startsWith('/api/videos/stream/')) {
                  const vUri = currentTask.videoUri || (currentTask as any).outputUri;
                  const opName = currentTask.externalOperationName || (currentTask as any).operationName;
                  const params = new URLSearchParams();
                  if (vUri && !activeVideoUrl.includes('videoUri=')) params.set('videoUri', vUri);
                  if (opName && !activeVideoUrl.includes('operationName=')) params.set('operationName', opName);
                  const q = params.toString();
                  if (q) activeVideoUrl += (activeVideoUrl.includes('?') ? '&' : '?') + q;
                }

                return (
                  <div className="space-y-4">
                    <h4 className="text-xs font-semibold text-zinc-300">8 秒高帧率 MP4 成品视频</h4>
                    <div className="aspect-[9/16] max-w-xs mx-auto rounded-xl bg-black overflow-hidden border border-zinc-800 shadow-2xl relative">
                      <video
                        src={activeVideoUrl}
                        controls
                        loop
                        autoPlay
                        className="w-full h-full object-contain"
                      />
                    </div>

                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          if (!activeVideoUrl) {
                            alert('当前暂无有效 MP4 视频渲染结果。若需要恢复视频，请前往任务列表点击【重新获取视频】或【重新生成】。');
                            return;
                          }
                          downloadVideoFile(activeVideoUrl, `zaojing_${currentTask.id}.mp4`);
                        }}
                        className="px-6 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs flex items-center gap-2 transition shadow-lg cursor-pointer"
                      >
                        <Download className="w-4 h-4" />
                        下载无水印原画 MP4
                      </button>
                      <a
                        href={activeVideoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-4 py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium text-xs flex items-center gap-1.5 transition border border-zinc-700/60"
                      >
                        <Film className="w-3.5 h-3.5 text-zinc-400" />
                        新窗口播放/保存
                      </a>
                    </div>

                    {/* Google Cloud Storage Location & Console Link Card */}
                    <GcsLocationCard task={currentTask} />
                  </div>
                );
              })()}

              {/* Error Box */}
              {(currentTask.error || currentTask.status === 'failed') && (() => {
                const failInfo = getExplicitTaskFailureReason(currentTask);
                return (
                  <div className="p-4 rounded-xl bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 space-y-3.5 shadow-lg">
                    {/* Preview Environment Warning Notice */}
                    {(systemEnv?.environment === 'ai_studio_preview' || !systemEnv?.isCloudRun) && (
                      <div className="p-2.5 rounded-lg bg-amber-950/70 border border-amber-800/70 text-amber-200 text-[11px] leading-relaxed">
                        <span className="font-bold">⚠️ 开发环境提示：</span>
                        当前为 AI Studio Preview 开发环境。该环境不使用正式 Cloud Run 绑定的服务账号。请部署后访问正式 Cloud Run 地址验证 GCP Vertex AI 通道。
                      </div>
                    )}

                    <div className="space-y-2">
                      <div className="font-bold flex items-center justify-between text-rose-300">
                        <span className="flex items-center gap-1.5 text-sm">
                          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                          视频生成失败显性诊断
                        </span>
                        <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-rose-900/80 text-rose-300 border border-rose-700">
                          {failInfo.errorCode}
                        </span>
                      </div>

                      {/* Primary Explicit Failure Reason */}
                      <div className="p-3 rounded-lg bg-black/60 border border-rose-800/80 text-rose-100 font-medium text-xs leading-relaxed break-words space-y-1">
                        <div className="text-[11px] font-bold text-rose-400 flex items-center gap-1">
                          🚫 明确失败原因:
                        </div>
                        <div className="text-rose-100 text-xs leading-relaxed">
                          {String(failInfo.primaryReason || '视频生成任务中断')}
                        </div>
                      </div>

                      {/* Technical details if distinct */}
                      {failInfo.technicalDetails && (
                        <div className="p-2.5 rounded-lg bg-black/40 border border-zinc-800 font-mono text-[11px] text-rose-300/90 leading-relaxed break-words">
                          <span className="text-zinc-400 font-bold">底层异常详情: </span>
                          {String(failInfo.technicalDetails)}
                        </div>
                      )}

                      <div className="text-[11px] text-amber-300 font-medium bg-amber-950/30 p-2 rounded border border-amber-900/40 leading-relaxed">
                        💡 建议动作: {String(failInfo.recommendedAction || '请检查提示词与入参')}
                      </div>
                    </div>

                    {/* Collapsible Technical Diagnostics */}
                    <div className="pt-2 border-t border-rose-800/40">
                      <button
                        onClick={() => setShowDiagnostics(!showDiagnostics)}
                        className="text-[11px] text-zinc-400 hover:text-zinc-200 underline font-mono flex items-center gap-1 cursor-pointer"
                      >
                        {showDiagnostics ? '▼ 隐藏完整技术诊断信息' : '▶ 展开完整技术诊断信息 (Technical Diagnostics)'}
                      </button>

                      {showDiagnostics && (
                        <div className="mt-2.5 p-3 rounded-lg bg-black/80 border border-zinc-800 text-[11px] font-mono space-y-1.5 text-zinc-300 overflow-x-auto">
                          <div className="text-emerald-400 font-bold border-b border-zinc-800 pb-1 flex justify-between">
                            <span>【技术诊断节点】</span>
                            <span>{String(currentTask.error?.buildVersion || '2.0.0-v2.0-cinema')}</span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-zinc-400">
                            <div>source: <span className="text-zinc-200 font-semibold">{String(typeof currentTask.error?.source === 'object' ? JSON.stringify(currentTask.error?.source) : (currentTask.error?.source || 'unknown'))}</span></div>
                            <div>failureStage: <span className="text-zinc-200 font-semibold">{String(typeof currentTask.error?.failureStage === 'object' ? JSON.stringify(currentTask.error?.failureStage) : (currentTask.error?.failureStage || 'submit'))}</span></div>
                            <div>httpStatus: <span className="text-zinc-200 font-semibold">{String(currentTask.error?.httpStatus ?? 'N/A')}</span></div>
                            <div>googleStatus: <span className="text-zinc-200 font-semibold">{String(typeof currentTask.error?.googleStatus === 'object' ? JSON.stringify(currentTask.error?.googleStatus) : (currentTask.error?.googleStatus || 'N/A'))}</span></div>
                            <div>endpointHost: <span className="text-zinc-200 font-semibold">{String(typeof currentTask.error?.endpointHost === 'object' ? JSON.stringify(currentTask.error?.endpointHost) : (currentTask.error?.endpointHost || 'aiplatform.googleapis.com'))}</span></div>
                            <div>actualModel: <span className="text-indigo-300 font-semibold">{String(typeof currentTask.error?.actualModel === 'object' ? JSON.stringify(currentTask.error?.actualModel) : (currentTask.error?.actualModel || 'veo-3.1-fast-generate-001'))}</span></div>
                            <div>projectId: <span className="text-indigo-300 font-semibold">{String(typeof currentTask.error?.projectId === 'object' ? JSON.stringify(currentTask.error?.projectId) : (currentTask.error?.projectId || 'xp-vertex-project'))}</span></div>
                            <div>region: <span className="text-indigo-300 font-semibold">{String(typeof currentTask.error?.region === 'object' ? JSON.stringify(currentTask.error?.region) : (currentTask.error?.region || 'us-central1'))}</span></div>
                            <div>taskId: <span className="text-zinc-300">{String(currentTask.error?.taskId || currentTask.id)}</span></div>
                            <div>traceId: <span className="text-zinc-300">{String(typeof currentTask.error?.traceId === 'object' ? JSON.stringify(currentTask.error?.traceId) : (currentTask.error?.traceId || 'N/A'))}</span></div>
                            <div>K_REVISION: <span className="text-zinc-300">{String(typeof currentTask.error?.revision === 'object' ? JSON.stringify(currentTask.error?.revision) : (currentTask.error?.revision || systemEnv?.K_REVISION || 'preview'))}</span></div>
                            <div>environment: <span className="text-amber-300 font-bold">{String(systemEnv?.environment || 'ai_studio_preview')}</span></div>
                            <div className="col-span-1 sm:col-span-2">
                              actualPrincipalEmail: <span className="text-amber-300 font-bold">{String(systemEnv?.actualPrincipalEmail || 'adc-runtime-account@cloud.google')}</span>
                            </div>
                          </div>
                          <div className="pt-1 border-t border-zinc-800/60 text-rose-300/90 whitespace-pre-wrap break-words">
                            <span className="text-zinc-400">technicalMessage:</span> {String(failInfo.primaryReason)}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="pt-2 border-t border-rose-800/40 flex flex-wrap items-center gap-3">
                      <button
                        onClick={handleGenerate}
                        disabled={isExecuting}
                        className="px-3 py-1.5 rounded-md bg-rose-900/60 hover:bg-rose-800/80 border border-rose-700/60 text-white text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isExecuting ? 'animate-spin' : ''}`} />
                        重新尝试生成
                      </button>

                      <button
                        onClick={handleCopyCurrentTaskParams}
                        className="px-3 py-1.5 rounded-md bg-indigo-950 hover:bg-indigo-900 border border-indigo-700/60 text-indigo-200 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
                        title="一键复制本任务调整用入参与出参"
                      >
                        {isCopiedCurrentTaskParams ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span>已复制执行参数</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5 text-indigo-400" />
                            <span>复制执行参数</span>
                          </>
                        )}
                      </button>

                      <button
                        onClick={onNavigateToSettings}
                        className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 text-xs font-medium transition cursor-pointer"
                      >
                        前往【算力设置】
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        {/* Footer Build Metadata Display */}
        <div className="mt-8 pt-4 border-t border-zinc-800/60 text-[10px] text-zinc-500 font-mono flex flex-wrap items-center justify-between gap-2 px-2">
          <div>
            Build: <span className="text-zinc-400">{systemEnv?.buildVersion || '2.0.0-v2.0-cinema'}</span> |
            Timestamp: <span className="text-zinc-400">{systemEnv?.buildTimestamp || '2026-08-05T19:00:00Z'}</span> |
            Commit: <span className="text-zinc-400">{systemEnv?.commitHash || 'v2.0-cinema-release'}</span>
          </div>
          <div>
            Env: <span className="text-amber-400">{systemEnv?.environment || 'ai_studio_preview'}</span> |
            K_REVISION: <span className="text-zinc-400">{systemEnv?.K_REVISION || 'none'}</span>
          </div>
        </div>
      </div>

      {/* Task Generation Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#111115] border border-[#2D2D33] rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#2D2D33] pb-3">
              <div className="flex items-center gap-2 font-bold text-base text-white">
                <Sparkles className="w-5 h-5 text-[#7C3AED]" />
                <span>确认提交 Veo 视频生成任务</span>
              </div>
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="text-zinc-400 hover:text-white text-lg font-bold"
              >
                ×
              </button>
            </div>

            <div className="space-y-3 text-xs text-zinc-300">
              <div className="grid grid-cols-2 gap-2 p-3 bg-[#18181C] rounded-xl font-mono">
                <div>
                  <span className="text-zinc-500 block">生成时长</span>
                  <span className="text-indigo-300 font-bold text-sm">{generationConfig.durationSeconds} 秒</span>
                </div>
                <div>
                  <span className="text-zinc-500 block">图像分辨率</span>
                  <span className="text-zinc-200 font-bold text-sm">{generationConfig.resolution}</span>
                </div>
                <div>
                  <span className="text-zinc-500 block">画幅比例</span>
                  <span className="text-zinc-200 font-bold text-sm">{generationConfig.aspectRatio}</span>
                </div>
                <div>
                  <span className="text-zinc-500 block">预计算力消耗</span>
                  <span className="text-amber-300 font-bold text-sm">${(generationConfig.durationSeconds * 0.20).toFixed(2)}</span>
                </div>
              </div>

              <div className="p-3 bg-[#18181C] rounded-xl space-y-1">
                <span className="text-zinc-500 font-mono text-[10px] block uppercase">首帧与母板策略</span>
                <div className="text-emerald-400 font-medium">首帧原图直通模式 (免重建 / 零母板发送)</div>
                <div className="text-[10px] text-zinc-400">禁止对场景原图进行换脸、重绘发型或微结构重建</div>
              </div>

              <div className="p-3 bg-[#18181C] rounded-xl space-y-1">
                <span className="text-zinc-500 font-mono text-[10px] block uppercase">最终 Compiled Prompt (Preview)</span>
                <div className="text-zinc-300 font-sans line-clamp-3 leading-relaxed text-[11px]">
                  {activeCompiledPrompt}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 py-2.5 rounded-xl bg-[#1D1D23] hover:bg-[#272730] text-zinc-300 font-medium text-xs transition border border-[#2D2D33]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={startGenerateTask}
                className="flex-1 py-2.5 rounded-xl bg-[#7C3AED] hover:bg-[#6D28D9] text-white font-bold text-xs transition shadow-[0_0_15px_rgba(124,58,237,0.4)] flex items-center justify-center gap-1.5"
              >
                <Sparkles className="w-4 h-4" />
                <span>确认并提交生成</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Zoom Modal */}
      {zoomImageUrl && (
        <div
          onClick={() => setZoomImageUrl(null)}
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 cursor-zoom-out"
        >
          <img src={zoomImageUrl} alt="zoom" className="max-h-[90vh] max-w-full rounded-lg object-contain" />
        </div>
      )}
    </div>
  );
};
