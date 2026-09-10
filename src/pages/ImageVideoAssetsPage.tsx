import React, { useEffect, useState } from 'react';

type ImageAsset = {
  id: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  imageUrl: string;
  isDeleted?: boolean;
};

type WorkspaceVideo = {
  id: string;
  taskId: string;
  prompt: string;
  durationSeconds: 4 | 6 | 8;
  status: string;
  videoUrl?: string | null;
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

function AuthenticatedImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [objectUrl, setObjectUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let revokeUrl = '';
    setObjectUrl('');
    setFailed(false);
    void fetch(src, { headers: headers() })
      .then((response) => {
        if (!response.ok) throw new Error('image_fetch_failed');
        return response.blob();
      })
      .then((blob) => {
        revokeUrl = URL.createObjectURL(blob);
        if (active) setObjectUrl(revokeUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    };
  }, [src]);

  if (!objectUrl) {
    return <div className={className + ' flex items-center justify-center bg-zinc-900 text-xs text-zinc-500'}>{failed ? '图片暂时无法读取' : '图片加载中…'}</div>;
  }
  return <img src={objectUrl} alt={alt} className={className} />;
}

function imageIdFromPath() {
  const match = window.location.pathname.match(/^\/assets\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export function ImageVideoAssetsPage() {
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [selectedImageId, setSelectedImageId] = useState(() => imageIdFromPath());
  const [videos, setVideos] = useState<WorkspaceVideo[]>([]);
  const [page, setPage] = useState(1);
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([undefined]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [error, setError] = useState('');

  const loadImages = async (cursor?: string, targetPage = page) => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '24' });
      if (cursor) query.set('cursor', cursor);
      const body = await json(await fetch('/api/images?' + query.toString(), { headers: headers() }));
      setImages((body.images || []).filter((image: ImageAsset) => image.isDeleted !== true));
      setNextCursor(body.page?.nextCursor || null);
      setPage(targetPage);
    } catch (e: any) {
      setError(e?.message || '图片列表读取失败');
    } finally {
      setLoading(false);
    }
  };

  const loadVideos = async (imageId: string) => {
    setLoadingVideos(true);
    setError('');
    try {
      const body = await json(await fetch('/api/images/' + encodeURIComponent(imageId) + '/videos?limit=100', { headers: headers() }));
      setVideos((body.videos || []).map((video: any) => ({
        id: video.id || video.taskId,
        taskId: video.taskId || video.id,
        prompt: video.prompt || '',
        durationSeconds: video.durationSeconds || 4,
        status: video.status || 'unknown',
        videoUrl: video.videoUrl || null,
        selectedBest: video.selectedBest === true,
        createdAt: video.createdAt || Date.now(),
      })));
    } catch (e: any) {
      setError(e?.message || '视频版本读取失败');
    } finally {
      setLoadingVideos(false);
    }
  };

  useEffect(() => {
    void loadImages(undefined, 1);
    const onPopState = () => setSelectedImageId(imageIdFromPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (selectedImageId) void loadVideos(selectedImageId);
    else setVideos([]);
  }, [selectedImageId]);

  const openImage = (imageId: string) => {
    window.history.pushState({}, '', '/assets/' + encodeURIComponent(imageId));
    setSelectedImageId(imageId);
  };

  const backToList = () => {
    window.history.pushState({}, '', '/assets');
    setSelectedImageId('');
  };

  const deleteImage = async (imageId: string) => {
    if (!window.confirm('确认删除这张图片吗？只会从工作台隐藏，不会删除云端原文件。')) return;
    try {
      await json(await fetch('/api/images/' + encodeURIComponent(imageId), { method: 'DELETE', headers: headers() }));
      if (selectedImageId === imageId) backToList();
      await loadImages(cursorHistory[page - 1], page);
    } catch (e: any) {
      setError(e?.message || '图片删除失败');
    }
  };

  const deleteVideo = async (taskId: string) => {
    if (!window.confirm('确认删除这个视频版本吗？只会从工作台隐藏，不会删除云端视频文件。')) return;
    try {
      await json(await fetch('/api/videos/' + encodeURIComponent(taskId), { method: 'DELETE', headers: headers() }));
      if (selectedImageId) await loadVideos(selectedImageId);
    } catch (e: any) {
      setError(e?.message || '视频删除失败');
    }
  };

  const selectedImage = images.find((image) => image.id === selectedImageId);

  return <div className="min-h-full bg-zinc-950 px-5 py-8 text-zinc-100 sm:px-8">
    <div className="mx-auto max-w-7xl">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-indigo-300">Zaojing Workspace V1</p>
          <h1 className="mt-2 text-3xl font-semibold">图片素材库</h1>
          <p className="mt-2 text-sm text-zinc-400">已用于图生视频的图片列表。点击图片查看全部视频版本。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/image-to-video" className="rounded-lg bg-indigo-500 px-3 py-2 text-xs">生成视频</a>
          <a href="/projects" className="rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300">Director Console</a>
        </div>
      </div>

      {error && <p className="mb-4 rounded-lg bg-rose-500/10 p-3 text-sm text-rose-300">{error}</p>}

      {!selectedImageId && <section>
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-zinc-400">第 {page} 页 · 每页 24 张</p>
          {loading && <p className="text-xs text-zinc-500">加载中…</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {images.map((image) => <article key={image.id} className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.035]">
            <button type="button" onClick={() => openImage(image.id)} className="block w-full text-left">
              <AuthenticatedImage src={image.imageUrl} alt={image.id} className="aspect-video w-full object-cover" />
              <div className="p-3">
                <p className="truncate text-sm">{image.id}</p>
                <p className="mt-1 text-xs text-zinc-500">{Math.round(image.sizeBytes / 1024)} KB</p>
              </div>
            </button>
            <div className="border-t border-white/10 p-3">
              <button type="button" onClick={() => void deleteImage(image.id)} className="rounded-lg border border-rose-400/40 px-3 py-2 text-xs text-rose-200">删除图片</button>
            </div>
          </article>)}
        </div>
        {!loading && !images.length && <p className="mt-8 text-sm text-zinc-500">还没有图片素材。</p>}
        <div className="mt-6 flex justify-center gap-3">
          <button type="button" disabled={loading || page <= 1} onClick={() => {
            const targetPage = page - 1;
            void loadImages(cursorHistory[targetPage - 1], targetPage);
          }} className="rounded-lg border border-white/10 px-4 py-2 text-sm disabled:opacity-40">上一页</button>
          <button type="button" disabled={loading || !nextCursor} onClick={() => {
            const targetPage = page + 1;
            setCursorHistory((current) => [...current.slice(0, targetPage - 1), nextCursor || undefined]);
            void loadImages(nextCursor || undefined, targetPage);
          }} className="rounded-lg border border-white/10 px-4 py-2 text-sm disabled:opacity-40">下一页</button>
        </div>
      </section>}

      {selectedImageId && <section>
        <button type="button" onClick={backToList} className="mb-5 rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300">← 返回图片列表</button>
        <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-indigo-300">Image Asset</p>
          <h2 className="mt-2 text-xl font-medium">{selectedImage?.id || selectedImageId}</h2>
          {selectedImage && <AuthenticatedImage src={selectedImage.imageUrl} alt={selectedImage.id} className="mt-4 max-h-72 w-full rounded-xl object-contain" />}
        </div>
        <h2 className="mb-4 text-xl font-medium">Related Videos</h2>
        {loadingVideos && <p className="text-sm text-zinc-500">视频版本加载中…</p>}
        <div className="grid gap-4 lg:grid-cols-2">
          {videos.map((video, index) => <article key={video.taskId} className={video.selectedBest ? 'rounded-xl border border-emerald-400/70 bg-emerald-400/5 p-4' : 'rounded-xl border border-white/10 bg-white/[0.035] p-4'}>
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-xs uppercase tracking-wider text-indigo-300">V{videos.length - index}</p><p className="mt-1 text-sm text-zinc-300">{video.durationSeconds}秒 · {video.status}</p></div>
              <span className="text-xs text-zinc-400">{video.selectedBest ? '最佳版本' : '未选择'}</span>
            </div>
            {video.videoUrl ? <video className="mt-3 aspect-video w-full rounded-lg bg-black object-cover" controls src={video.videoUrl} /> : <div className="mt-3 flex aspect-video items-center justify-center rounded-lg bg-black/30 text-sm text-zinc-500">任务处理中…</div>}
            <p className="mt-3 line-clamp-3 text-sm text-zinc-300">{video.prompt || '未填写 Prompt'}</p>
            <button type="button" onClick={() => void deleteVideo(video.taskId)} className="mt-4 rounded-lg border border-rose-400/40 px-3 py-2 text-xs text-rose-200">删除视频</button>
          </article>)}
        </div>
        {!loadingVideos && !videos.length && <p className="text-sm text-zinc-500">这张图片还没有视频版本。</p>}
      </section>}
    </div>
  </div>;
}
