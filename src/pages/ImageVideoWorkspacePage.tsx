import React, { useEffect, useMemo, useState } from 'react';

type ImageAsset = { id: string; mimeType: string; sizeBytes: number; createdAt: number; imageUrl: string; isDeleted?: boolean };
type WorkspaceVideo = {
  id: string;
  taskId: string;
  sourceImageId?: string;
  prompt: string;
  durationSeconds: 4 | 6 | 8;
  status: string;
  videoUrl?: string | null;
  thumbnailUrl?: string | null;
  selectedBest?: boolean;
  isDeleted?: boolean;
  failureReason?: string | null;
  retryMode?: string | null;
  error?: {
    code?: string;
    stage?: string;
    failureReason?: string | null;
    retryMode?: string | null;
    messageChinese?: string;
    technicalMessageRedacted?: string;
    httpStatus?: number | null;
    googleStatus?: string | null;
    googleReason?: string | null;
    recommendedAction?: string;
    errorId?: string | null;
    traceId?: string | null;
    requestId?: string | null;
    revision?: string | null;
    taskId?: string | null;
  } | string | null;
  createdAt: number;
};

const headers = () => {
  const id = window.localStorage.getItem('selectedConnectionId') || '';
  return id ? { 'x-connection-id': id } : {};
};
const json = async (response: Response) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || '请求失败');
  return body;
};


function failureCategory(video: WorkspaceVideo): string {
  const reason = video.failureReason || (typeof video.error === 'object' ? video.error?.failureReason : null) || '';
  if (reason === 'output_rai_filtered' || reason === 'input_safety_blocked') return '提示词或输入图片触发 Google 安全策略（RAI）';
  if (reason === 'provider_admission_busy') return '云端任务准入冲突';
  if (reason === 'artifact_fetch_failed' || reason === 'artifact_persist_failed') return '视频产物读取或保存失败';
  if (reason === 'compute_session_unavailable') return '算力连接或权限失败';
  if (reason === 'submission_outcome_unknown') return 'Veo 提交结果未知';
  const detail = typeof video.error === 'object' ? video.error : null;
  if (detail?.stage === 'submit') return 'Veo 提交阶段失败';
  if (detail?.stage === 'polling') return 'Veo 云端执行或轮询失败';
  return '视频生成失败';
}

function failureGuidance(video: WorkspaceVideo): string {
  const reason = video.failureReason || (typeof video.error === 'object' ? video.error?.failureReason : null) || '';
  if (reason === 'output_rai_filtered' || reason === 'input_safety_blocked') return '请检查提示词和输入图片，删除敏感、危险或容易触发安全策略的描述，改用中性、具体的动作描述后重试。';
  if (reason === 'provider_admission_busy') return '请刷新任务列表后重试；当前版本已支持独立任务并发，若仍出现此提示请查看任务详情。';
  if (reason === 'artifact_fetch_failed' || reason === 'artifact_persist_failed') return '视频可能已在云端生成，但保存或读取失败；请先查看技术详情，确认 GCS/存储错误后再重试。';
  if (reason === 'compute_session_unavailable') return '请重新连接算力服务，确认 Vertex AI 权限后再重试。';
  if (reason === 'submission_outcome_unknown') return '不要立即重复提交，先核实该任务的 Veo Operation 状态，避免重复扣费。';
  const detail = typeof video.error === 'object' ? video.error : null;
  return detail?.recommendedAction || '请展开技术详情，根据错误阶段和错误码处理后再重试。';
}

