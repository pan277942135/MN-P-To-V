import React, { useState } from 'react';
import { useConnection } from '../context/ConnectionContext';
import { DiagnosisModal } from './DiagnosisModal';
import { Server, Key, Cpu, ShieldCheck, Activity, LogOut } from 'lucide-react';

export const Navbar: React.FC = () => {
  const { connectionInfo, isConnected, disconnect } = useConnection();
  const [showDiag, setShowDiag] = useState(false);

  const getBillingChannelLabel = () => {
    if (!connectionInfo) return '未连接算力通道';
    if (connectionInfo.type === 'vertex_ai') return 'Google Cloud 赠金通道 (Vertex AI)';
    if (connectionInfo.type === 'gemini_api_key') return 'Gemini API 付费/预付通道 (API Key 备用)';
    return 'Gemini API 付费/预付通道 (环境变量备用)';
  };

  const isGcpCreditChannel = connectionInfo?.type === 'vertex_ai';

  return (
    <header className="h-14 border-b border-[#1F1F23] bg-[#0F0F12] px-3 sm:px-6 flex items-center justify-between sticky top-0 z-40">
      <div className="flex items-center space-x-2 sm:space-x-3 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-[#2D1B4D] border border-[#7C3AED]/40 flex items-center justify-center text-[#C084FC] font-extrabold text-base shadow-[0_0_12px_rgba(124,58,237,0.25)] shrink-0">
          造
        </div>
        <div className="flex items-center space-x-1.5 sm:space-x-2 overflow-hidden">
          <span className="font-extrabold text-base sm:text-lg text-white tracking-wide shrink-0">造境</span>
          <span className="text-[#334155] text-base font-light hidden sm:inline">|</span>
          <span className="text-sm text-[#94A3B8] font-medium hidden sm:inline truncate">角色一致性图生视频工作台</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-purple-950/80 text-purple-300 border border-purple-500/50 font-mono font-bold shadow-[0_0_10px_rgba(168,85,247,0.3)] shrink-0">
            V10.0 正式版
          </span>
        </div>
      </div>

      <div className="flex items-center space-x-1.5 sm:space-x-3 overflow-hidden">
        {/* Billing Channel badge */}
        <div className={`flex items-center space-x-1.5 border px-2.5 sm:px-3 py-1.5 rounded-lg text-xs overflow-hidden max-w-[200px] sm:max-w-none ${
          !connectionInfo
            ? 'bg-[#0A0A0C] border-[#1F1F23]'
            : isGcpCreditChannel
            ? 'bg-emerald-950/40 border-emerald-800/60'
            : 'bg-amber-950/40 border-amber-800/60'
        }`}>
          <span className="text-[#64748B] hidden sm:inline">计费通道:</span>
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              !connectionInfo
                ? 'bg-rose-500'
                : isGcpCreditChannel
                ? 'bg-emerald-400 shadow-[0_0_8px_#34D399]'
                : 'bg-amber-400 shadow-[0_0_8px_#F59E0B]'
            }`}
          />
          <span className={`truncate text-[11px] sm:text-xs font-medium ${
            !connectionInfo
              ? 'text-zinc-400'
              : isGcpCreditChannel
              ? 'text-emerald-300'
              : 'text-amber-300'
          }`}>
            {getBillingChannelLabel()}
          </span>
          {connectionInfo && (
            <span className="text-zinc-400 font-mono text-[10px] hidden md:inline px-1.5 py-0.5 rounded bg-black/40 border border-white/5">
              {isGcpCreditChannel ? (connectionInfo.projectId || 'xp-vertex-project') : 'API Key 备用'}
            </span>
          )}
        </div>

        {/* Video Engine Badge */}
        {connectionInfo && (
          <div className="hidden lg:flex items-center space-x-1.5 bg-[#2D1B4D]/50 border border-[#7C3AED]/30 px-2.5 py-1.5 rounded-lg text-xs text-[#C084FC]">
            <Cpu className="w-3.5 h-3.5 text-[#A855F7]" />
            <span className="text-zinc-400">引擎:</span>
            <span className="font-semibold text-[#E2E8F0]">{connectionInfo.videoModel}</span>
          </div>
        )}

        {/* Diagnosis trigger */}
        <button
          onClick={() => setShowDiag(true)}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#16161A] hover:bg-[#1F1F23] text-[#CBD5E1] border border-[#2D2D33] transition"
        >
          <Activity className="w-3.5 h-3.5 text-[#A855F7]" />
          <span>系统诊断</span>
        </button>

        {/* Disconnect button */}
        {isConnected && (
          <button
            onClick={disconnect}
            className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs text-[#64748B] hover:text-rose-400 hover:bg-rose-950/30 transition border border-transparent hover:border-rose-900/50"
            title="断开当前连接"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {showDiag && <DiagnosisModal onClose={() => setShowDiag(false)} />}
    </header>
  );
};
