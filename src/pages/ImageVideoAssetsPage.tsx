import React, { useEffect, useState } from 'react';

type ImageAsset = {
  id: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  imageUrl: string;
  thumbnailUrl?: string;
  videoCount?: number;
  isDeleted?: boolean;
};

type StructuredVideoError = {
  code?: string;
  messageChinese?: string;
  userMessage?: string;
  technicalMessageRedacted?: string;
  recommendedAction?: string;
  failureStage?: string;
  stage?: string;
};

type WorkspaceVideo = {
  id: string;
  taskId: string;
  prompt: string;
  durationSeconds: 4 | 6 | 8;
  status: string;
  videoUrl?: string | null;
  error?: unknown;
  failureReason?: string | null;
  failureStage?: string | null;
  structuredError?: StructuredVideoError | null;
  selectedBest?: boolean;
  createdAt: number;
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

function describeVideoFailure(video: WorkspaceVideo) {
  const structured = video.structuredError || (video.error && typeof video.error === 'object' ? video.error as StructuredVideoError : {});
  const rawError = typeof video.error === 'string' ? video.error : '';
  const message = structured.messageChinese || structured.userMessage || rawError ||
    video.failureReason || '视频生成失败，但服务端未返回详细原因。';
  const code = structured.code || video.failureReason || '';
  const stage = structured.failureStage || structured.stage || video.failureStage || '';
  let nextAction = structured.recommendedAction || '';
  if (!nextAction && /rai|safety|input_safety/i.test(String(code))) {
    nextAction = '请调整图片或 Prompt，减少敏感、危险或不适合生成的内容后重试。';
  } else if (!nextAction && /quota|rate|429/i.test(String(code) + message)) {
    nextAction = '请求频率或配额受限，请稍后再试，避免连续点击生成。';
  } else if (!nextAction && /artifact|storage|gcs/i.test(String(code) + message)) {
    nextAction = '视频生成结果可能已返回但保存失败，请刷新页面；仍失败时检查 GCS 存储链路。';
  } else if (!nextAction && /identity/i.test(String(code) + message)) {
    nextAction = '请更换首帧图片或调整人物一致性相关输入后重试。';
  } else {
    nextAction = '请检查图片、Prompt 和算力连接；仍失败时根据错误代码查询 Cloud Logging。';
  }
  return {
    failed: video.status === 'failed' || video.status.includes('failed') ||
      video.status === 'submission_outcome_unknown' || Boolean(video.error) || Boolean(video.failureReason),
    message: String(message),
    code: String(code || ''),
    stage: String(stage || ''),
    nextAction,
    technical: structured.technicalMessageRedacted || '',
  };
};

type ImageFetchJob = {
  run: () => Promise<string>;
  resolve: (objectUrl: string) => void;
  reject: (error: unknown) => void;
};

const IMAGE_FETCH_CONCURRENCY = 3;
const MAX_IMAGE_OBJECT_URL_CACHE = 48;
let activeImageFetches = 0;
const imageFetchQueue: ImageFetchJob[] = [];
const imageObjectUrlCache = new Map<string, { objectUrl: string; lastUsedAt: number }>();
const imageObjectUrlInflight = new Map<string, Promise<string>>();

function drainImageFetchQueue() {
  while (activeImageFetches < IMAGE_FETCH_CONCURRENCY && imageFetchQueue.length > 0) {
    const job = imageFetchQueue.shift();
    if (!job) return;
    activeImageFetches += 1;
    void job.run()
      .then(job.resolve, job.reject)
      .finally(() => {
        activeImageFetches -= 1;
        drainImageFetchQueue();
      });
  }
}

function waitForImageRetry(delayMs: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
}

async function fetchImageWithRetry(src: string) {
  let lastError: Error = new Error('image_fetch_failed');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(src, {
      headers: headers(),
      cache: 'force-cache',
    });
    if (response.ok) return response;
    lastError = new Error('image_fetch_failed_' + response.status);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) throw lastError;
    const retryAfter = Number(response.headers.get('retry-after') || 0);
    const exponentialDelay = 750 * (2 ** attempt);
    const jitter = Math.floor(Math.random() * 250);
    await waitForImageRetry(Math.min(15000, Math.max(exponentialDelay, retryAfter * 1000) + jitter));
  }
  throw lastError;
}

function evictImageObjectUrls() {
  while (imageObjectUrlCache.size > MAX_IMAGE_OBJECT_URL_CACHE) {
    const oldest = [...imageObjectUrlCache.entries()]
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (!oldest) return;
    URL.revokeObjectURL(oldest[1].objectUrl);
    imageObjectUrlCache.delete(oldest[0]);
  }
}

function loadImageObjectUrl(src: string) {
  const cacheKey = (window.localStorage.getItem('selectedConnectionId') || 'default') + ':' + src;
  const cached = imageObjectUrlCache.get(cacheKey);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return Promise.resolve(cached.objectUrl);
  }

  const inflight = imageObjectUrlInflight.get(cacheKey);
  if (inflight) return inflight;

  const pending = new Promise<string>((resolve, reject) => {
    imageFetchQueue.push({
      run: async () => {
        const response = await fetchImageWithRetry(src);
        const objectUrl = URL.createObjectURL(await response.blob());
        imageObjectUrlCache.set(cacheKey, { objectUrl, lastUsedAt: Date.now() });
        evictImageObjectUrls();
        return objectUrl;
      },
      resolve,
      reject,
    });
    drainImageFetchQueue();
  });

  imageObjectUrlInflight.set(cacheKey, pending);
  void pending.then(
    () => {
      if (imageObjectUrlInflight.get(cacheKey) === pending) imageObjectUrlInflight.delete(cacheKey);
    },
    () => {
      if (imageObjectUrlInflight.get(cacheKey) === pending) imageObjectUrlInflight.delete(cacheKey);
    },
  );
  return pending;
}

function AuthenticatedImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [objectUrl, setObjectUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setObjectUrl('');
    setFailed(false);
    void loadImageObjectUrl(src)
      .then((nextObjectUrl) => {
        if (active) setObjectUrl(nextObjectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
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
  const [showOriginal, setShowOriginal] = useState(false);

  const loadImages = async (cursor?: string, targetPage = page) => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '12' });
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
        error: video.error || null,
        failureReason: video.failureReason || null,
        failureStage: video.failureStage || null,
        structuredError: video.structuredError || null,
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

  const selectedImage = images.find((image) => image.id === selectedImageId) || (selectedImageId ? {
    id: selectedImageId,
    mimeType: 'image/jpeg',
    sizeBytes: 0,
    createdAt: 0,
    imageUrl: '/api/images/' + encodeURIComponent(selectedImageId),
    thumbnailUrl: '/api/images/' + encodeURIComponent(selectedImageId) + '/thumbnail',
  } : undefined);

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
          <p className="text-sm text-zinc-400">第 {page} 页 · 每页 12 张</p>
          {loading && <p className="text-xs text-zinc-500">加载中…</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {images.map((image) => <article key={image.id} className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.035]">
            <button type="button" onClick={() => openImage(image.id)} className="block w-full text-left">
              <AuthenticatedImage src={image.thumbnailUrl || image.imageUrl} alt={image.id} className="aspect-video w-full object-cover" />
              <div className="p-3">
                <p className="truncate text-sm">{image.id}</p>
                <p className="mt-1 text-xs text-zinc-500">{Math.round(image.sizeBytes / 1024)} KB · 视频 {image.videoCount || 0} 个</p>
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
          {selectedImage && <>
            <AuthenticatedImage
              src={showOriginal ? selectedImage.imageUrl : (selectedImage.thumbnailUrl || selectedImage.imageUrl)}
              alt={selectedImage.id}
              className="mt-4 max-h-72 w-full rounded-xl object-contain"
            />
            <button type="button" onClick={() => setShowOriginal((value) => !value)} className="mt-3 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300">
              {showOriginal ? '查看缩略图' : '查看原图'}
            </button>
          </>}
        </div>
        <h2 className="mb-4 text-xl font-medium">Related Videos</h2>
        {loadingVideos && <p className="text-sm text-zinc-500">视频版本加载中…</p>}
        <div className="grid gap-4 lg:grid-cols-2">
          {videos.map((video, index) => {
            const failure = describeVideoFailure(video);
            return <article key={video.taskId} className={video.selectedBest ? 'rounded-xl border border-emerald-400/70 bg-emerald-400/5 p-4' : failure.failed ? 'rounded-xl border border-rose-400/50 bg-rose-400/5 p-4' : 'rounded-xl border border-white/10 bg-white/[0.035] p-4'}>
              <div className="flex items-start justify-between gap-3">
                <div><p className="text-xs uppercase tracking-wider text-indigo-300">V{videos.length - index}</p><p className="mt-1 text-sm text-zinc-300">{video.durationSeconds}秒 · {video.status}</p></div>
                <span className="text-xs text-zinc-400">{video.selectedBest ? '最佳版本' : '未选择'}</span>
              </div>
              {failure.failed ? <div className="mt-3 rounded-lg border border-rose-400/30 bg-rose-950/30 p-4 text-sm">
                <p className="font-medium text-rose-200">生成失败</p>
                <p className="mt-2 text-rose-100">失败原因：{failure.message}</p>
                {failure.code && <p className="mt-1 text-xs text-rose-300">错误代码：{failure.code}</p>}
                {failure.stage && <p className="mt-1 text-xs text-rose-300">失败阶段：{failure.stage}</p>}
                <p className="mt-3 text-amber-200">下一步：{failure.nextAction}</p>
                {failure.technical && <p className="mt-2 break-words text-xs text-zinc-400">技术信息：{failure.technical}</p>}
              </div> : video.videoUrl ? <video className="mt-3 aspect-video w-full rounded-lg bg-black object-cover" controls src={video.videoUrl} /> : <div className="mt-3 flex aspect-video items-center justify-center rounded-lg bg-black/30 text-sm text-zinc-500">任务处理中…</div>}
              <p className="mt-3 line-clamp-3 text-sm text-zinc-300">{video.prompt || '未填写 Prompt'}</p>
              <button type="button" onClick={() => void deleteVideo(video.taskId)} className="mt-4 rounded-lg border border-rose-400/40 px-3 py-2 text-xs text-rose-200">删除视频</button>
            </article>;
          })}
        </div>
        {!loadingVideos && !videos.length && <p className="text-sm text-zinc-500">这张图片还没有视频版本。</p>}
      </section>}
    </div>
  </div>;
}