export function ImageVideoWorkspacePage() {
  const [tab, setTab] = useState<'images' | 'videos'>('images');
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [videos, setVideos] = useState<WorkspaceVideo[]>([]);
  const [selectedImageId, setSelectedImageId] = useState('');
  const [sourceMode, setSourceMode] = useState<'existing' | 'upload'>('existing');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState<4 | 6 | 8>(4);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const selectedImage = useMemo(() => images.find((x) => x.id === selectedImageId), [images, selectedImageId]);

  const loadImages = async () => {
    const body = await json(await fetch('/api/images', { headers: headers() }));
    const nextImages = (body.images || []).filter((image: ImageAsset) => image.isDeleted !== true);
    setImages(nextImages);
    if (selectedImageId && !nextImages.some((image: ImageAsset) => image.id === selectedImageId)) {
      setSelectedImageId('');
    }
  };
  const loadVideos = async () => {
    const url = selectedImageId ? '/api/images/' + encodeURIComponent(selectedImageId) + '/videos' : '/api/videos/list?limit=100';
    const body = await json(await fetch(url, { headers: headers() }));
    setVideos((body.videos || body.tasks || []).map((v: any) => ({
      id: v.id || v.taskId,
      taskId: v.taskId || v.id,
      sourceImageId: v.sourceImageId,
      prompt: v.prompt || v.userPromptChinese || v.normalizedPromptEnglish || '',
      durationSeconds: v.durationSeconds || v.settings?.durationSeconds || 4,
      status: v.status || 'unknown',
      videoUrl: v.videoUrl || v.resultVideoUrl || null,
      thumbnailUrl: v.thumbnailUrl || v.sceneImageUrl || null,
      selectedBest: v.selectedBest === true,
      failureReason: v.failureReason || null,
      retryMode: v.retryMode || null,
      error: v.error || null,
      createdAt: v.createdAt || Date.now(),
    })));
  };

  useEffect(() => { void loadImages().catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    void loadVideos().catch((e) => setError(e.message));
    const timer = window.setInterval(() => { void loadVideos().catch(() => undefined); }, 5000);
    return () => window.clearInterval(timer);
  }, [selectedImageId]);

  const chooseFile = (next: File | null) => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(next);
    setPreview(next ? URL.createObjectURL(next) : '');
    setMessage('');
    setError('');
    if (next) {
      // A pending local file must never fall back to the previously selected image.
      setSourceMode('upload');
      setSelectedImageId('');
    }
  };

  const chooseExistingImage = (imageId: string) => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview('');
    setSourceMode('existing');
    setSelectedImageId(imageId);
    setMessage('已明确选择已有图片。');
    setError('');
  };

  const uploadImage = async () => {
    if (!file) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const form = new FormData(); form.append('image', file);
      const body = await json(await fetch('/api/images', { method: 'POST', headers: headers(), body: form }));
      setImages((current) => [body, ...current]);
      setSelectedImageId(body.id);
      setFile(null);
      setSourceMode('upload');
      setMessage('图片已保存，并已作为本次生成图片。');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const generate = async () => {
    if (file) return setError('本地图片尚未保存，请先点击“保存图片”，或切换到“选择已有图片”。');
    if (!selectedImageId) return setError('请先在第一步明确选择一张已保存图片。');
    if (!images.some((image) => image.id === selectedImageId)) return setError('当前图片不可用，请重新选择已保存图片。');
    if (!prompt.trim()) return setError('请输入 Prompt。');
    setBusy(true); setError(''); setMessage('');
    try {
      const form = new FormData();
      form.append('imageId', selectedImageId);
      form.append('workspaceMode', 'simple_image_to_video');
      form.append('rawUserPrompt', prompt.trim());
      form.append('compiledPrompt', prompt.trim());
      form.append('durationSeconds', String(duration));
      form.append('sceneMode', 'animate_existing_character');
      form.append('imageIsTargetCharacter', 'true');
      const body = await json(await fetch('/api/videos/start', { method: 'POST', headers: headers(), body: form }));
      setTab('videos'); setMessage('视频任务已提交：' + (body.taskId || ''));
      await loadVideos();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const deleteImage = async (imageId: string) => {
    if (!window.confirm('确认删除这张图片吗？只会从工作台隐藏，不会删除云端原文件。')) return;
    setBusy(true); setError('');
    try {
      await json(await fetch('/api/images/' + encodeURIComponent(imageId), {
        method: 'DELETE', headers: headers(),
      }));
      if (selectedImageId === imageId) {
        setSelectedImageId('');
        setSourceMode('existing');
      }
      await loadImages();
      setMessage('图片已删除（仅逻辑删除）。');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const deleteVideo = async (taskId: string) => {
    if (!window.confirm('确认删除这个视频版本吗？只会从工作台隐藏，不会删除云端视频文件。')) return;
    setBusy(true); setError('');
    try {
      await json(await fetch('/api/videos/' + encodeURIComponent(taskId), {
        method: 'DELETE', headers: headers(),
      }));
      await loadVideos();
      setMessage('视频已删除（仅逻辑删除）。');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const selectBest = async (taskId: string) => {
    setBusy(true); setError('');
    try {
      await json(await fetch('/api/videos/' + encodeURIComponent(taskId) + '/select', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() },
      }));
      setMessage('已选择最佳版本。');
      await loadVideos();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return <div className="min-h-full bg-zinc-950 px-5 py-8 text-zinc-100 sm:px-8">
    <div className="mx-auto max-w-7xl">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-indigo-300">Zaojing Workspace V1</p>
          <h1 className="mt-2 text-3xl font-semibold">Zaojing Simple Image-to-Video Workspace</h1>
          <p className="mt-2 text-sm text-zinc-400">上传图片、输入 Prompt、选择 4 / 6 / 8 秒，保留多个视频版本。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setTab('images')} className={tab === 'images' ? 'rounded-lg bg-indigo-500 px-3 py-2 text-xs' : 'rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300'}>图片素材库</button>
          <button type="button" onClick={() => setTab('videos')} className={tab === 'videos' ? 'rounded-lg bg-indigo-500 px-3 py-2 text-xs' : 'rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300'}>视频素材库</button>
          <a href="/projects" className="rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300">Director Console</a>
          <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-200">Identity Safe / Scene Safe 默认关闭。</div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
          <h2 className="text-lg font-medium">第一步：选择视频起始图片</h2>
          <p className="mt-2 text-xs leading-5 text-zinc-500">先明确选择来源。未保存的本地图片不会参与生成，也不会自动沿用上一张图片。</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => { setSourceMode('existing'); setFile(null); if (preview) URL.revokeObjectURL(preview); setPreview(''); setError(''); }} className={sourceMode === 'existing' ? 'rounded-lg bg-indigo-500 px-3 py-2 text-sm' : 'rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm'}>选择已有照片</button>
            <button type="button" onClick={() => { setSourceMode('upload'); setSelectedImageId(''); setError(''); }} className={sourceMode === 'upload' ? 'rounded-lg bg-indigo-500 px-3 py-2 text-sm' : 'rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm'}>本地上传照片</button>
          </div>

          {sourceMode === 'existing' && <select className="mt-3 w-full rounded-lg border border-white/10 bg-zinc-900 p-2 text-sm" value={selectedImageId} onChange={(e) => chooseExistingImage(e.target.value)}>
            <option value="">请选择已保存照片</option>
            {images.map((image) => <option key={image.id} value={image.id}>{image.id}</option>)}
          </select>}

          {sourceMode === 'upload' && <>
            <input className="mt-3 block w-full rounded-lg border border-white/10 bg-zinc-900 p-2 text-sm" type="file" accept="image/*" onChange={(e) => chooseFile(e.target.files?.[0] || null)} />
            {preview && <img src={preview} alt="待保存预览" className="mt-3 max-h-48 w-full rounded-lg object-cover" />}
            <button type="button" disabled={!file || busy} onClick={() => void uploadImage()} className="mt-3 w-full rounded-lg bg-indigo-500 px-4 py-2 text-sm disabled:opacity-40">保存并选择这张照片</button>
            {file && <p className="mt-2 text-xs text-amber-300">这张照片尚未保存，暂时不能生成视频。</p>}
          </>}

          <label className="mt-6 block text-sm text-zinc-300">Prompt</label>
          <textarea className="mt-2 min-h-28 w-full rounded-lg border border-white/10 bg-zinc-900 p-3 text-sm" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="镜头缓慢推进，人物自然眨眼，头发被微风轻轻吹动。" />

          <label className="mt-5 block text-sm text-zinc-300">时长</label>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {[4, 6, 8].map((seconds) => <button type="button" key={seconds} onClick={() => setDuration(seconds as 4 | 6 | 8)} className={duration === seconds ? 'rounded-lg bg-indigo-500 px-3 py-2 text-sm' : 'rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm'}>{seconds}秒</button>)}
          </div>
          <button type="button" disabled={busy || !selectedImageId} onClick={() => void generate()} className="mt-6 w-full rounded-lg bg-emerald-500 px-4 py-3 text-sm font-semibold text-zinc-950 disabled:opacity-40">{busy ? '处理中…' : '生成视频'}</button>
          {selectedImage && <p className="mt-3 text-xs text-zinc-500">当前图片：{selectedImage.id}</p>}
          {error && <p className="mt-4 rounded-lg bg-rose-500/10 p-3 text-sm text-rose-300">{error}</p>}
          {message && <p className="mt-4 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-300">{message}</p>}
        </section>

        <section>
          <div className="mb-4 flex gap-2 border-b border-white/10">
            <button type="button" onClick={() => setTab('images')} className={tab === 'images' ? 'border-b-2 border-indigo-400 px-4 py-3 text-sm text-indigo-200' : 'px-4 py-3 text-sm text-zinc-500'}>Images</button>
            <button type="button" onClick={() => setTab('videos')} className={tab === 'videos' ? 'border-b-2 border-indigo-400 px-4 py-3 text-sm text-indigo-200' : 'px-4 py-3 text-sm text-zinc-500'}>Videos</button>
          </div>
          {tab === 'images' && <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {images.map((image) => <article key={image.id} className={selectedImageId === image.id ? 'overflow-hidden rounded-xl border-2 border-indigo-400' : 'overflow-hidden rounded-xl border border-white/10'}>
              <button type="button" onClick={() => chooseExistingImage(image.id)} className="block w-full text-left">
                <img src={image.imageUrl} alt={image.id} className="aspect-video w-full object-cover" />
                <div className="p-3"><p className="truncate text-sm">{image.id}</p><p className="mt-1 text-xs text-zinc-500">{Math.round(image.sizeBytes / 1024)} KB</p></div>
              </button>
              <div className="border-t border-white/10 p-3"><button type="button" disabled={busy} onClick={() => void deleteImage(image.id)} className="rounded-lg border border-rose-400/40 px-3 py-2 text-xs text-rose-200 disabled:opacity-40">删除图片</button></div>
            </article>)}
            {!images.length && <p className="text-sm text-zinc-500">还没有图片。</p>}
          </div>}
          {tab === 'videos' && <div className="grid gap-4 lg:grid-cols-2">
            {videos.map((video, index) => <article key={video.taskId} className={video.selectedBest ? 'rounded-xl border border-emerald-400/70 bg-emerald-400/5 p-4' : 'rounded-xl border border-white/10 bg-white/[0.035] p-4'}>
              <div className="flex items-start justify-between gap-3"><div><p className="text-xs uppercase tracking-wider text-indigo-300">V{videos.length - index}</p><p className="mt-1 text-sm text-zinc-300">{video.durationSeconds}秒 · {video.status}</p></div><span className="text-xs text-zinc-400">{video.selectedBest ? '最佳版本' : '未选择'}</span></div>
              {video.status === 'failed' ? <div className="mt-3 rounded-lg border border-rose-400/30 bg-rose-500/10 p-4 text-sm">
                <p className="font-medium text-rose-200">失败原因：{failureCategory(video)}</p>
                <p className="mt-2 text-rose-100">{typeof video.error === 'object' ? (video.error.messageChinese || '云端返回了失败结果，但未提供用户说明。') : (video.error || '云端返回了失败结果，但未提供详细错误。')}</p>
                <p className="mt-2 text-amber-200">下一步：{failureGuidance(video)}</p>
                {typeof video.error === 'object' && (video.error.technicalMessageRedacted || video.error.googleStatus || video.error.googleReason) && <details className="mt-3 rounded border border-white/10 p-2 text-xs text-zinc-300">
                  <summary className="cursor-pointer text-zinc-400">查看技术详情</summary>
                  {video.error.technicalMessageRedacted && <p className="mt-2 break-words">错误：{video.error.technicalMessageRedacted}</p>}
                  {video.error.code && <p className="mt-1">错误码：{video.error.code}</p>}
                  {video.error.stage && <p className="mt-1">失败阶段：{video.error.stage}</p>}
                  {video.error.httpStatus != null && <p className="mt-1">HTTP：{video.error.httpStatus}</p>}
                  {video.error.googleStatus && <p className="mt-1">Google 状态：{video.error.googleStatus}</p>}
                  {video.error.googleReason && <p className="mt-1">Google 原因：{video.error.googleReason}</p>}
                  {video.error.errorId && <p className="mt-1">错误 ID：{video.error.errorId}</p>}
                  {video.error.traceId && <p className="mt-1">Trace ID：{video.error.traceId}</p>}
                  {video.error.requestId && <p className="mt-1">请求 ID：{video.error.requestId}</p>}
                  {video.error.revision && <p className="mt-1">Revision：{video.error.revision}</p>}
                </details>}
              </div> : video.videoUrl ? <video className="mt-3 aspect-video w-full rounded-lg bg-black object-cover" controls src={video.videoUrl} poster={video.thumbnailUrl || undefined} /> : <div className="mt-3 flex aspect-video items-center justify-center rounded-lg bg-black/30 text-sm text-zinc-500">任务处理中…</div>}
              <p className="mt-3 line-clamp-3 text-sm text-zinc-300">{video.prompt || '未填写 Prompt'}</p>
              <div className="mt-4 flex items-center justify-between gap-3"><span className="truncate text-xs text-zinc-500">source image: {video.sourceImageId || selectedImageId || '—'}</span><div className="flex shrink-0 gap-2"><button type="button" disabled={busy || video.status !== 'completed'} onClick={() => void selectBest(video.taskId)} className="rounded-lg border border-indigo-400/40 px-3 py-2 text-xs text-indigo-200 disabled:opacity-40">人工选择此版本</button><button type="button" disabled={busy} onClick={() => void deleteVideo(video.taskId)} className="rounded-lg border border-rose-400/40 px-3 py-2 text-xs text-rose-200 disabled:opacity-40">删除</button></div></div>
            </article>)}
            {!videos.length && <p className="text-sm text-zinc-500">还没有视频版本。</p>}
          </div>}
        </section>
      </div>
    </div>
  </div>;
}
