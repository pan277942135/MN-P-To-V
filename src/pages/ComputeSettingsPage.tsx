import React, { useState, useEffect } from 'react';
import { useConnection } from '../context/ConnectionContext';
import { parseJsonResponse, safeFetchApi } from '../utils/apiClient';
import { computeConfigRepository } from '../repositories/computeConfigRepository';
import {
  Server,
  Key,
  Cpu,
  CheckCircle2,
  AlertTriangle,
  Upload,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Database,
} from 'lucide-react';

export const ComputeSettingsPage: React.FC = () => {
  const { connectionInfo, hasServerSecret, setConnectionInfo, disconnect } = useConnection();

  const [activeTab, setActiveTab] = useState<'vertex_ai' | 'gemini_api_key' | 'server_env_secret'>(
    'vertex_ai'
  );

  // Form State - Vertex AI
  const [projectId, setProjectId] = useState('xp-vertex-project');
  const [location, setLocation] = useState('us-central1');
  const [serviceAccountJson, setServiceAccountJson] = useState('');

  // Form State - Gemini API Key
  const [apiKey, setApiKey] = useState('');

  // Model Config State
  const [analysisModel, setAnalysisModel] = useState('gemini-2.5-flash');
  const [imageModel, setImageModel] = useState('gemini-2.5-flash');
  const [videoModel, setVideoModel] = useState('veo-3.1-fast-generate-001');

  // UI state
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Load saved config from database (IndexedDB) on mount
  useEffect(() => {
    async function loadSavedConfig() {
      const saved = await computeConfigRepository.get();
      if (saved) {
        if (saved.activeTab) setActiveTab(saved.activeTab);
        if (saved.projectId) setProjectId(saved.projectId);
        if (saved.location) setLocation(saved.location);
        if (saved.serviceAccountJson) setServiceAccountJson(saved.serviceAccountJson);
        if (saved.apiKey) setApiKey(saved.apiKey);
        if (saved.analysisModel) setAnalysisModel(saved.analysisModel);
        if (saved.imageModel) setImageModel(saved.imageModel);
        if (saved.videoModel) setVideoModel(saved.videoModel);
      }

      if (connectionInfo) {
        if (connectionInfo.type) setActiveTab(connectionInfo.type);
        if (connectionInfo.projectId) setProjectId(connectionInfo.projectId);
        if (connectionInfo.location) setLocation(connectionInfo.location);
        if (connectionInfo.analysisModel) setAnalysisModel(connectionInfo.analysisModel);
        if (connectionInfo.imageModel) setImageModel(connectionInfo.imageModel);
        if (connectionInfo.videoModel) setVideoModel(connectionInfo.videoModel);
      }
    }

    loadSavedConfig();
  }, [connectionInfo]);

  // Save compute configuration to IndexedDB database
  const saveToDatabase = async () => {
    await computeConfigRepository.save({
      activeTab,
      projectId: projectId.trim() || 'xp-vertex-project',
      location: location.trim() || 'us-central1',
      serviceAccountJson: serviceAccountJson.trim(),
      apiKey: apiKey.trim(),
      analysisModel: analysisModel.trim() || 'gemini-2.5-flash',
      imageModel: imageModel.trim() || 'gemini-2.5-flash',
      videoModel: videoModel.trim() || 'veo-3.1-fast-generate-001',
      autoConnect: true,
    });
  };

  const handleSaveDraftOnly = async () => {
    await saveToDatabase();
    setSuccessMsg('算力配置及凭据已成功保存入本地数据库（IndexedDB），再次进入时将自动读取！');
    setTimeout(() => setSuccessMsg(null), 4000);
  };

  const resetModelsToRecommended = () => {
    setAnalysisModel('gemini-2.5-flash');
    setImageModel('gemini-2.5-flash');
    setVideoModel('veo-3.1-fast-generate-001');
  };

  const handleJsonFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 100 * 1024) {
      setErrorMsg('JSON 凭据文件不得超过 100KB');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setServiceAccountJson(text);
      try {
        const parsed = JSON.parse(text);
        if (parsed.project_id) {
          setProjectId(parsed.project_id);
        }
      } catch {
        setErrorMsg('上传的文件非有效 JSON');
      }
    };
    reader.readAsText(file);
  };

  const handleConnect = async () => {
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      let body: any = {
        type: activeTab,
        analysisModel,
        imageModel,
        videoModel,
      };

      if (activeTab === 'vertex_ai') {
        if (!projectId.trim()) {
          throw new Error('请输入 Google Cloud Project ID');
        }
        if (!serviceAccountJson.trim()) {
          throw new Error('请上传或粘贴 Service Account JSON 凭据');
        }
        body.projectId = projectId.trim();
        body.location = location.trim() || 'global';
        body.serviceAccountJson = serviceAccountJson.trim();
      } else if (activeTab === 'gemini_api_key') {
        if (!apiKey.trim()) {
          if (hasServerSecret) {
            body.type = 'server_env_secret';
          } else {
            throw new Error('请输入 Gemini API Key');
          }
        } else {
          body.apiKey = apiKey.trim();
        }
      }

      const { res, data } = await safeFetchApi('/api/connections/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(data.error || '测试连接失败');
      }

      await saveToDatabase();

      setConnectionInfo(data.info);
      setSuccessMsg('算力凭据测试通过！完整配置及凭据已成功写入本地数据库 (IndexedDB) 并激活当前算力会话！');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleClearDatabase = async () => {
    await computeConfigRepository.clear();
    await disconnect();
    setProjectId('');
    setLocation('global');
    setServiceAccountJson('');
    setApiKey('');
    setSuccessMsg('数据库中保存的算力配置已清除！');
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-6 sm:space-y-8">
      <div>
        <h2 className="text-lg sm:text-xl font-bold text-zinc-100 flex items-center gap-2">
          <Server className="w-5 h-5 text-indigo-400" />
          算力连接与凭据设置
        </h2>
        <p className="text-xs sm:text-sm text-zinc-400 mt-1">
          配置 Google Cloud Vertex AI 或 Gemini API 算力通道。所有 API 均在 Node.js 服务端安全发起。
        </p>
      </div>

      {/* Active Connection Status Banner */}
      {connectionInfo && (
        <div className="p-4 rounded-xl bg-emerald-950/30 border border-emerald-800/50 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <div className="text-xs sm:text-sm font-semibold text-emerald-200 flex flex-wrap items-center gap-2">
                已成功激活算力连接会话
                <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full font-mono">
                  {connectionInfo.type === 'vertex_ai'
                    ? 'Google Cloud Vertex AI'
                    : connectionInfo.type === 'gemini_api_key'
                    ? 'Gemini API Key'
                    : '系统预置 GEMINI_API_KEY'}
                </span>
              </div>
              <div className="text-xs text-zinc-400 mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                {connectionInfo.projectId && <span>项目 ID: <code className="text-emerald-300 font-mono">{connectionInfo.projectId}</code></span>}
                {connectionInfo.location && <span>区域: <code className="text-zinc-300 font-mono">{connectionInfo.location}</code></span>}
                {connectionInfo.apiKeyMasked && <span>密钥: <code className="text-zinc-300 font-mono">{connectionInfo.apiKeyMasked}</code></span>}
                <span>视频模型: <code className="text-indigo-300 font-mono">{connectionInfo.videoModel}</code></span>
              </div>
            </div>
          </div>

          <button
            onClick={disconnect}
            className="px-3 py-1.5 rounded-lg bg-rose-950/50 hover:bg-rose-900/60 border border-rose-800/60 text-rose-300 text-xs font-medium transition self-end md:self-auto"
          >
            断开并清除会话
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex overflow-x-auto pb-1 space-x-2 border-b border-zinc-800">
        <button
          onClick={() => {
            setActiveTab('vertex_ai');
            setVideoModel('veo-3.1-fast-generate-001');
          }}
          className={`pb-3 px-3 sm:px-4 text-xs sm:text-sm font-medium transition border-b-2 flex items-center gap-2 whitespace-nowrap shrink-0 ${
            activeTab === 'vertex_ai'
              ? 'border-emerald-500 text-emerald-400 font-semibold'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Server className="w-4 h-4 text-emerald-400" />
          通道 1: Google Cloud 赠金通道 (Vertex AI / xp-vertex-project) [M1 默认抵扣]
        </button>

        <button
          onClick={() => {
            setActiveTab('gemini_api_key');
            setVideoModel('gemini-2.5-flash');
          }}
          className={`pb-3 px-3 sm:px-4 text-xs sm:text-sm font-medium transition border-b-2 flex items-center gap-2 whitespace-nowrap shrink-0 ${
            activeTab === 'gemini_api_key'
              ? 'border-amber-500 text-amber-400 font-semibold'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Key className="w-4 h-4 text-amber-400" />
          通道 2: Gemini API Key (手动备用通道)
        </button>

        {hasServerSecret && (
          <button
            onClick={() => {
              setActiveTab('server_env_secret');
              setVideoModel('gemini-2.5-flash');
            }}
            className={`pb-3 px-3 sm:px-4 text-xs sm:text-sm font-medium transition border-b-2 flex items-center gap-2 whitespace-nowrap shrink-0 ${
              activeTab === 'server_env_secret'
                ? 'border-amber-500 text-amber-400 font-semibold'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Cpu className="w-4 h-4 text-amber-400" />
            通道 2 (系统环境变量 API Key 备用)
          </button>
        )}
      </div>

      {/* Tab Content */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 sm:p-6 space-y-6">
        {activeTab === 'vertex_ai' && (
          <div className="space-y-4 text-sm">
            <div className="p-3 rounded-lg bg-emerald-950/40 border border-emerald-800/50 text-xs text-emerald-300">
              <span className="font-semibold text-emerald-200">Google Cloud 赠金通道（M1 默认通道）：</span>
              使用 2026年7月26日发放的 GCP Free Credit 赠金抵扣，API 请求经由 <code className="font-mono text-emerald-100">aiplatform.googleapis.com</code> 访问 Vertex AI / Agent Platform。
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block font-medium text-zinc-300 mb-1">Google Cloud Project ID</label>
                <input
                  type="text"
                  placeholder="xp-vertex-project"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 focus:outline-none focus:border-emerald-500 font-mono text-sm"
                />
              </div>

              <div>
                <label className="block font-medium text-zinc-300 mb-1">Region / Location</label>
                <input
                  type="text"
                  placeholder="us-central1"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 focus:outline-none focus:border-emerald-500 font-mono text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block font-medium text-zinc-300 mb-1">
                Service Account JSON 密钥文件
              </label>
              <div className="space-y-2">
                <div className="flex items-center space-x-3">
                  <label className="cursor-pointer bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 py-2 rounded-lg text-xs font-medium border border-zinc-700 flex items-center gap-2 transition">
                    <Upload className="w-4 h-4" />
                    上传 .json 文件
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={handleJsonFileUpload}
                      className="hidden"
                    />
                  </label>
                  <span className="text-xs text-zinc-500">文件大小限制 ≤ 100KB</span>
                </div>

                <textarea
                  rows={5}
                  placeholder='粘贴 {"type": "service_account", "project_id": "xp-vertex-project", "private_key": "..."}'
                  value={serviceAccountJson}
                  onChange={(e) => setServiceAccountJson(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-zinc-300 font-mono text-xs focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'gemini_api_key' && (
          <div className="space-y-4 text-sm">
            <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-800/50 text-xs text-amber-300">
              <span className="font-semibold text-amber-200">Gemini API Key 备用通道（手动付费/预付通道）：</span>
              请求经由 <code className="font-mono text-amber-100">generativelanguage.googleapis.com</code> 发起。注意：此通道无法抵扣 2026年7月26日发放的 GCP Free Credit 赠金，仅作为手动备用方式。
            </div>

            <div>
              <label className="block font-medium text-zinc-300 mb-1">Gemini API Key</label>
              <input
                type="password"
                placeholder="AIzaSy..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 focus:outline-none focus:border-amber-500 font-mono text-sm"
              />
            </div>
          </div>
        )}

        {activeTab === 'server_env_secret' && (
          <div className="space-y-4 text-sm">
            <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-800/50 text-xs text-amber-300">
              <span className="font-semibold text-amber-200">Gemini API 环境变量备用通道：</span>
              当前系统检测到 GEMINI_API_KEY。注意：此通道属于 Gemini Developer API 预付/付费通道，无法扣减 GCP 赠金。
            </div>
          </div>
        )}

        {/* Model Configurations */}
        <div className="pt-4 border-t border-zinc-800 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-zinc-200">引擎模型映射设置</h4>
            <button
              onClick={resetModelsToRecommended}
              className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              恢复推荐配置
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">分析/质检模型</label>
              <input
                type="text"
                value={analysisModel}
                onChange={(e) => setAnalysisModel(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-300 font-mono text-xs"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">首帧图像重建模型</label>
              <input
                type="text"
                value={imageModel}
                onChange={(e) => setImageModel(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-300 font-mono text-xs"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">视频生成模型</label>
              <input
                type="text"
                value={videoModel}
                onChange={(e) => setVideoModel(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-300 font-mono text-xs"
              />
              <div className="flex flex-wrap gap-1.5 mt-2">
                {[
                  'veo-3.1-fast-generate-001',
                  'veo-3.1-generate-001',
                  'gemini-2.5-flash',
                ].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setVideoModel(m)}
                    className={`text-[10px] px-2 py-0.5 rounded font-mono border transition ${
                      videoModel === m
                        ? 'bg-emerald-950/80 border-emerald-500 text-emerald-300 font-semibold'
                        : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800/80 text-xs text-zinc-300 space-y-1.5 font-mono">
            <div className="text-emerald-400 font-semibold flex items-center gap-1.5 text-xs font-sans">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              当前渲染引擎与计费规格说明
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 text-[11px] text-zinc-400 font-sans">
              <div className="bg-zinc-900/80 p-2 rounded border border-zinc-800">
                <span className="text-zinc-500 block text-[10px]">默认引擎</span>
                <span className="font-mono text-emerald-300 font-semibold">veo-3.1-fast-generate-001</span>
              </div>
              <div className="bg-zinc-900/80 p-2 rounded border border-zinc-800">
                <span className="text-zinc-500 block text-[10px]">典型规格</span>
                <span className="text-zinc-200 font-medium">1080p / 9:16 / 4~8秒 / 无音频</span>
              </div>
              <div className="bg-zinc-900/80 p-2 rounded border border-zinc-800">
                <span className="text-zinc-500 block text-[10px]">预计单价费率</span>
                <span className="text-amber-300 font-semibold">$0.08 / 秒 ($0.32~$0.64/条)</span>
              </div>
            </div>
          </div>
        </div>

        {/* Error / Success Feedback */}
        {errorMsg && (
          <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-800/60 text-rose-300 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
            <div>
              <div className="font-semibold">连接测试失败</div>
              <div className="mt-0.5">{errorMsg}</div>
            </div>
          </div>
        )}

        {successMsg && (
          <div className="p-3 rounded-lg bg-emerald-950/40 border border-emerald-800/60 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            <div>{successMsg}</div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="pt-4 border-t border-zinc-800 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center space-x-3">
            {connectionInfo && (
              <button
                onClick={disconnect}
                className="text-xs text-rose-400 hover:text-rose-300 font-medium transition"
              >
                断开当前连接会话
              </button>
            )}
            <button
              onClick={handleClearDatabase}
              className="text-xs text-zinc-500 hover:text-zinc-300 font-medium transition"
            >
              清除已存凭据数据库
            </button>
          </div>

          <div className="flex items-center space-x-3">
            <button
              onClick={handleSaveDraftOnly}
              className="px-4 py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium text-sm transition flex items-center gap-2 border border-zinc-700"
            >
              <Save className="w-4 h-4 text-zinc-400" />
              保存配置草稿
            </button>

            <button
              onClick={handleConnect}
              disabled={loading}
              className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 text-white font-medium text-sm transition flex items-center gap-2 shadow-lg shadow-indigo-500/10"
            >
              {loading ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              保存并测试连接
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
