import React, { useEffect, useMemo, useState } from 'react';

type ImageAsset = { id: string; mimeType: string; sizeBytes: number; createdAt: number; imageUrl: string };
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

export function ImageVideoWorkspacePage() {
  const [tab, setTab] = useState<'images' | 'videos'>('images');
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [videos, setVideos] = useState<WorkspaceVideo[]>([]);
  const [selectedImageId, setSelectedImageId] = useState('');
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
    setImages(body.images || []);
    if (!selectedImageId && body.images?.[0]?.id) setSelectedImageId(body.images[0].id);
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
      setMessage('图片已保存。');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const generate = async () => {
    if (!selectedImageId) return setError('请先上传并选择图片。');
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
          <h2 className="text-lg font-medium">生成视频</h2>
          <label className="mt-5 block text-sm text-zinc-300">上传图片</label>
          <input className="mt-2 block w-full rounded-lg border border-white/10 bg-zinc-900 p-2 text-sm" type="file" accept="image/*" onChange={(e) => chooseFile(e.target.files?.[0] || null)} />
          {preview && <img src={preview} alt="预览" className="mt-3 max-h-48 w-full rounded-lg object-cover" />}
          <button type="button" disabled={!file || busy} onClick={() => void uploadImage()} className="mt-3 w-full rounded-lg bg-indigo-500 px-4 py-2 text-sm disabled:opacity-40">保存图片</button>

          <label className="mt-6 block text-sm text-zinc-300">选择图片</label>
          <select className="mt-2 w-full rounded-lg border border-white/10 bg-zinc-900 p-2 text-sm" value={selectedImageId} onChange={(e) => setSelectedImageId(e.target.value)}>
            <option value="">请选择图片</option>
            {images.map((image) => <option key={image.id} value={image.id}>{image.id}</option>)}
          </select>

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
            {images.map((image) => <button type="button" key={image.id} onClick={() => setSelectedImageId(image.id)} className={selectedImageId === image.id ? 'overflow-hidden rounded-xl border-2 border-indigo-400 text-left' : 'overflow-hidden rounded-xl border border-white/10 text-left'}>
              <img src={image.imageUrl} alt={image.id} className="aspect-video w-full object-cover" />
              <div className="p-3"><p className="truncate text-sm">{image.id}</p><p className="mt-1 text-xs text-zinc-500">{Math.round(image.sizeBytes / 1024)} KB</p></div>
            </button>)}
            {!images.length && <p className="text-sm text-zinc-500">还没有图片。</p>}
          </div>}
          {tab === 'videos' && <div className="grid gap-4 lg:grid-cols-2">
            {videos.map((video, index) => <article key={video.taskId} className={video.selectedBest ? 'rounded-xl border border-emerald-400/70 bg-emerald-400/5 p-4' : 'rounded-xl border border-white/10 bg-white/[0.035] p-4'}>
              <div className="flex items-start justify-between gap-3"><div><p className="text-xs uppercase tracking-wider text-indigo-300">V{videos.length - index}</p><p className="mt-1 text-sm text-zinc-300">{video.durationSeconds}秒 · {video.status}</p></div><span className="text-xs text-zinc-400">{video.selectedBest ? '最佳版本' : '未选择'}</span></div>
              {video.videoUrl ? <video className="mt-3 aspect-video w-full rounded-lg bg-black object-cover" controls src={video.videoUrl} poster={video.thumbnailUrl || undefined} /> : <div className="mt-3 flex aspect-video items-center justify-center rounded-lg bg-black/30 text-sm text-zinc-500">任务处理中…</div>}
              <p className="mt-3 line-clamp-3 text-sm text-zinc-300">{video.prompt || '未填写 Prompt'}</p>
              <div className="mt-4 flex items-center justify-between gap-3"><span className="truncate text-xs text-zinc-500">source image: {video.sourceImageId || selectedImageId || '—'}</span><button type="button" disabled={busy || video.status !== 'completed'} onClick={() => void selectBest(video.taskId)} className="rounded-lg border border-indigo-400/40 px-3 py-2 text-xs text-indigo-200 disabled:opacity-40">人工选择此版本</button></div>
            </article>)}
            {!videos.length && <p className="text-sm text-zinc-500">还没有视频版本。</p>}
          </div>}
        </section>
      </div>
    </div>
  </div>;
}
