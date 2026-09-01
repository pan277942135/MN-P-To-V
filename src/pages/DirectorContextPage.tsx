import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clapperboard,
  FileJson,
  Film,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Volume2,
} from 'lucide-react';
import { useDirectorCloud } from '../components/DirectorCloudPersistenceProvider';
import {
  getProjectDirectorContext,
} from '../services/directorContext/directorContextClient';
import type {
  DirectorContext,
  DirectorContextAsset,
  DirectorContextShot,
} from '../services/directorContext/directorContextTypes';

const FORMAT_LABELS: Record<string, string> = {
  story_short: '剧情短视频',
  vlog: 'Vlog',
  cosplay: 'AI Cosplay',
  other: '其他',
};

function formatType(asset: DirectorContextAsset): string {
  return asset.mediaType ? `${asset.type} · ${asset.mediaType}` : asset.type;
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function shotMissing(shot: DirectorContextShot): string[] {
  const missing: string[] = [];
  if (!shot.assets.some((asset) => asset.type === 'IMAGE')) missing.push('缺图片资产');
  if (!shot.assets.some((asset) => asset.type === 'VIDEO')) missing.push('缺视频资产');
  return missing;
}

export const DirectorContextPage: React.FC = () => {
  const { record } = useDirectorCloud();
  const [manualProjectId, setManualProjectId] = useState('');
  const [context, setContext] = useState<DirectorContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const projectId = manualProjectId.trim() || record?.snapshot.projectId?.trim() || '';

  const load = useCallback(async (targetProjectId = projectId) => {
    if (!targetProjectId) return;
    setLoading(true);
    setError('');
    try {
      const next = await getProjectDirectorContext(targetProjectId);
      setContext(next);
    } catch (cause: any) {
      setContext(null);
      setError(cause?.message || String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setContext(null);
    if (projectId) void load(projectId);
  }, [projectId, load]);

  const shotsCovered = useMemo(
    () => context?.shots.filter((shot) => shot.assets.length > 0).length || 0,
    [context],
  );
  const videoCovered = useMemo(
    () => context?.shots.filter((shot) => shot.assets.some((asset) => asset.type === 'VIDEO')).length || 0,
    [context],
  );
  const missingShots = useMemo(
    () => (context?.shots || []).map((shot) => ({ shot, missing: shotMissing(shot) })).filter((item) => item.missing.length > 0),
    [context],
  );

  if (!projectId && !context) {
    return (
      <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <PageHeading />
        <section className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.035] p-6">
          <div className="flex gap-3">
            <Search className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-black text-white">连接一个 Director 项目</h2>
              <p className="mt-1 text-sm leading-6 text-slate-400">AI Director Context 只读取 Firestore / GCS，不在浏览器创建或保存项目数据。</p>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <input value={manualProjectId} onChange={(event) => setManualProjectId(event.target.value)} placeholder="projectId" aria-label="projectId" className="min-w-0 flex-1 rounded-xl border border-[#303036] bg-[#09090B] px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-purple-500/60" />
                <button type="button" onClick={() => void load()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-black text-white hover:bg-purple-500"><Search className="h-4 w-4" />读取 Context</button>
              </div>
              {error && <div className="mt-3 text-xs text-amber-200">{error}</div>}
            </div>
          </div>
        </section>
      </div>
    );
  }

  if (loading && !context) {
    return (
      <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <PageHeading />
        <div className="flex min-h-64 items-center justify-center rounded-2xl border border-[#27272A] bg-[#111114] text-sm text-slate-500"><Loader2 className="mr-2 h-5 w-5 animate-spin" />正在读取 AI Director Context…</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeading />

      {error && <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}

      {context && (
        <>
          <section className="rounded-2xl border border-purple-500/25 bg-purple-500/[0.045] p-5 sm:p-6" data-testid="director-context-summary">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-purple-300"><Clapperboard className="h-4 w-4" /> AI Director Context</div>
                <h2 className="mt-2 truncate text-2xl font-black text-white">{context.project.title}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 font-mono">{context.project.projectId}</span>
                  <span>·</span>
                  <span>{context.episode.episodeId}</span>
                  <span>·</span>
                  <span>{context.episode.title}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-bold text-emerald-300"><ShieldCheck className="h-3.5 w-3.5" /> Firestore + GCS</span>
                <button type="button" onClick={() => void load(context.project.projectId)} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-purple-500/25 bg-purple-500/10 px-3 py-2 text-xs font-bold text-purple-200 hover:bg-purple-500/15 disabled:cursor-not-allowed disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新 Context</button>
              </div>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <Info label="创意 Brief" value={context.project.creativeBrief || '未填写'} wide />
              <Info label="目标形式" value={FORMAT_LABELS[context.project.targetFormat] || context.project.targetFormat || '未指定'} />
              <Info label="画幅比例" value={context.project.aspectRatio || '未指定'} />
              <Info label="Episode 状态" value={context.episode.status || '未指定'} />
            </div>
            {context.episode.summary && <p className="mt-4 max-w-5xl text-sm leading-6 text-slate-300"><span className="font-bold text-slate-500">Episode Summary：</span>{context.episode.summary}</p>}
          </section>

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="director-context-coverage">
            <Metric label="Shots" value={context.shots.length} tone="text-white" icon={<Clapperboard className="h-3.5 w-3.5" />} />
            <Metric label="Assets" value={context.assetSummary.total} tone="text-purple-300" icon={<FileJson className="h-3.5 w-3.5" />} />
            <Metric label="Images" value={context.assetSummary.images} tone="text-sky-300" icon={<ImageIcon className="h-3.5 w-3.5" />} />
            <Metric label="Videos" value={context.assetSummary.videos} tone="text-violet-300" icon={<Film className="h-3.5 w-3.5" />} />
            <Metric label="Audio" value={context.assetSummary.audio} tone="text-amber-300" icon={<Volume2 className="h-3.5 w-3.5" />} />
          </section>

          <section className="rounded-2xl border border-[#27272A] bg-[#111114] p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-400">SHOT COVERAGE</div>
                <h2 className="mt-1 text-xl font-black text-white">镜头上下文与资产覆盖</h2>
                <p className="mt-1 text-xs text-slate-500">Coverage = 至少存在一个 Registry 资产的 Shot；视频覆盖单独统计，方便 AI 判断可用素材。</p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs font-bold">
                <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-emerald-300">Assets Coverage {percent(context.shots.length ? shotsCovered / context.shots.length : 0)}</span>
                <span className="rounded-full border border-violet-500/25 bg-violet-500/10 px-3 py-1.5 text-violet-300">Video Coverage {percent(context.shots.length ? videoCovered / context.shots.length : 0)}</span>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {context.shots.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#34343A] px-5 py-12 text-center text-sm text-slate-500">当前项目还没有可读取的 Shot。</div>
              ) : context.shots.map((shot) => <ShotRow key={shot.shotUid} shot={shot} />)}
            </div>
          </section>

          <section className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.035] p-5 sm:p-6">
            <div className="flex items-center gap-2 text-sm font-black text-amber-200"><AlertTriangle className="h-4 w-4" /> Missing / AI Context 警示</div>
            {missingShots.length === 0 ? (
              <div className="mt-3 flex items-center gap-2 text-sm text-emerald-300"><CheckCircle2 className="h-4 w-4" />所有 Shot 都至少有图片和视频资产。</div>
            ) : (
              <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {missingShots.map(({ shot, missing }) => (
                  <div key={shot.shotUid} className="rounded-xl border border-amber-500/20 bg-[#111114] px-3.5 py-3">
                    <div className="font-mono text-xs font-bold text-amber-200">{shot.shotUid}</div>
                    <div className="mt-1 truncate text-sm font-bold text-white" title={shot.title}>{shot.title}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">{missing.map((item) => <span key={item} className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-300">{item}</span>)}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600"><FileJson className="h-3.5 w-3.5" /> schema: <code className="font-mono text-slate-400">{context.schema}</code> · 只读组合层，不替换 Production Asset / Blueprint。</div>
        </>
      )}
    </div>
  );
};

const PageHeading = () => (
  <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-purple-400"><Clapperboard className="h-4 w-4" /> Director Console · Step 4.0.3-A</div>
      <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">AI Director Context</h1>
      <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">把项目、Episode、Shot、Blueprint、Asset 和状态组合成 AI 可以读取的标准化上下文。</p>
    </div>
    <span className="inline-flex items-center gap-1.5 self-start rounded-full border border-purple-500/25 bg-purple-500/10 px-3 py-1.5 text-[11px] font-bold text-purple-300"><FileJson className="h-3.5 w-3.5" /> zaojing.director.context.v1</span>
  </header>
);

const Info = ({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) => (
  <div className={`rounded-xl border border-[#2B2B32] bg-[#0D0D10] p-3 ${wide ? 'md:col-span-2' : ''}`}>
    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
    <div className="mt-1 line-clamp-3 text-sm leading-5 text-slate-200">{value}</div>
  </div>
);

const Metric = ({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: React.ReactNode }) => (
  <div className="rounded-xl border border-[#2B2B32] bg-[#0D0D10] p-3">
    <div className={`flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider ${tone}`}>{icon}{label}</div>
    <div className="mt-2 text-2xl font-black text-white">{value}</div>
  </div>
);

const ShotRow: React.FC<{ shot: DirectorContextShot }> = ({ shot }) => {
  const missing = shotMissing(shot);
  return (
    <article className="rounded-xl border border-[#2B2B32] bg-[#0D0D10] p-4" data-testid={`director-context-shot-${shot.shotUid}`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="inline-flex h-8 min-w-12 shrink-0 items-center justify-center rounded-lg border border-purple-500/25 bg-purple-500/10 px-2 font-mono text-xs font-black text-purple-300">{shot.shotUid}</span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-black text-white" title={shot.title}>{shot.title}</h3>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500"><span>order {shot.order}</span><span>status · {shot.status}</span><span>{shot.assets.length} assets</span></div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {missing.length === 0 ? <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-300"><CheckCircle2 className="h-3 w-3" />完整</span> : missing.map((item) => <span key={item} className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-300">{item}</span>)}
        </div>
      </div>
      <div className="mt-3 grid gap-3 text-xs md:grid-cols-2 xl:grid-cols-4">
        <ContextField label="Story Purpose" value={shot.storyPurpose || '未标注'} />
        <ContextField label="Visual Description" value={shot.visualDescription || '未标注'} />
        <ContextField label="Camera" value={shot.camera || '未标注'} />
        <ContextField label="Dialogue" value={shot.dialogue || '无'} />
      </div>
      {shot.assets.length > 0 && <div className="mt-3 flex flex-wrap gap-2 border-t border-[#222228] pt-3">{shot.assets.map((asset) => <AssetChip key={asset.assetId} asset={asset} />)}</div>}
    </article>
  );
};

const ContextField = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0"><div className="text-[10px] font-bold uppercase tracking-wider text-slate-600">{label}</div><div className="mt-1 line-clamp-3 leading-5 text-slate-300" title={value}>{value}</div></div>
);

const AssetChip: React.FC<{ asset: DirectorContextAsset }> = ({ asset }) => (
  <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[#303036] bg-[#111114] px-2.5 py-1.5 text-[10px] text-slate-300" title={asset.description || asset.assetId}>
    {asset.type === 'IMAGE' ? <ImageIcon className="h-3 w-3 text-sky-300" /> : asset.type === 'VIDEO' ? <Film className="h-3 w-3 text-violet-300" /> : <Volume2 className="h-3 w-3 text-amber-300" />}
    <span className="truncate font-mono">{asset.assetId}</span>
    <span className="text-slate-600">{formatType(asset)}</span>
    <span className={asset.reviewStatus === 'APPROVED' ? 'text-emerald-300' : asset.reviewStatus === 'REJECTED' ? 'text-rose-300' : 'text-amber-300'}>{asset.reviewStatus}</span>
  </span>
);
