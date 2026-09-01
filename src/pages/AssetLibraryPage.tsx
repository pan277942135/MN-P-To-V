import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Check,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Loader2,
  Music2,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useDirectorCloud } from '../components/DirectorCloudPersistenceProvider';
import {
  assetPreviewUrl,
  listProjectAssets,
  updateDirectorAsset,
} from '../services/assetRegistry/assetRegistryClient';
import {
  assetSummary,
  DIRECTOR_ASSET_REVIEW_STATUSES,
  DIRECTOR_ASSET_STATUSES,
  DIRECTOR_ASSET_TYPES,
  type DirectorAssetListFilters,
  type DirectorAssetRecord,
  type DirectorAssetReviewStatus,
} from '../services/assetRegistry/assetRegistryTypes';

type AssetFilters = Omit<DirectorAssetListFilters, 'projectId'>;

const IMAGE_MEDIA_TYPES = ['CHARACTER_MASTER', 'SCENE_MASTER', 'KEYFRAME', 'REFERENCE'];
const VIDEO_MEDIA_TYPES = ['GENERATED_VIDEO', 'RAW_VIDEO', 'PREVIEW_VIDEO', 'FINAL_RENDER'];
const AUDIO_MEDIA_TYPES = ['VOICE', 'BGM', 'SFX', 'AMBIENT'];

const TYPE_LABELS: Record<string, string> = {
  IMAGE: '图片',
  VIDEO: '视频',
  AUDIO: '音频',
  TEXT: '文本',
  MODEL: '模型',
};

const REVIEW_LABELS: Record<DirectorAssetReviewStatus, string> = {
  PENDING: '待审核',
  APPROVED: '已通过',
  REJECTED: '已驳回',
};

