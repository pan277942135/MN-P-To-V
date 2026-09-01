import React, { useEffect, useMemo, useState } from 'react';
import { Archive, Film, Image as ImageIcon, Loader2, Music2, RefreshCw, ServerCrash } from 'lucide-react';
import { useDirectorCloud } from './DirectorCloudPersistenceProvider';
import { assetPreviewSummary, assetSummary, type DirectorAssetRecord } from '../services/assetRegistry/assetRegistryTypes';
import { listProjectAssets } from '../services/assetRegistry/assetRegistryClient';

interface ProjectAssetSummaryProps {
  projectId?: string;
}

const EMPTY_ASSETS: DirectorAssetRecord[] = [];

export const ProjectAssetSummary: React.FC<ProjectAssetSummaryProps> = ({ projectId: projectIdProp }) => {
  const { record } = useDirectorCloud();
  const projectId = (projectIdProp || record?.snapshot.projectId || '').trim();
  const [assets, setAssets] = useState<DirectorAssetRecord[]>(EMPTY_ASSETS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    if (!projectId) return;
    setLoading(true);
    setError('');
    try {
      const response = await listProjectAssets(projectId);
      setAssets(response.assets);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setAssets(EMPTY_ASSETS);
    if (projectId) void load();
    // The project identity is the only input that should trigger this compact
    // homepage projection. Asset Library owns interactive filter refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const summary = useMemo(() => assetSummary(assets), [assets]);
  const previewSummary = useMemo(() => assetPreviewSummary(assets), [assets]);
  if (!projectId) return null;

  const metric = (label: string, value: number, icon: React.ReactNode, tone: string) => (
    <div className="rounded-xl border border-[#2B2B32] bg-[#0D0D10] p-3">
      <div className={`flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider ${tone}`}>
        {icon}
        {label}
      </div>
      <div className="mt-2 text-2xl font-black text-white">{loading ? <Loader2 className="h-5 w-5 animate-spin text-slate-500" /> : value}</div>
    </div>
  );

  return (
    <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.035] p-5 sm:p-6" data-testid="project-asset-summary">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-2.5 text-emerald-200"><Archive className="h-5 w-5" /></div>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-400">Asset Registry</div>
            <h2 className="mt-1 text-xl font-black text-white">Project Assets</h2>
            <p className="mt-1 text-xs leading-5 text-slate-400">项目级图片、视频、音频索引；生产资产仍以 Firestore / GCS 原始记录为准。</p>
          </div>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center justify-center gap-2 self-start rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-200 hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新汇总
        </button>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {metric('Images', summary.images, <ImageIcon className="h-3.5 w-3.5" />, 'text-sky-300')}
        {metric('Videos', summary.videos, <Film className="h-3.5 w-3.5" />, 'text-violet-300')}
        {metric('Audio', summary.audio, <Music2 className="h-3.5 w-3.5" />, 'text-amber-300')}
        {metric('Shots Covered', summary.shotsCovered, <Archive className="h-3.5 w-3.5" />, 'text-emerald-300')}
      </div>

      <div className="mt-4 rounded-xl border border-sky-500/20 bg-sky-500/[0.035] p-4" data-testid="project-asset-preview-summary">
        <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-sky-300">Asset Preview</div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <PreviewMetric label="Total" value={previewSummary.total} tone="text-white" />
          <PreviewMetric label="Ready" value={previewSummary.ready} tone="text-emerald-300" />
          <PreviewMetric label="Processing" value={previewSummary.processing + previewSummary.pending} tone="text-sky-300" />
          <PreviewMetric label="Failed" value={previewSummary.failed} tone="text-rose-300" />
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-amber-200/80">
          <ServerCrash className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <span>Asset Registry 暂时无法读取，生产流程不受影响：{error}</span>
        </div>
      )}
    </section>
  );
};

const PreviewMetric = ({ label, value, tone }: { label: string; value: number; tone: string }) => (
  <div className="rounded-lg border border-[#2B2B32] bg-[#09090B] px-3 py-2"><div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div><div className={`mt-0.5 text-lg font-black ${tone}`}>{value}</div></div>
);
