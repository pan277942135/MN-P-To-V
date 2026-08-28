import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { EpisodeSpec, ShotSpec } from '../domain/episode/episodeTypes';
import {
  AlertTriangle,
  CheckCircle2,
  Clapperboard,
  Cloud,
  ExternalLink,
  Film,
  Loader2,
  PauseCircle,
  Play,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';

type DirectorGateState = 'READY' | 'BLOCKED' | 'COMPLETED';

interface DirectorShot extends ShotSpec {
  director: {
    state: DirectorGateState;
    durableKeyframeReady: boolean;
    reasonCode?: string;
  };
}

interface DirectorSummary {
  totalShots: number;
  completed: number;
  keyframePass: number;
  durableReady: number;
  videoPass: number;
  failed: number;
  currentShotId: string | null;
  percent: number;
  canRunWithoutLegacyFileRefs: boolean;
}

interface DirectorCapabilities {
  readOnlyPreview: boolean;
  productionRunEnabled: boolean;
}

interface DirectorSnapshot {
  episode: EpisodeSpec;
  shots: DirectorShot[];
  summary: DirectorSummary;
  capabilities: DirectorCapabilities;
}

interface EpisodeListResponse {
  ok: boolean;
  items?: DirectorSnapshot[];
  capabilities?: DirectorCapabilities;
  error?: string;
  message?: string;
}

const FALLBACK_CAPABILITIES: DirectorCapabilities = {
  readOnlyPreview: false,
  productionRunEnabled: false,
};

function statusTone(status: string): string {
  if (['PASS', 'COMPLETED', 'COMPOSING'].includes(status)) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  }
  if (['FAIL', 'FAILED', 'CANCELLED'].includes(status)) {
    return 'border-rose-500/30 bg-rose-500/10 text-rose-300';
  }
  if (['REVIEW', 'KEYFRAME_REVIEW', 'VIDEO_REVIEW'].includes(status)) {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  }
  if (['PRODUCTION', 'VIDEO_PENDING', 'VIDEO_GENERATING', 'VIDEO_QA', 'KEYFRAME_QA'].includes(status)) {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-300';
  }
  return 'border-zinc-700 bg-zinc-900 text-zinc-300';
}