function formatDuration(seconds: number): string {
  if (!seconds) return '—';
  return `${Number(seconds).toFixed(seconds % 1 ? 1 : 0)}s`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function assetTitle(asset: DirectorAssetRecord): string {
  return asset.relations.description || asset.relations.shotPurpose || asset.source.sourceId || asset.assetId;
}

function assetIcon(assetType: DirectorAssetRecord['assetType']) {
  if (assetType === 'IMAGE') return <ImageIcon className="h-4 w-4" />;
  if (assetType === 'VIDEO') return <Film className="h-4 w-4" />;
  if (assetType === 'AUDIO') return <Music2 className="h-4 w-4" />;
  return <Archive className="h-4 w-4" />;
}

function statusTone(status: DirectorAssetRecord['status']): string {
  if (status === 'ACTIVE') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
  if (status === 'ARCHIVED') return 'border-slate-500/25 bg-slate-500/10 text-slate-300';
  return 'border-rose-500/25 bg-rose-500/10 text-rose-300';
}

function reviewTone(status: DirectorAssetReviewStatus): string {
  if (status === 'APPROVED') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
  if (status === 'REJECTED') return 'border-rose-500/25 bg-rose-500/10 text-rose-300';
  return 'border-amber-500/25 bg-amber-500/10 text-amber-300';
}

function mediaOptions(assetType: string): string[] {
  if (assetType === 'IMAGE') return IMAGE_MEDIA_TYPES;
  if (assetType === 'VIDEO') return VIDEO_MEDIA_TYPES;
  if (assetType === 'AUDIO') return AUDIO_MEDIA_TYPES;
  return assetType ? [assetType] : [];
}

function Preview({ asset }: { asset: DirectorAssetRecord }) {
  const src = assetPreviewUrl(asset);
  const label = assetTitle(asset);
  if (asset.assetType === 'IMAGE') {
    return <img src={src} alt={label} loading="lazy" className="h-full w-full object-cover" />;
  }
  if (asset.assetType === 'VIDEO') {
    return <video src={src} controls preload="metadata" className="h-full w-full object-cover" aria-label={label} />;
  }
  if (asset.assetType === 'AUDIO') {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <audio src={src} controls className="w-full" aria-label={label} />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-slate-500">
      {assetIcon(asset.assetType)}
      <span className="text-xs">此类型暂无可视化预览</span>
      {src && <a href={src} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-bold text-sky-300 hover:text-sky-200"><ExternalLink className="h-3 w-3" />打开资产</a>}
    </div>
  );
}

export const AssetLibraryPage: React.FC = () => {
  const { record } = useDirectorCloud();
  const [manualProjectId, setManualProjectId] = useState('');
  const [filters, setFilters] = useState<AssetFilters>({
    episodeId: '',
    shotUid: '',
    assetType: '',
    mediaType: '',
    status: 'ACTIVE',
  });
  const [assets, setAssets] = useState<DirectorAssetRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [updatingAssetId, setUpdatingAssetId] = useState('');
  const [error, setError] = useState('');

  const projectId = (record?.snapshot.projectId || manualProjectId).trim();
  const currentEpisodeId = record?.snapshot.episodeId || '';
  const summary = useMemo(() => assetSummary(assets), [assets]);
  const availableMediaTypes = useMemo(() => mediaOptions(filters.assetType || ''), [filters.assetType]);

  useEffect(() => {
    if (!record?.snapshot.projectId) return;
    setManualProjectId(record.snapshot.projectId);
    setFilters((current) => ({
      ...current,
      episodeId: current.episodeId || record.snapshot.episodeId || '',
    }));
  }, [record?.snapshot.projectId, record?.snapshot.episodeId]);

  useEffect(() => {
    if (filters.mediaType && availableMediaTypes.length > 0 && !availableMediaTypes.includes(filters.mediaType)) {
      setFilters((current) => ({ ...current, mediaType: '' }));
    }
  }, [availableMediaTypes, filters.mediaType]);

  const loadAssets = useCallback(async () => {
    if (!projectId) {
      setError('请先在导演台完成项目同步，或输入 projectId。');
      setAssets([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await listProjectAssets(projectId, filters);
      setAssets(result.assets);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setLoading(false);
    }
  }, [filters, projectId]);

  useEffect(() => {
    if (projectId) void loadAssets();
  }, [projectId, loadAssets]);

  const updateFilter = (key: keyof AssetFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const changeReview = async (asset: DirectorAssetRecord, status: DirectorAssetReviewStatus) => {
    setUpdatingAssetId(asset.assetId);
    setError('');
    try {
      const updated = await updateDirectorAsset(asset.assetId, { review: { status } });
      setAssets((current) => current.map((item) => item.assetId === updated.assetId ? updated : item));
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setUpdatingAssetId('');
    }
  };

  if (!projectId && !record) {
    return (
      <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <PageHeading />
        <section className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.035] p-6">
          <div className="flex gap-3">
            <Archive className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-black text-white">连接一个 Director 项目</h2>
              <p className="mt-1 text-sm leading-6 text-slate-400">资产库只读取 Firestore / GCS 的项目索引，不在浏览器保存资产副本。</p>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <input value={manualProjectId} onChange={(event) => setManualProjectId(event.target.value)} placeholder="projectId" aria-label="projectId" className="min-w-0 flex-1 rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-emerald-500/60" />
                <button type="button" onClick={() => void loadAssets()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-black text-white hover:bg-emerald-500"><Search className="h-4 w-4" />读取项目资产</button>
              </div>
              {error && <div className="mt-3 text-xs text-amber-200">{error}</div>}
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeading />

      <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.035] p-5 sm:p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-400">Project Asset Summary</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-black text-white">{record?.snapshot.projectTitle || '当前项目'}</h2>
              <span className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 font-mono text-[10px] text-slate-400">{projectId}</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <SummaryChip label="Images" value={summary.images} tone="text-sky-300" />
            <SummaryChip label="Videos" value={summary.videos} tone="text-violet-300" />
            <SummaryChip label="Audio" value={summary.audio} tone="text-amber-300" />
            <SummaryChip label="Shots" value={summary.shotsCovered} tone="text-emerald-300" />
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-[#27272A] bg-[#111114] p-4 sm:p-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-black text-white"><Search className="h-4 w-4 text-emerald-300" />筛选资产</div>
            <div className="mt-1 text-xs text-slate-500">{currentEpisodeId ? `当前绑定 Episode：${currentEpisodeId}` : '可按 Episode、Shot、类型和生产状态缩小范围'}</div>
          </div>
          <button type="button" onClick={() => void loadAssets()} disabled={loading} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-200 hover:border-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新资产</button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <FilterInput label="Episode" value={filters.episodeId || ''} placeholder={currentEpisodeId || '全部 Episode'} onChange={(value) => updateFilter('episodeId', value)} />
          <FilterInput label="Shot UID" value={filters.shotUid || ''} placeholder="例如 S03-01-A" onChange={(value) => updateFilter('shotUid', value)} />
          <FilterSelect label="Asset Type" value={filters.assetType || ''} options={['', ...DIRECTOR_ASSET_TYPES]} labels={['全部类型', ...DIRECTOR_ASSET_TYPES.map((value) => TYPE_LABELS[value] || value)]} onChange={(value) => updateFilter('assetType', value)} />
          <FilterSelect label="Media Type" value={filters.mediaType || ''} options={['', ...availableMediaTypes]} labels={['全部媒体类型', ...availableMediaTypes]} onChange={(value) => updateFilter('mediaType', value)} />
          <FilterSelect label="Status" value={filters.status || ''} options={['', ...DIRECTOR_ASSET_STATUSES]} labels={['全部状态', ...DIRECTOR_ASSET_STATUSES]} onChange={(value) => updateFilter('status', value)} />
        </div>
      </section>

      {error && <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-black text-white">资产列表 <span className="ml-1 text-xs font-medium text-slate-500">{loading ? '读取中…' : `${assets.length} 项`}</span></div>
          <div className="text-xs text-slate-500">Registry projection · Firestore + GCS</div>
        </div>
        {loading && assets.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center rounded-2xl border border-[#27272A] bg-[#111114] text-sm text-slate-500"><Loader2 className="mr-2 h-5 w-5 animate-spin" />正在读取项目资产…</div>
        ) : assets.length === 0 ? (
          <div className="rounded-2xl border border-[#27272A] bg-[#111114] py-20 text-center"><Archive className="mx-auto h-10 w-10 text-slate-700" /><div className="mt-3 text-lg font-bold text-slate-300">当前筛选没有资产</div><div className="mt-1 text-sm text-slate-500">生成关键帧或视频后，资产会自动进入 Registry。</div></div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {assets.map((asset) => (
              <AssetCard key={asset.assetId} asset={asset} updating={updatingAssetId === asset.assetId} onReview={(status) => void changeReview(asset, status)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

const PageHeading = () => (
  <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-emerald-400"><Archive className="h-4 w-4" /> Director Console · Step 4.0.2-A</div>
      <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">资产库｜Asset Registry</h1>
      <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">面向导演的项目资产视图：知道每一张图片、每一段视频来自哪个 Episode / Shot，以及当前是否可用和待审核。</p>
    </div>
    <span className="inline-flex items-center gap-1.5 self-start rounded-full border border-sky-500/25 bg-sky-500/10 px-3 py-1.5 text-[11px] font-bold text-sky-300"><ShieldCheck className="h-3.5 w-3.5" /> Firestore + GCS authority</span>
  </header>
);

const SummaryChip = ({ label, value, tone }: { label: string; value: number; tone: string }) => (
  <div className="rounded-lg border border-[#303036] bg-[#09090B] px-3 py-2"><div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div><div className={`mt-0.5 text-lg font-black ${tone}`}>{value}</div></div>
);

const FilterInput = ({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) => (
  <label className="block"><span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</span><input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-700 focus:border-emerald-500/60" /></label>
);

const FilterSelect = ({ label, value, options, labels, onChange }: { label: string; value: string; options: string[]; labels: string[]; onChange: (value: string) => void }) => (
  <label className="block"><span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-500/60">{options.map((option, index) => <option key={option || 'all'} value={option}>{labels[index] || option}</option>)}</select></label>
);

const AssetCard: React.FC<{ asset: DirectorAssetRecord; updating: boolean; onReview: (status: DirectorAssetReviewStatus) => void }> = ({ asset, updating, onReview }) => (
  <article className="overflow-hidden rounded-2xl border border-[#2B2B32] bg-[#111114]" data-testid={`asset-card-${asset.assetId}`}>
    <div className="h-48 border-b border-[#2B2B32] bg-[#09090B]"><Preview asset={asset} /></div>
    <div className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-black text-white" title={assetTitle(asset)}>{assetTitle(asset)}</h2>
          <div className="mt-1 truncate font-mono text-[10px] text-slate-600">{asset.assetId}</div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-bold ${statusTone(asset.status)}`}>{assetIcon(asset.assetType)}{asset.status}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <Meta label="Shot" value={asset.shotUid} mono />
        <Meta label="Episode" value={asset.episodeId} mono />
        <Meta label="Type" value={`${TYPE_LABELS[asset.assetType] || asset.assetType} · ${asset.mediaType}`} />
        <Meta label="规格" value={asset.assetType === 'VIDEO' ? formatDuration(asset.metadata.durationSeconds) : asset.metadata.aspectRatio || formatBytes(asset.metadata.fileSize)} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-[#27272A] pt-3">
        <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${reviewTone(asset.review.status)}`}>审核 · {REVIEW_LABELS[asset.review.status]}</span>
        <span className="text-[10px] text-slate-600">{asset.source.type}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {DIRECTOR_ASSET_REVIEW_STATUSES.map((status) => (
          <button key={status} type="button" disabled={updating || asset.review.status === status} onClick={() => onReview(status)} className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-40 ${status === 'APPROVED' ? 'border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/10' : status === 'REJECTED' ? 'border-rose-500/25 text-rose-300 hover:bg-rose-500/10' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}>
            {updating ? <Loader2 className="h-3 w-3 animate-spin" /> : status === 'APPROVED' ? <Check className="h-3 w-3" /> : status === 'REJECTED' ? <X className="h-3 w-3" /> : null}
            {REVIEW_LABELS[status]}
          </button>
        ))}
      </div>
    </div>
  </article>
);

const Meta = ({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) => (
  <div className="min-w-0"><div className="text-[10px] text-slate-600">{label}</div><div className={`truncate text-slate-300 ${mono ? 'font-mono text-[11px]' : ''}`} title={value}>{value || '—'}</div></div>
);
