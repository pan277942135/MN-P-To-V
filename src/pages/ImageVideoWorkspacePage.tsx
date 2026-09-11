import React, { useEffect, useMemo, useRef, useState } from 'react';

type ImageAsset = {
  id: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  imageUrl: string;
  isDeleted?: boolean;
};

const headers = () => {
  const id = window.localStorage.getItem('selectedConnectionId') || '';
  return id ? { 'x-connection-id': id } : {};
};

const json = async (response: Response) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const structured = body?.structuredError || {};
    const error = body?.error;
    const message = structured.messageChinese || structured.userMessage ||
      (typeof error === 'string' ? error : error?.messageChinese || error?.userMessage) ||
      body?.failureReason || '请求失败';
    throw new Error(String(message));
  }
  return body;
};

export function ImageVideoWorkspacePage() {
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [selectedImageId, setSelectedImageId] = useState('');
  const [sourceMode, setSourceMode] = useState<'existing' | 'upload'>('existing');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState<4 | 6 | 8>(4);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const submissionLockRef = useRef(false);

  const selectedImage = useMemo(() => images.find((image) => image.id === selectedImageId), [images, selectedImageId]);

  const loadRecentImages = async () => {
    const body = await json(await fetch('/api/images?limit=24&includeVideoCounts=false', { headers: headers() }));
    setImages((body.images || []).filter((image: ImageAsset) => image.isDeleted !== true));
  };

  useEffect(() => {
    void loadRecentImages().catch((e) => setError(e?.message || '图片列表读取失败'));
  }, []);

  const chooseFile = (next: File | null) => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(next);
    setPreview(next ? URL.createObjectURL(next) : '');
    setMessage('');
    setError('');
    if (next) {
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
    submissionLockRef.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      const requestTaskId = `vtask_client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const form = new FormData();
      form.append('taskId', requestTaskId);
      form.append('image', file);
      const body = await json(await fetch('/api/images', { method: 'POST', headers: headers(), body: form }));
      setImages((current) => [body, ...current].slice(0, 24));
      setSelectedImageId(body.id);
      setFile(null);
      setSourceMode('upload');
      setMessage('图片已保存，并已作为本次生成图片。');
    } catch (e: any) {
      setError(e?.message || '图片保存失败');
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (submissionLockRef.current) return;
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
      setMessage('视频任务已提交：' + (body.taskId || '') + '。可前往视频素材库查看进度。');
    } catch (e: any) {
      setError(e?.message || '视频任务提交失败');
    } finally {
      submissionLockRef.current = false;
      setBusy(false);
    }
  };

  return <div className="min-h-full bg-zinc-950 px-5 py-8 text-zinc-100 sm:px-8">
    <div className="mx-auto max-w-3xl">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-indigo-300">Zaojing Workspace V1</p>
          <h1 className="mt-2 text-3xl font-semibold">图片生成视频</h1>
          <p className="mt-2 text-sm text-zinc-400">选择一张图片，输入 Prompt，生成 4 / 6 / 8 秒视频。</p>
        </div>
        <div className="flex gap-2">
          <a href="/assets" className="rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300">图片与视频素材库</a>
          <a href="/projects" className="rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300">Director Console</a>
        </div>
      </div>

      <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
        <h2 className="text-lg font-medium">第一步：选择视频起始图片</h2>
        <p className="mt-2 text-xs leading-5 text-zinc-500">未保存的本地图片不会参与生成，也不会自动沿用上一张图片。完整图片列表请进入素材库查看。</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => { setSourceMode('existing'); setFile(null); if (preview) URL.revokeObjectURL(preview); setPreview(''); setError(''); }} className={sourceMode === 'existing' ? 'rounded-lg bg-indigo-500 px-3 py-2 text-sm' : 'rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm'}>选择已有照片</button>
          <button type="button" onClick={() => { setSourceMode('upload'); setSelectedImageId(''); setError(''); }} className={sourceMode === 'upload' ? 'rounded-lg bg-indigo-500 px-3 py-2 text-sm' : 'rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm'}>本地上传照片</button>
        </div>

        {sourceMode === 'existing' && <div className="mt-3">
          <select className="w-full rounded-lg border border-white/10 bg-zinc-900 p-2 text-sm" value={selectedImageId} onChange={(e) => chooseExistingImage(e.target.value)}>
            <option value="">请选择已保存照片（显示最近 24 张）</option>
            {images.map((image) => <option key={image.id} value={image.id}>{image.id}</option>)}
          </select>
          <a href="/assets" className="mt-2 inline-block text-xs text-indigo-300">查看全部图片并按页选择 →</a>
        </div>}

        {sourceMode === 'upload' && <>
          <input className="mt-3 block w-full rounded-lg border border-white/10 bg-zinc-900 p-2 text-sm" type="file" accept="image/*" onChange={(e) => chooseFile(e.target.files?.[0] || null)} />
          {preview && <img src={preview} alt="待保存预览" className="mt-3 max-h-48 w-full rounded-lg object-cover" />}
          <button type="button" disabled={!file || busy} onClick={() => void uploadImage()} className="mt-3 w-full rounded-lg bg-indigo-500 px-4 py-2 text-sm disabled:opacity-40">保存并选择这张照片</button>
          {file && <p className="mt-2 text-xs text-amber-300">这张照片尚未保存，暂时不能生成视频。</p>}
        </>}

        {selectedImage && <p className="mt-4 text-xs text-zinc-500">已选择：{selectedImage.id}</p>}

        <label className="mt-6 block text-sm text-zinc-300">Prompt</label>
        <textarea className="mt-2 min-h-28 w-full rounded-lg border border-white/10 bg-zinc-900 p-3 text-sm" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="镜头缓慢推进，人物自然眨眼，头发被微风轻轻吹动。" />

        <label className="mt-5 block text-sm text-zinc-300">时长</label>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {[4, 6, 8].map((seconds) => <button type="button" key={seconds} onClick={() => setDuration(seconds as 4 | 6 | 8)} className={duration === seconds ? 'rounded-lg bg-indigo-500 px-3 py-2 text-sm' : 'rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm'}>{seconds}秒</button>)}
        </div>

        <button type="button" disabled={busy || !selectedImageId} onClick={() => void generate()} className="mt-6 w-full rounded-lg bg-emerald-500 px-4 py-3 text-sm font-semibold text-zinc-950 disabled:opacity-40">{busy ? '处理中…' : '生成视频'}</button>
        {error && <p className="mt-4 rounded-lg bg-rose-500/10 p-3 text-sm text-rose-300">{error}</p>}
        {message && <p className="mt-4 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-300">{message}</p>}
      </section>
    </div>
  </div>;
}
