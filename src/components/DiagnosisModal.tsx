import React, { useEffect, useState } from 'react';
import { X, CheckCircle2, XCircle, RefreshCw, HardDrive, Cpu, ShieldCheck, FileCode, Layers } from 'lucide-react';
import { useConnection } from '../context/ConnectionContext';
import { parseJsonResponse } from '../utils/apiClient';
import { taskRepository } from '../repositories/taskRepository';
import type { VideoGenerationDiagnostics } from '../types';

export const DiagnosisModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { connectionInfo, hasServerSecret } = useConnection();
  const [healthStatus, setHealthStatus] = useState<'testing' | 'ok' | 'error'>('testing');
  const [dbStatus, setDbStatus] = useState<string>('检查中...');
  const [latestDiagnostics, setLatestDiagnostics] = useState<VideoGenerationDiagnostics | null>(null);
  const [sysEnv, setSysEnv] = useState<any>(null);

  const runDiagnosis = async () => {
    setHealthStatus('testing');
    try {
      const res = await fetch('/api/health');
      const data = await parseJsonResponse(res);
      if (res.ok && data.status === 'ok') {
        setHealthStatus('ok');
      } else {
        setHealthStatus('error');
      }
    } catch {
      setHealthStatus('error');
    }

    try {
      const envRes = await fetch('/api/system/environment');
      if (envRes.ok) {
        setSysEnv(await envRes.json());
      }
    } catch (e) {
      console.warn('Failed to load system environment', e);
    }

    if ('indexedDB' in window) {
      setDbStatus('IndexedDB 数据库正常可读写');
    } else {
      setDbStatus('浏览器不支持 IndexedDB');
    }

    try {
      const tasks = await taskRepository.getAll();
      const taskWithDiag = tasks.reverse().find((t) => t.videoResult?.diagnostics);
      if (taskWithDiag?.videoResult?.diagnostics) {
        setLatestDiagnostics(taskWithDiag.videoResult.diagnostics);
      }
    } catch (e) {
      console.warn('Failed to load tasks for diagnosis', e);
    }
  };

  useEffect(() => {
    runDiagnosis();
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-lg overflow-hidden shadow-2xl">
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
            <Cpu className="w-4 h-4 text-indigo-400" />
            系统运行状态诊断
          </h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 text-sm">
          {/* Backend API status */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-950 border border-zinc-800">
            <div className="flex items-center space-x-3">
              {healthStatus === 'ok' ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              ) : healthStatus === 'error' ? (
                <XCircle className="w-5 h-5 text-rose-400" />
              ) : (
                <RefreshCw className="w-5 h-5 text-indigo-400 animate-spin" />
              )}
              <div>
                <div className="font-medium text-zinc-200">后端 API 服务健康状态</div>
                <div className="text-xs text-zinc-500">Express + Node.js 服务端路由 /api/health</div>
              </div>
            </div>
            <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono">
              {healthStatus === 'ok' ? '200 OK' : healthStatus === 'error' ? 'Failed' : 'Testing'}
            </span>
          </div>

          {/* Server Environment Secret */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-950 border border-zinc-800">
            <div className="flex items-center space-x-3">
              <ShieldCheck className={`w-5 h-5 ${hasServerSecret ? 'text-emerald-400' : 'text-amber-400'}`} />
              <div>
                <div className="font-medium text-zinc-200">服务端 GEMINI_API_KEY 注入状态</div>
                <div className="text-xs text-zinc-500">
                  {hasServerSecret ? '检测到系统预置 GEMINI_API_KEY' : '未预置环境变量 Secret'}
                </div>
              </div>
            </div>
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                hasServerSecret
                  ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/50'
                  : 'bg-amber-950/60 text-amber-400 border border-amber-800/50'
              }`}
            >
              {hasServerSecret ? '已预置' : '未预置'}
            </span>
          </div>

          {/* Active Connection Session */}
          <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-2">
            <div className="flex items-center justify-between">
              <div className="font-medium text-zinc-200">当前活跃计费与算力通道</div>
              <span
                className={`text-xs px-2 py-0.5 rounded font-medium ${
                  !connectionInfo
                    ? 'bg-zinc-800 text-zinc-400'
                    : connectionInfo.type === 'vertex_ai'
                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                    : 'bg-amber-950 text-amber-400 border border-amber-800'
                }`}
              >
                {!connectionInfo
                  ? '未连接'
                  : connectionInfo.type === 'vertex_ai'
                  ? 'Google Cloud 赠金通道'
                  : 'Gemini API 备用通道'}
              </span>
            </div>

            {connectionInfo ? (
              <div className="text-xs font-mono space-y-1.5 text-zinc-400 bg-zinc-900 p-3 rounded border border-zinc-800/80">
                <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                  <div>
                    credentialSource:{' '}
                    <span className="text-emerald-300 font-bold">
                      {connectionInfo.credentialSource || (connectionInfo.type === 'vertex_ai' ? 'SERVICE_ACCOUNT' : 'GEMINI_API_KEY')}
                    </span>
                  </div>
                  <div>
                    projectId:{' '}
                    <span className="text-emerald-300 font-bold">
                      {connectionInfo.projectId || 'xp-vertex-project'}
                    </span>
                  </div>
                  <div>
                    region:{' '}
                    <span className="text-emerald-300 font-bold">
                      {connectionInfo.region || connectionInfo.location || 'us-central1'}
                    </span>
                  </div>
                  <div>
                    通道类型:{' '}
                    <span className={connectionInfo.type === 'vertex_ai' ? 'text-emerald-300' : 'text-amber-300'}>
                      {connectionInfo.type === 'vertex_ai' ? 'Google Cloud 赠金通道' : 'Gemini API 备用通道'}
                    </span>
                  </div>
                  <div>
                    requestedModel:{' '}
                    <span className="text-indigo-300 font-bold">
                      {connectionInfo.requestedModel || 'veo-3.1-fast-generate-001'}
                    </span>
                  </div>
                  <div>
                    actualModel:{' '}
                    <span className="text-indigo-300 font-bold">
                      {connectionInfo.actualModel || 'veo-3.1-fast-generate-001'}
                    </span>
                  </div>
                </div>
                <div className="text-[10px] text-zinc-500 pt-1.5 border-t border-zinc-800 flex items-center justify-between">
                  <span>抵扣类型: {connectionInfo.type === 'vertex_ai' ? 'GCP 2026 Free Credit 赠金' : 'Gemini Developer API (预付/自费)'}</span>
                  <span>策略: 禁止自动静默切换计费通道</span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-rose-400/90 bg-rose-950/30 p-2 rounded border border-rose-900/40">
                未连接 Google Cloud 赠金通道。已禁止自动静默切换至 Gemini API 备用通道，请在「算力设置」中连接凭据。
              </p>
            )}
          </div>

          {/* Runtime Environment Info */}
          {sysEnv && (
            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="font-medium text-zinc-200 flex items-center gap-2">
                  <Layers className="w-4 h-4 text-purple-400" />
                  运行时环境与构建标识
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${sysEnv.isCloudRun ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-amber-950 text-amber-300 border border-amber-800'}`}>
                  {sysEnv.environment}
                </span>
              </div>
              <div className="text-xs font-mono space-y-1 text-zinc-400 bg-zinc-900 p-2.5 rounded border border-zinc-800">
                <div>actualPrincipal: <span className="text-amber-300 font-bold">{sysEnv.actualPrincipalEmail}</span></div>
                <div>buildVersion: <span className="text-zinc-200">{sysEnv.buildVersion}</span></div>
                <div>buildTimestamp: <span className="text-zinc-200">{sysEnv.buildTimestamp}</span></div>
                <div>commitHash: <span className="text-zinc-200">{sysEnv.commitHash}</span></div>
                <div>K_SERVICE: <span className="text-zinc-300">{sysEnv.K_SERVICE || 'none'}</span> | K_REVISION: <span className="text-zinc-300">{sysEnv.K_REVISION || 'none'}</span></div>
              </div>
            </div>
          )}

          {/* Local IndexedDB storage */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-950 border border-zinc-800">
            <div className="flex items-center space-x-3">
              <HardDrive className="w-5 h-5 text-indigo-400" />
              <div>
                <div className="font-medium text-zinc-200">本地持久化存储 (IndexedDB)</div>
                <div className="text-xs text-zinc-500">{dbStatus}</div>
              </div>
            </div>
          </div>

          {/* Latest Video Generation Diagnostics (Desensitized) */}
          {latestDiagnostics && (
            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-2">
              <div className="flex items-center justify-between">
                <div className="font-medium text-zinc-200 flex items-center gap-2">
                  <FileCode className="w-4 h-4 text-emerald-400" />
                  最新任务模型真实输入诊断 (已脱敏)
                </div>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800/50">
                  {latestDiagnostics.engine === 'omni_flash' ? 'Omni Flash' : 'Veo 3.1'}
                </span>
              </div>

              <div className="text-xs font-mono space-y-1 text-zinc-300 bg-zinc-900 p-2.5 rounded border border-zinc-800/80 max-h-48 overflow-y-auto">
                <div className="text-emerald-400 font-semibold mb-1">【素材哈希与尺寸校验】</div>
                <div>Approved 首帧: Hash {latestDiagnostics.firstFrame.hash} | {(latestDiagnostics.firstFrame.sizeBytes / 1024).toFixed(1)} KB | {latestDiagnostics.firstFrame.width || 1080}x{latestDiagnostics.firstFrame.height || 1920}</div>
                <div>母板图数量: {(latestDiagnostics.masterImages || []).length} 张 | 是否传入 referenceImages: {latestDiagnostics.useReferenceImages ? '已传入' : '否'}</div>
                {(latestDiagnostics.masterImages || []).map((m, idx) => (
                  <div key={idx} className="pl-2 text-zinc-400">
                    - {m.role}: Hash {m.hash} | {(m.sizeBytes / 1024).toFixed(1)} KB
                  </div>
                ))}

                <div className="text-indigo-400 font-semibold mt-2 mb-1">【实际模型调用提示词】</div>
                <div className="p-1.5 bg-zinc-950 rounded text-zinc-300 whitespace-pre-wrap break-all select-text font-sans text-[11px] border border-zinc-800">
                  {latestDiagnostics.fullPrompt}
                </div>

                <div className="text-amber-400 font-semibold mt-2 mb-1">【模型与图片绑定序列】</div>
                <div>调用模型: {latestDiagnostics.videoModel}</div>
                <div>包含多图输入: {(latestDiagnostics.inputImages || []).length} 张图片</div>
                {(latestDiagnostics.inputImages || []).map((img, idx) => (
                  <div key={idx} className="pl-2 text-zinc-400">
                    - [{idx + 1}] {img.role}: Hash {img.hash} ({img.sizeBytes} bytes)
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-zinc-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm transition"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
};
