import React, { useRef, useState } from 'react';

type UploadStatus = 'ready' | 'uploaded' | 'skipped' | 'failed';

type PendingImage = {
  file: File;
  hash: string;
  previewUrl: string;
  status: UploadStatus;
  reason?: string;
  imageId?: string;
};

type UploadResult = {
  index: number;
  status: 'uploaded' | 'skipped' | 'failed';
  fileName: string;
  imageId?: string;
  reason?: string;
  error?: string;
};

const MAX_BATCH_FILES = 10;

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

async function fingerprint(file: File) {
  try {
    const digest = await window.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return [file.name, file.size, file.lastModified].join(':');
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function statusText(image: PendingImage) {
  if (image.status === 'uploaded') return '已上传';
  if (image.status === 'skipped') return image.reason || '已过滤';
  if (image.status === 'failed') return image.reason || '上传失败';
  return '待上传';
}

export function ImageVideoWorkspacePage() {
  const [files, setFiles] = useState<PendingImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const chooseFiles = async (selected: File[]) => {
    if (busy || selected.length === 0) return;
    setBusy(true);
    setError('');
    setMessage('');

    try {
      const currentHashes = new Set(files.map((item) => item.hash));
      const next: PendingImage[] = [];
      const seen = new Set(currentHashes);
      const limited = selected.slice(0, MAX_BATCH_FILES);

      for (const file of limited) {
        const hash = await fingerprint(file);
        const previewUrl = URL.createObjectURL(file);
        if (!file.type.startsWith('image/')) {
          next.push({ file, hash, previewUrl, status: 'failed', reason: '不是图片文件' });
          continue;
        }
        if (seen.has(hash)) {
          next.push({ file, hash, previewUrl, status: 'skipped', reason: '重复图片，已自动过滤' });
          continue;
        }
        seen.add(hash);
        next.push({ file, hash, previewUrl, status: 'ready' });
      }

      setFiles((current) => [...current, ...next]);
      if (selected.length > MAX_BATCH_FILES) {
        setMessage('单批最多选择 ' + MAX_BATCH_FILES + ' 张，超出部分未加入。');
      }
    } catch (e: any) {
      setError(e?.message || '读取图片失败');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const removeFile = (hash: string, previewUrl: string) => {
    URL.revokeObjectURL(previewUrl);
    setFiles((current) => current.filter((item) => item.hash !== hash || item.previewUrl !== previewUrl));
  };

  const clearFiles = () => {
    files.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setFiles([]);
    setMessage('');
    setError('');
  };

  const uploadBatch = async () => {
    const uploadable = files.filter((item) => item.status === 'ready');
    if (uploadable.length === 0) {
      setError('没有待上传的新图片。重复图片和已处理图片已自动过滤。');
      return;
    }

    setBusy(true);
    setError('');
    setMessage('正在上传并检查重复图片…');

    try {
      const form = new FormData();
      uploadable.forEach((item) => form.append('images', item.file));
      const body = await json(await fetch('/api/images/batch', {
        method: 'POST',
        headers: headers(),
        body: form,
      }));

      const results = (body.results || []) as UploadResult[];
      setFiles((current) => current.map((item) => {
        const uploadIndex = uploadable.findIndex((candidate) => candidate.hash === item.hash);
        const result = results[uploadIndex];
        if (!result) return item;
        return {
          ...item,
          status: result.status,
          reason: result.status === 'uploaded'
            ? '上传成功'
            : result.reason || result.error || '已过滤',
          imageId: result.imageId,
        };
      }));

      const summary = body.summary || {};
      setMessage(
        '处理完成：上传 ' + (summary.uploadedCount || 0) +
        ' 张，过滤 ' + (summary.skippedCount || 0) +
        ' 张，失败 ' + (summary.failedCount || 0) + ' 张。',
      );
    } catch (e: any) {
      setError(e?.message || '批量上传失败');
      setMessage('');
    } finally {
      setBusy(false);
    }
  };

  const readyCount = files.filter((item) => item.status === 'ready').length;
  const uploadedCount = files.filter((item) => item.status === 'uploaded').length;
  const skippedCount = files.filter((item) => item.status === 'skipped').length;

  return <div className='min-h-full bg-zinc-950 px-5 py-8 text-zinc-100 sm:px-8'>
    <div className='mx-auto max-w-5xl'>
      <div className='mb-8 flex flex-wrap items-end justify-between gap-4'>
        <div>
          <p className='text-xs uppercase tracking-[0.24em] text-indigo-300'>Zaojing Workspace V1</p>
          <h1 className='mt-2 text-3xl font-semibold'>图片批量上传</h1>
          <p className='mt-2 text-sm text-zinc-400'>本页面只负责保存图片，不生成视频。系统按图片内容自动过滤重复上传。</p>
        </div>
        <div className='flex gap-2'>
          <a href='/assets' className='rounded-lg bg-indigo-500 px-3 py-2 text-xs text-white'>图片素材库</a>
          <a href='/projects' className='rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300'>Director Console</a>
        </div>
      </div>

      <section className='rounded-2xl border border-white/10 bg-white/[0.035] p-5'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div>
            <h2 className='text-lg font-medium'>选择图片</h2>
            <p className='mt-1 text-xs leading-5 text-zinc-500'>可一次选择最多 {MAX_BATCH_FILES} 张。相同文件内容只保留一份；已存在于素材库的图片不会再次上传。</p>
          </div>
          <span className='text-xs text-zinc-500'>待上传 {readyCount} · 已上传 {uploadedCount} · 已过滤 {skippedCount}</span>
        </div>

        <input
          ref={inputRef}
          className='mt-5 block w-full rounded-lg border border-white/10 bg-zinc-900 p-3 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-indigo-500 file:px-3 file:py-2 file:text-white'
          type='file'
          accept='image/*'
          multiple
          onChange={(event) => void chooseFiles(Array.from(event.target.files || []))}
        />

        {files.length > 0 && <div className='mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5'>
          {files.map((item) => <article key={item.hash + item.previewUrl} className='overflow-hidden rounded-xl border border-white/10 bg-zinc-900'>
            <img src={item.previewUrl} alt={item.file.name} className='h-32 w-full object-cover' />
            <div className='p-3'>
              <p className='truncate text-xs text-zinc-200' title={item.file.name}>{item.file.name}</p>
              <p className='mt-1 text-[11px] text-zinc-500'>{formatBytes(item.file.size)}</p>
              <p className={item.status === 'failed' ? 'mt-2 text-xs text-rose-300' : item.status === 'skipped' ? 'mt-2 text-xs text-amber-300' : item.status === 'uploaded' ? 'mt-2 text-xs text-emerald-300' : 'mt-2 text-xs text-indigo-300'}>
                {statusText(item)}
              </p>
              <button type='button' onClick={() => removeFile(item.hash, item.previewUrl)} className='mt-3 text-xs text-zinc-500 hover:text-zinc-200'>移除</button>
            </div>
          </article>)}
        </div>}

        {files.length === 0 && <div className='mt-5 rounded-xl border border-dashed border-white/10 px-5 py-12 text-center text-sm text-zinc-500'>还没有选择图片</div>}

        <div className='mt-6 flex flex-wrap gap-3'>
          <button type='button' disabled={busy || readyCount === 0} onClick={() => void uploadBatch()} className='rounded-lg bg-emerald-500 px-5 py-3 text-sm font-semibold text-zinc-950 disabled:opacity-40'>
            {busy ? '处理中…' : '开始上传图片'}
          </button>
          <button type='button' disabled={busy || files.length === 0} onClick={clearFiles} className='rounded-lg border border-white/10 px-5 py-3 text-sm text-zinc-300 disabled:opacity-40'>清空</button>
        </div>

        {error && <p className='mt-4 rounded-lg bg-rose-500/10 p-3 text-sm text-rose-300'>{error}</p>}
        {message && <p className='mt-4 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-300'>{message}</p>}
      </section>

      <section className='mt-5 rounded-2xl border border-indigo-400/20 bg-indigo-500/5 p-5'>
        <h2 className='text-base font-medium text-indigo-200'>下一步：生成视频</h2>
        <p className='mt-2 text-sm leading-6 text-zinc-400'>上传完成后，打开图片素材库，点击任意图片进入详情，再选择“生成新视频版本”。Prompt 和时长只在图片详情页使用。</p>
        <a href='/assets' className='mt-4 inline-block rounded-lg border border-indigo-300/30 px-4 py-2 text-sm text-indigo-200'>打开图片素材库 →</a>
      </section>
    </div>
  </div>;
}