function StatusBadge({ value }: { value: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wide ${statusTone(value)}`}>
      {value}
    </span>
  );
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`服务返回非 JSON 响应（HTTP ${response.status}）`);
  }
}

function pipelineLabel(shot: DirectorShot) {
  if (shot.director.state === 'COMPLETED') return '镜头已完成';
  if (shot.director.state === 'READY') return 'Durable Keyframe 已就绪，可进入 Veo';
  switch (shot.director.reasonCode) {
    case 'KEYFRAME_REVIEW_REQUIRED':
      return '关键帧需要人工审核';
    case 'KEYFRAME_NOT_PASS':
      return '关键帧尚未 PASS';
    case 'KEYFRAME_DURABLE_ASSET_INVALID':
      return 'Durable GCS 元数据不完整';
    case 'OPENAI_FILE_REF_REQUIRED':
      return '尚未持久化 Durable GCS，仍依赖 legacy 文件引用';
    case 'SHOT_FAILED':
      return '镜头已失败，需要处理后再继续';
    default:
      return shot.director.reasonCode || '等待生产条件';
  }
}

export const DirectorConsolePage: React.FC = () => {
  const [episodeId, setEpisodeId] = useState(() => localStorage.getItem('zaojing_director_episode_id') || 'MN-EP001');
  const [episodes, setEpisodes] = useState<DirectorSnapshot[]>([]);
  const [snapshot, setSnapshot] = useState<DirectorSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState<DirectorCapabilities>(FALLBACK_CAPABILITIES);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [lastRun, setLastRun] = useState<any>(null);

  const loadEpisode = useCallback(async (targetId: string, quiet = false) => {
    const cleanId = targetId.trim();
    if (!cleanId) return;
    if (!quiet) setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/episodes/${encodeURIComponent(cleanId)}`, { cache: 'no-store' });
      const data = await readJson<any>(response);
      if (!response.ok || !data?.ok) {
        throw new Error(data?.message || data?.error || `读取 Episode 失败（HTTP ${response.status}）`);
      }
      const next = data as DirectorSnapshot & { ok: true };
      setSnapshot({ episode: next.episode, shots: next.shots, summary: next.summary, capabilities: next.capabilities });
      setCapabilities(next.capabilities || FALLBACK_CAPABILITIES);
      setEpisodeId(cleanId);
      localStorage.setItem('zaojing_director_episode_id', cleanId);
    } catch (err: any) {
      if (!quiet) setSnapshot(null);
      setError(err?.message || String(err));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const loadEpisodeList = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/episodes?limit=20', { cache: 'no-store' });
      const data = await readJson<EpisodeListResponse>(response);
      if (!response.ok || !data.ok) {
        throw new Error(data.message || data.error || `读取 Episode 列表失败（HTTP ${response.status}）`);
      }
      const items = data.items || [];
      setEpisodes(items);
      if (data.capabilities) setCapabilities(data.capabilities);
      const remembered = episodeId.trim();
      const selected = items.find((item) => item.episode.id === remembered) || items[0];
      if (selected) {
        setSnapshot(selected);
        setEpisodeId(selected.episode.id);
        localStorage.setItem('zaojing_director_episode_id', selected.episode.id);
      } else {
        setSnapshot(null);
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [episodeId]);

  useEffect(() => {
    void loadEpisodeList();
  }, []);

  useEffect(() => {
    if (!snapshot || snapshot.episode.status !== 'PRODUCTION') return;
    const timer = window.setInterval(() => void loadEpisode(snapshot.episode.id, true), 5000);
    return () => window.clearInterval(timer);
  }, [snapshot?.episode.id, snapshot?.episode.status, loadEpisode]);

  const progressLabel = useMemo(() => {
    if (!snapshot) return '未加载 Episode';
    if (snapshot.episode.status === 'COMPLETED') return '整集完成';
    if (snapshot.episode.status === 'COMPOSING') return '全部镜头已完成，等待合成';
    if (snapshot.summary.currentShotId) return `当前：${snapshot.summary.currentShotId}`;
    return '等待生产';
  }, [snapshot]);

  const runEpisode = async () => {
    if (!snapshot || !capabilities.productionRunEnabled) return;
    const confirmed = window.confirm(
      `确认运行 ${snapshot.episode.id}？\n\n这会按 S01 → S06 顺序继续生产，并可能调用 Veo 产生费用。`
    );
    if (!confirmed) return;

    setRunning(true);
    setError('');
    try {
      const response = await fetch(`/api/episodes/${encodeURIComponent(snapshot.episode.id)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shots: {} }),
      });
      const data = await readJson<any>(response);
      setLastRun(data);
      if (!response.ok || !data?.ok) {
        throw new Error(data?.message || data?.error || `运行 Episode 失败（HTTP ${response.status}）`);
      }
      await loadEpisode(snapshot.episode.id, true);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8 space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-purple-400">
            <Clapperboard className="h-4 w-4" />
            Director Console · Episode Production
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">整集导演控制台</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
            以 Firestore 为状态真相，按 S01–S06 查看 Keyframe 门禁、Durable GCS 资产、Veo 生产与 Video QA。P0-7 已支持直接消费持久化关键帧，不再要求每次重新提供 conversation_file。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs font-bold text-purple-300">P0-7 DURABLE PIPELINE</span>
          <StatusBadge value={snapshot?.episode.status || 'NOT_LOADED'} />
        </div>
      </div>

      {capabilities.readOnlyPreview && (
        <div className="flex gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-100">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <div>
            <div className="text-sm font-bold">Cloud Run Preview：只读安全模式</div>
            <p className="mt-1 text-xs leading-5 text-amber-200/80">
              当前公网预览只读取真实 Episode / Shot 状态，所有写操作和生产调用已锁定，因此不会触发 Veo / Gemini 费用。正式启用生产前再切换鉴权与执行开关。
            </p>
          </div>
        </div>
      )}

      <section className="rounded-2xl border border-[#27272A] bg-[#111114] p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-slate-500">Episode ID</label>
              <input
                value={episodeId}
                onChange={(event) => setEpisodeId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void loadEpisode(episodeId);
                }}
                className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3.5 py-2.5 font-mono text-sm text-white outline-none transition focus:border-purple-500/70"
                placeholder="MN-EP001"
              />
            </div>
            {episodes.length > 0 && (
              <div className="min-w-0 flex-1">
                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-slate-500">最近 Episode</label>
                <select
                  value={snapshot?.episode.id || ''}
                  onChange={(event) => void loadEpisode(event.target.value)}
                  className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-3.5 py-2.5 text-sm text-white outline-none focus:border-purple-500/70"
                >
                  {episodes.map((item) => (
                    <option key={item.episode.id} value={item.episode.id}>
                      {item.episode.id} · {item.episode.title} · {item.episode.status}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 lg:pt-5">
            <button
              onClick={() => void loadEpisode(episodeId)}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200 transition hover:bg-[#232329] disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              刷新状态
            </button>
            <button
              onClick={() => void runEpisode()}
              disabled={!snapshot || running || !capabilities.productionRunEnabled}
              title={capabilities.productionRunEnabled ? '继续整集生产' : 'Preview 模式已禁用生产调用'}
              className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-black text-white shadow-[0_0_20px_rgba(124,58,237,0.25)] transition hover:bg-purple-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500 disabled:shadow-none"
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {capabilities.productionRunEnabled ? '运行 / 继续整集生产' : 'Preview 已锁定执行'}
            </button>
          </div>
        </div>
      </section>

      {error && (
        <div className="flex gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <div className="text-sm font-bold">导演台读取失败</div>
            <div className="mt-1 text-xs leading-5 text-rose-200/80">{error}</div>
          </div>
        </div>
      )}

      {snapshot ? (
        <>
          <section className="rounded-2xl border border-[#27272A] bg-[#111114] p-5">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-xl font-black text-white">{snapshot.episode.title}</h2>
                  <StatusBadge value={snapshot.episode.status} />
                </div>
                <p className="mt-2 text-sm text-slate-400">{snapshot.episode.synopsis || '暂无剧情摘要'}</p>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500">
                  <span>角色：<b className="text-slate-300">{snapshot.episode.characterId}</b></span>
                  <span>目标时长：<b className="text-slate-300">{snapshot.episode.durationTargetSeconds}s</b></span>
                  <span>画幅：<b className="text-slate-300">{snapshot.episode.aspectRatio}</b></span>
                  <span>{progressLabel}</span>
                </div>
              </div>
              <div className="w-full lg:w-[360px]">
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="font-bold text-slate-300">Episode Progress</span>
                  <span className="font-mono font-black text-purple-300">{snapshot.summary.percent}%</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-zinc-800">
                  <div className="h-full rounded-full bg-gradient-to-r from-purple-600 to-fuchsia-500 transition-all" style={{ width: `${snapshot.summary.percent}%` }} />
                </div>
                <div className="mt-2 text-[11px] text-slate-500">
                  {snapshot.summary.completed}/{snapshot.summary.totalShots} 镜头完成 · 当前 {snapshot.summary.currentShotId || '—'}
                </div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
              {[
                ['Keyframe PASS', snapshot.summary.keyframePass, '6'],
                ['Durable GCS', snapshot.summary.durableReady, '6'],
                ['Video PASS', snapshot.summary.videoPass, '6'],
                ['Failed', snapshot.summary.failed, '0'],
                ['无需 legacy file ref', snapshot.summary.canRunWithoutLegacyFileRefs ? 'YES' : 'NO', ''],
              ].map(([label, value, target]) => (
                <div key={String(label)} className="rounded-xl border border-[#27272A] bg-[#0B0B0E] p-3.5">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</div>
                  <div className="mt-1 text-xl font-black text-white">
                    {value}{target ? <span className="ml-1 text-xs font-medium text-slate-600">/ {target}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black uppercase tracking-wider text-slate-200">S01–S06 Production Board</h3>
                <p className="mt-1 text-xs text-slate-500">Keyframe PASS → Durable GCS → Veo → Video QA → PASS</p>
              </div>
              <Film className="h-5 w-5 text-purple-400" />
            </div>
            <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {snapshot.shots.map((shot) => (
                <article key={shot.shotId} className="overflow-hidden rounded-2xl border border-[#27272A] bg-[#111114]">
                  <div className="border-b border-[#242428] bg-[#151519] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-black tracking-[0.18em] text-purple-400">{shot.shotId}</div>
                        <h4 className="mt-1 text-base font-black text-white">{shot.title || `镜头 ${shot.order}`}</h4>
                      </div>
                      <StatusBadge value={shot.status} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      <span className={`rounded-lg border px-2 py-1 text-[10px] font-bold ${statusTone(shot.keyframe.status)}`}>KF {shot.keyframe.status}</span>
                      <span className={`rounded-lg border px-2 py-1 text-[10px] font-bold ${shot.director.durableKeyframeReady ? statusTone('PASS') : statusTone('PENDING')}`}>
                        <Cloud className="mr-1 inline h-3 w-3" />GCS {shot.director.durableKeyframeReady ? 'READY' : 'NOT READY'}
                      </span>
                      <span className={`rounded-lg border px-2 py-1 text-[10px] font-bold ${statusTone(shot.video.status)}`}>VEO {shot.video.status}</span>
                    </div>
                  </div>

                  <div className="space-y-4 p-4">
                    <div className="grid grid-cols-[78px_1fr] gap-x-3 gap-y-2 text-xs leading-5">
                      <span className="text-slate-600">时长</span><span className="text-slate-300">{shot.durationSeconds}s</span>
                      <span className="text-slate-600">场景</span><span className="text-slate-300">{shot.scene.location}{shot.scene.time ? ` · ${shot.scene.time}` : ''}</span>
                      <span className="text-slate-600">动作</span><span className="text-slate-300">{shot.action}</span>
                      <span className="text-slate-600">镜头</span><span className="text-slate-300">{shot.camera}</span>
                    </div>

                    <div className={`flex gap-2 rounded-xl border p-3 text-xs ${shot.director.state === 'READY' || shot.director.state === 'COMPLETED' ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200' : 'border-amber-500/20 bg-amber-500/5 text-amber-200'}`}>
                      {shot.director.state === 'READY' || shot.director.state === 'COMPLETED' ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                      ) : (
                        <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      )}
                      <span>{pipelineLabel(shot)}</span>
                    </div>

                    {shot.keyframe.outputObjectPath && (
                      <div className="rounded-xl border border-[#242428] bg-[#09090B] p-3">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Durable Keyframe</div>
                        <div className="mt-1 break-all font-mono text-[10px] leading-4 text-slate-400">gs://{shot.keyframe.outputBucket}/{shot.keyframe.outputObjectPath}</div>
                      </div>
                    )}

                    {(shot.video.artifactUrl || shot.video.downloadUrl) && (
                      <div className="flex flex-wrap gap-2">
                        {shot.video.artifactUrl && (
                          <a href={shot.video.artifactUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-purple-500/30 bg-purple-500/10 px-2.5 py-1.5 text-[11px] font-bold text-purple-300 hover:bg-purple-500/20">
                            视频产物 <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        {shot.video.downloadUrl && (
                          <a href={shot.video.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-[#34343A] bg-[#1A1A1F] px-2.5 py-1.5 text-[11px] font-bold text-slate-300 hover:bg-[#232329]">
                            下载 <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          {lastRun && (
            <section className="rounded-2xl border border-[#27272A] bg-[#0B0B0E] p-4">
              <div className="mb-2 text-xs font-black uppercase tracking-wider text-slate-400">Last Episode Run Result</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-black p-3 text-[11px] leading-5 text-slate-400">{JSON.stringify(lastRun, null, 2)}</pre>
            </section>
          )}
        </>
      ) : !loading && (
        <div className="rounded-2xl border border-dashed border-[#34343A] bg-[#101013] px-6 py-14 text-center">
          <Clapperboard className="mx-auto h-10 w-10 text-slate-700" />
          <div className="mt-4 text-base font-bold text-slate-300">还没有加载到 Episode</div>
          <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-slate-500">输入已有 Episode ID，例如 MN-EP001；或者先通过现有 Episode Planner / 数据初始化流程创建 S01–S06。</p>
        </div>
      )}
    </div>
  );
};
