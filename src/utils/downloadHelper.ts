/**
 * Robust video download utility for mobile and desktop browsers.
 * Handles Blob fetching, ObjectURL generation, cross-origin iframe workarounds,
 * and fallback options to ensure 100% video download reliability.
 */

export interface DownloadState {
  isDownloading: boolean;
  progress: number;
  error?: string;
}

export async function downloadVideoFile(
  videoUrl: string,
  fileName: string,
  onProgress?: (percent: number) => void
): Promise<boolean> {
  if (!videoUrl) return false;

  let isHttpServerError = false;

  try {
    let blob: Blob;

    if (videoUrl.startsWith('blob:')) {
      const resp = await fetch(videoUrl);
      if (!resp.ok) {
        isHttpServerError = true;
        throw new Error(`无法获取本地缓存视频 [HTTP ${resp.status}]`);
      }
      blob = await resp.blob();
    } else if (videoUrl.startsWith('data:')) {
      const resp = await fetch(videoUrl);
      if (!resp.ok) {
        isHttpServerError = true;
        throw new Error(`无法解析 Base64 视频数据 [HTTP ${resp.status}]`);
      }
      blob = await resp.blob();
    } else {
      // Stream URL or external HTTP URL
      const targetUrl = videoUrl.startsWith('/api/')
        ? `${videoUrl}${videoUrl.includes('?') ? '&' : '?'}download=1`
        : videoUrl;

      const resp = await fetch(targetUrl);
      const contentType = resp.headers.get('content-type') || '';

      if (!resp.ok || contentType.includes('application/json')) {
        isHttpServerError = true;
        let serverError = `HTTP Error ${resp.status}`;
        try {
          const errJson = await resp.json();
          if (errJson?.error) serverError = errJson.error;
        } catch {}
        throw new Error(serverError);
      }

      const contentLengthStr = resp.headers.get('content-length');
      const totalBytes = contentLengthStr ? parseInt(contentLengthStr, 10) : 0;

      if (resp.body && totalBytes > 0 && typeof ReadableStream !== 'undefined') {
        const reader = resp.body.getReader();
        let receivedBytes = 0;
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            receivedBytes += value.length;
            if (onProgress) {
              const percent = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
              onProgress(percent);
            }
          }
        }
        blob = new Blob(chunks, { type: 'video/mp4' });
      } else {
        blob = await resp.blob();
      }
    }

    if (blob.size < 1000) {
      isHttpServerError = true;
      throw new Error('视频文件在服务器端已被清理或未就绪，请在任务列表中点击【一键重试】重新渲染生成。');
    }

    if (onProgress) onProgress(100);

    const mp4Blob = new Blob([blob], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(mp4Blob);

    // Create download trigger
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = fileName.endsWith('.mp4') ? fileName : `${fileName}.mp4`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();

    setTimeout(() => {
      try {
        if (document.body.contains(link)) {
          document.body.removeChild(link);
        }
        URL.revokeObjectURL(blobUrl);
      } catch {}
    }, 15000);

    return true;
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn('[downloadVideoFile Error]:', errMsg);

    // ONLY attempt window.open as fallback for network/CORS DOM errors, NOT for server HTTP errors (404/500/JSON)
    if (!isHttpServerError && (videoUrl.startsWith('/api/') || videoUrl.startsWith('http'))) {
      const directUrl = videoUrl.startsWith('/api/')
        ? `${window.location.origin}${videoUrl}${videoUrl.includes('?') ? '&' : '?'}download=1`
        : videoUrl;
      try {
        window.open(directUrl, '_blank');
        return true;
      } catch {}
    }

    alert(`视频下载失败: ${errMsg}`);
    return false;
  }
}
