import React, { useState } from 'react';
import { Database, Copy, Check, ExternalLink, Film, ArrowUpRight } from 'lucide-react';
import { GenerationTask } from '../types';
import { useConnection } from '../context/ConnectionContext';

export function parseGcsUri(uri?: string | null) {
  if (!uri || typeof uri !== 'string') return null;
  const trimmed = uri.trim();
  if (trimmed.startsWith('gs://')) {
    const rawPath = trimmed.replace('gs://', '');
    const slashIdx = rawPath.indexOf('/');
    if (slashIdx > 0) {
      const bucket = rawPath.substring(0, slashIdx);
      const objectPath = rawPath.substring(slashIdx + 1);
      return {
        gsUri: trimmed,
        bucket,
        objectPath,
        consoleUrl: `https://console.cloud.google.com/storage/browser/_details/${bucket}/${objectPath}`,
        bucketConsoleUrl: `https://console.cloud.google.com/storage/browser/${bucket}`,
        httpUrl: `https://storage.googleapis.com/${bucket}/${objectPath}`,
      };
    }
    return {
      gsUri: trimmed,
      bucket: rawPath,
      objectPath: '',
      consoleUrl: `https://console.cloud.google.com/storage/browser/${rawPath}`,
      bucketConsoleUrl: `https://console.cloud.google.com/storage/browser/${rawPath}`,
      httpUrl: `https://storage.googleapis.com/${rawPath}`,
    };
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return {
      gsUri: trimmed,
      bucket: '',
      objectPath: '',
      consoleUrl: trimmed,
      bucketConsoleUrl: trimmed,
      httpUrl: trimmed,
    };
  }
  return null;
}

export const GcsLocationCard: React.FC<{ task: GenerationTask; payload?: any }> = ({ task, payload }) => {
  const { connectionInfo } = useConnection();
  const gcsUriRaw =
    task?.videoUri ||
    (task as any)?.outputUri ||
    payload?.outputs?.videoUri ||
    payload?.outputs?.outputUri ||
    ((task as any)?.videoDataUrl?.startsWith('gs://') ? (task as any).videoDataUrl : null);

  const parsedGcs = parseGcsUri(gcsUriRaw);
  const [copiedGcs, setCopiedGcs] = useState(false);

  const projectId =
    task?.projectId ||
    (task as any)?.error?.projectId ||
    payload?.projectId ||
    connectionInfo?.projectId ||
    'xp-vertex-project';

  const opName = task?.externalOperationName || (task as any)?.operationName || payload?.operationName;
  const region = task?.region || (task as any)?.region || 'us-central1';

  const gcsConsoleGeneralUrl = `https://console.cloud.google.com/storage/browser?project=${projectId}`;
  const vertexAiConsoleUrl = `https://console.cloud.google.com/vertex-ai?project=${projectId}`;
  const vertexOperationsUrl = `https://console.cloud.google.com/vertex-ai/locations/${region}/operations?project=${projectId}`;

  return (
    <div className="p-4 bg-zinc-950 border border-indigo-900/60 rounded-xl space-y-3 text-xs shadow-lg text-left">
      <div className="flex items-center justify-between border-b border-zinc-800/80 pb-2.5">
        <div className="flex items-center gap-2 font-bold text-indigo-300">
          <Database className="w-4 h-4 text-indigo-400" />
          <span>Google Cloud Storage 云端存储位置与直联访问</span>
        </div>
        {parsedGcs && (
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(parsedGcs.gsUri);
              setCopiedGcs(true);
              setTimeout(() => setCopiedGcs(false), 2000);
            }}
            className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-indigo-300 font-semibold text-[11px] flex items-center gap-1 transition cursor-pointer"
          >
            {copiedGcs ? (
              <>
                <Check className="w-3 h-3 text-emerald-400" />
                <span>已复制 GCS 路径</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3 text-indigo-400" />
                <span>复制 GCS URI</span>
              </>
            )}
          </button>
        )}
      </div>

      {parsedGcs ? (
        <div className="space-y-2.5">
          <div className="p-3 bg-zinc-900/90 rounded-lg border border-zinc-800 font-mono text-[11px] break-all text-indigo-200">
            <span className="text-zinc-500 font-sans font-medium mr-2">GCS 路径:</span>
            <span>{parsedGcs.gsUri}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <a
              href={`${parsedGcs.consoleUrl}?project=${projectId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs flex items-center gap-1.5 shadow transition cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              打开 Google Cloud Storage 控制台链接
            </a>
            {parsedGcs.bucketConsoleUrl && (
              <a
                href={`${parsedGcs.bucketConsoleUrl}?project=${projectId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-indigo-200 font-medium text-xs flex items-center gap-1.5 border border-zinc-700/80 transition cursor-pointer"
              >
                <Database className="w-3.5 h-3.5 text-indigo-400" />
                浏览 GCP 存储桶 ({parsedGcs.bucket})
              </a>
            )}
            {parsedGcs.httpUrl && parsedGcs.httpUrl !== parsedGcs.consoleUrl && (
              <a
                href={parsedGcs.httpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium text-xs flex items-center gap-1.5 border border-zinc-700/80 transition cursor-pointer"
              >
                <Film className="w-3.5 h-3.5 text-zinc-400" />
                Storage 公开直链
              </a>
            )}
          </div>
        </div>
      ) : (
        <div className="p-3 bg-zinc-900/50 rounded-lg border border-zinc-800/60 text-zinc-400 text-xs leading-relaxed space-y-2.5">
          <div className="text-indigo-300 font-bold flex items-center gap-1.5">
            <span>📍 Google Cloud Storage (GCS) 云端位置与控制台直联：</span>
          </div>
          <p>
            Veo 视频生成于 Google Cloud Platform (Vertex AI 算力中心，绑定项目 <code className="text-indigo-300 bg-zinc-900 px-1.5 py-0.5 rounded font-mono">{projectId}</code>)，生成的原始 MP4 文件存放于 GCP 云端 Storage 存储桶。
          </p>
          <p className="text-zinc-300">
            点击下方跳转链接，可直接在浏览器中打开 Google Cloud Platform 对应的 Storage 控制台或 Vertex AI 算力中心：
          </p>
          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <a
              href={gcsConsoleGeneralUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs flex items-center gap-1.5 shadow transition cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              打开 Google Cloud Storage 控制台链接
            </a>
            <a
              href={vertexAiConsoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-indigo-200 font-medium text-xs flex items-center gap-1.5 border border-zinc-700/80 transition cursor-pointer"
            >
              <ArrowUpRight className="w-3.5 h-3.5 text-indigo-400" />
              打开 Vertex AI 算力中心
            </a>
            {opName && (
              <a
                href={vertexOperationsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium text-xs flex items-center gap-1.5 border border-zinc-700/80 transition cursor-pointer"
              >
                <Film className="w-3.5 h-3.5 text-zinc-400" />
                查看 GCP Operation 算力任务
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
