import React, { useEffect, useRef, useState } from 'react';
import {
  bootstrapDirectorCloud,
  computeDirectorLocalFingerprint,
  syncDirectorCloud,
} from '../services/director/directorCloudPersistence';
import { syncLocalShotPipeline } from '../services/director/shotProductionWorkflow';

type CloudState = 'booting' | 'synced' | 'syncing' | 'offline';

export const DirectorCloudPersistenceProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [state, setState] = useState<CloudState>('booting');
  const [message, setMessage] = useState('正在连接 Director Cloud…');
  const lastFingerprintRef = useRef('');
  const syncingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const syncIfChanged = async () => {
      if (cancelled || syncingRef.current) return;
      const fingerprint = computeDirectorLocalFingerprint();
      if (!fingerprint || fingerprint === lastFingerprintRef.current) return;
      syncingRef.current = true;
      if (!cancelled) {
        setState('syncing');
        setMessage('正在同步 Director 项目到 Firestore / GCS…');
      }
      try {
        await syncDirectorCloud();
        // Only mark the exact version that was sent as synced. If the user edits
        // while the request is in-flight, the next interval will see a new fingerprint.
        lastFingerprintRef.current = fingerprint;
        if (!cancelled) {
          setState('synced');
          setMessage('Director Cloud 已同步');
        }
      } catch (error: any) {
        if (!cancelled) {
          setState('offline');
          setMessage(`Cloud 同步失败，本地缓存继续可用：${error?.message || String(error)}`);
        }
      } finally {
        syncingRef.current = false;
      }
    };

    void (async () => {
      try {
        const result = await bootstrapDirectorCloud();
        if (cancelled) return;

        // Convert legacy whole-stage PASS state into the current Shot-centric model
        // before the first fingerprint is recorded. This annotates each existing
        // Shot with stable dependency metadata and removes automatic-QA/global gates.
        syncLocalShotPipeline();

        lastFingerprintRef.current = computeDirectorLocalFingerprint();
        setState('synced');
        setMessage(
          result.mode === 'migrated'
            ? '本地 Director 项目已迁移到 Firestore / GCS'
            : result.mode === 'restored'
              ? '已从 Director Cloud 恢复项目'
              : result.mode === 'empty'
                ? 'Director Cloud 已连接，等待创建项目'
                : 'Director Cloud 已同步',
        );
      } catch (error: any) {
        if (cancelled) return;
        lastFingerprintRef.current = computeDirectorLocalFingerprint();
        setState('offline');
        setMessage(`Cloud 暂不可用，本地缓存继续可用：${error?.message || String(error)}`);
      }
      timer = window.setInterval(() => { void syncIfChanged(); }, 2500);
    })();

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void syncIfChanged();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  if (state === 'booting') {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-6 py-5 text-sm text-zinc-300 shadow-xl">
          <div className="font-semibold text-white">Director Cloud</div>
          <div className="mt-1 text-zinc-400">{message}</div>
        </div>
      </div>
    );
  }

  return (
    <>
      {children}
      <div
        data-testid="director-cloud-status"
        className={`fixed right-3 top-3 z-[80] rounded-full border px-3 py-1.5 text-[11px] shadow-lg backdrop-blur ${
          state === 'synced'
            ? 'border-emerald-500/30 bg-emerald-950/75 text-emerald-300'
            : state === 'syncing'
              ? 'border-sky-500/30 bg-sky-950/75 text-sky-300'
              : 'border-amber-500/30 bg-amber-950/75 text-amber-300'
        }`}
        title={message}
      >
        {state === 'synced' ? 'Cloud · Synced' : state === 'syncing' ? 'Cloud · Syncing' : 'Cloud · Local fallback'}
      </div>
    </>
  );
};
