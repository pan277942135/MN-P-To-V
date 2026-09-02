import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  applyDirectorCloudSnapshot,
  syncDirectorCloud,
  type DirectorCloudRecord,
  type DirectorCloudSnapshot,
} from '../services/director/directorCloudPersistence';
import {
  restoreProjectByBinding,
  type ProjectBindingRestoreResponse,
} from '../services/director/projectBindingClient';
import {
  latestProjectBinding,
  rememberProjectBinding,
} from '../services/director/projectBindingHistory';
import { syncLocalShotPipeline } from '../services/director/shotProductionWorkflow';
import { getProjectSession, type ProjectSessionResponse } from '../services/director/projectSessionClient';
import type { DirectorAssetRecord } from '../services/assetRegistry/assetRegistryTypes';
import type { DirectorContext } from '../services/directorContext/directorContextTypes';
import { useDirectorCloud } from '../components/DirectorCloudPersistenceProvider';

export type ProjectSessionStatus = 'empty' | 'loading' | 'ready' | 'error';

export interface ProjectSessionState {
  status: ProjectSessionStatus;
  project: Record<string, unknown> | null;
  episode: Record<string, unknown> | null;
  shots: Array<Record<string, unknown>>;
  assets: DirectorAssetRecord[];
  directorContext: DirectorContext | null;
  bindingCode: string;
  projectId: string;
  episodeId: string;
  error: string;
  version: number;
}

export interface ProjectSessionContextValue extends ProjectSessionState {
  refreshSession: (
    projectId?: string,
    episodeId?: string,
    options?: { silent?: boolean },
  ) => Promise<ProjectSessionState | null>;
  restoreWithBinding: (
    bindingCode: string,
  ) => Promise<{ payload: ProjectBindingRestoreResponse; session: ProjectSessionState }>;
  syncLocalChanges: () => Promise<ProjectSessionState | null>;
  hydrateAsset: (asset: DirectorAssetRecord) => void;
  invalidateSession: () => Promise<ProjectSessionState | null>;
}

const EMPTY_PROJECT_SESSION: ProjectSessionState = {
  status: 'empty',
  project: null,
  episode: null,
  shots: [],
  assets: [],
  directorContext: null,
  bindingCode: '',
  projectId: '',
  episodeId: '',
  error: '',
  version: 0,
};

const EMPTY_PROJECT_SESSION_CONTEXT: ProjectSessionContextValue = {
  ...EMPTY_PROJECT_SESSION,
  refreshSession: async () => null,
  restoreWithBinding: async () => {
    throw new Error('ProjectSessionProvider 未挂载。');
  },
  syncLocalChanges: async () => null,
  hydrateAsset: () => undefined,
  invalidateSession: async () => null,
};

const ProjectSessionContext = createContext<ProjectSessionContextValue | null>(null);

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function restoredCloudRecord(payload: ProjectBindingRestoreResponse): DirectorCloudRecord {
  const snapshot: DirectorCloudSnapshot = {
    schema: 'zaojing.director.cloud.v1',
    projectId: payload.project.projectId,
    episodeId: payload.episode.episodeId,
    seriesTitle: payload.project.seriesTitle,
    projectTitle: payload.project.projectTitle,
    clientUpdatedAt: Number(payload.episode.clientUpdatedAt || 0),
    stages: payload.stages,
    ...(payload.project.formatPolicy ? { formatPolicy: payload.project.formatPolicy } : {}),
  };
  return { snapshot, serverUpdatedAt: payload.serverUpdatedAt };
}

function stateFromPayload(
  payload: ProjectSessionResponse,
  bindingCode: string,
  version: number,
): ProjectSessionState {
  const projectId = clean(payload.project?.projectId);
  const episodeId = clean(payload.episode?.episodeId);
  return {
    status: 'ready',
    project: payload.project || null,
    episode: payload.episode || null,
    shots: Array.isArray(payload.shots) ? payload.shots : [],
    assets: Array.isArray(payload.assets) ? payload.assets : [],
    directorContext: payload.context || null,
    bindingCode,
    projectId,
    episodeId,
    error: '',
    version,
  };
}

export function useProjectSession(): ProjectSessionContextValue {
  return useContext(ProjectSessionContext) || EMPTY_PROJECT_SESSION_CONTEXT;
}

export const ProjectSessionProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { record, setRecord } = useDirectorCloud();
  const [state, setState] = useState<ProjectSessionState>(EMPTY_PROJECT_SESSION);
  const stateRef = useRef(state);
  const recordRef = useRef(record);
  const bindingCodeRef = useRef('');
  const autoRestoreAttemptedRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    recordRef.current = record;
  }, [record]);

  const commitPayload = useCallback((payload: ProjectSessionResponse): ProjectSessionState => {
    const next = stateFromPayload(payload, bindingCodeRef.current, stateRef.current.version + 1);
    stateRef.current = next;
    setState(next);
    return next;
  }, []);

  const refreshSession = useCallback(async (
    projectIdInput = '',
    episodeIdInput = '',
    options: { silent?: boolean } = {},
  ): Promise<ProjectSessionState | null> => {
    const current = stateRef.current;
    const cloud = recordRef.current;
    const explicitProjectId = clean(projectIdInput);
    const projectId = explicitProjectId || current.projectId || clean(cloud?.snapshot.projectId);
    const episodeId = clean(episodeIdInput)
      || (projectId === current.projectId ? current.episodeId : '')
      || (projectId === clean(cloud?.snapshot.projectId) ? clean(cloud?.snapshot.episodeId) : '');
    if (!projectId) {
      stateRef.current = { ...EMPTY_PROJECT_SESSION, version: current.version };
      setState(stateRef.current);
      return null;
    }
    if (!options.silent) {
      const loadingState: ProjectSessionState = {
        ...current,
        status: 'loading',
        projectId,
        episodeId,
        error: '',
      };
      stateRef.current = loadingState;
      setState(loadingState);
    }
    try {
      const payload = await getProjectSession(projectId, episodeId);
      return commitPayload(payload);
    } catch (cause: any) {
      if (!options.silent) {
        const errorState: ProjectSessionState = {
          ...stateRef.current,
          status: 'error',
          projectId,
          episodeId,
          error: cause?.message || String(cause),
        };
        stateRef.current = errorState;
        setState(errorState);
      }
      throw cause;
    }
  }, [commitPayload]);

  const restoreWithBinding = useCallback(async (bindingCodeInput: string) => {
    const bindingCode = clean(bindingCodeInput);
    if (!bindingCode) throw new Error('请输入项目绑定码。');
    const payload = await restoreProjectByBinding(bindingCode);
    const cloudRecord = restoredCloudRecord(payload);

    // Preserve the legacy production snapshot for existing pages and local
    // workflow code. Registry remains the canonical cross-device asset index.
    try {
      await applyDirectorCloudSnapshot(cloudRecord.snapshot, { restoreAssets: true });
    } catch (cause) {
      console.warn('[Project Session] legacy asset hydration skipped:', cause instanceof Error ? cause.message : String(cause));
      await applyDirectorCloudSnapshot(cloudRecord.snapshot, { restoreAssets: false }).catch(() => undefined);
    }
    try {
      syncLocalShotPipeline();
    } catch (cause) {
      console.warn('[Project Session] local production hydration skipped:', cause instanceof Error ? cause.message : String(cause));
    }

    bindingCodeRef.current = bindingCode;
    recordRef.current = cloudRecord;
    setRecord(cloudRecord);
    rememberProjectBinding({
      bindingCode,
      projectId: payload.project.projectId,
      projectTitle: payload.project.projectTitle,
    });
    const session = await refreshSession(payload.project.projectId, payload.episode.episodeId);
    if (!session) throw new Error('Project Session 恢复失败。');
    return { payload, session };
  }, [refreshSession, setRecord]);

  const syncLocalChanges = useCallback(async (): Promise<ProjectSessionState | null> => {
    const syncedRecord = await syncDirectorCloud();
    recordRef.current = syncedRecord;
    setRecord(syncedRecord);
    return refreshSession(syncedRecord.snapshot.projectId, syncedRecord.snapshot.episodeId, { silent: true });
  }, [refreshSession, setRecord]);

  const hydrateAsset = useCallback((asset: DirectorAssetRecord) => {
    const current = stateRef.current;
    const assets = [
      asset,
      ...current.assets.filter((item) => item.assetId !== asset.assetId),
    ];
    const next = { ...current, assets, version: current.version + 1 };
    stateRef.current = next;
    setState(next);
  }, []);

  const invalidateSession = useCallback(
    () => refreshSession(undefined, undefined, { silent: false }),
    [refreshSession],
  );

  const cloudProjectId = clean(record?.snapshot.projectId);
  const cloudEpisodeId = clean(record?.snapshot.episodeId);

  useEffect(() => {
    if (!cloudProjectId) return;
    const recent = latestProjectBinding();
    // DirectorCloud bootstraps the most recently updated cloud project when a
    // browser has no local snapshot. If binding history points at another
    // project, let the explicit recent-binding restore win that race.
    if (recent && recent.projectId !== cloudProjectId && !stateRef.current.projectId) return;
    const current = stateRef.current;
    if (
      current.status === 'ready'
      && current.projectId === cloudProjectId
      && (!cloudEpisodeId || current.episodeId === cloudEpisodeId)
    ) return;
    void refreshSession(cloudProjectId, cloudEpisodeId).catch(() => undefined);
  }, [cloudEpisodeId, cloudProjectId, refreshSession]);

  useEffect(() => {
    if (autoRestoreAttemptedRef.current) return;
    autoRestoreAttemptedRef.current = true;
    const recent = latestProjectBinding();
    if (!recent) return;
    const currentProjectId = clean(recordRef.current?.snapshot.projectId);
    // A local project or a cloud-bootstrap project already matching the most
    // recent binding needs no extra restore request. If a browser has binding
    // history but no matching local project, the shortcut opens that project.
    if (currentProjectId === recent.projectId) {
      bindingCodeRef.current = recent.bindingCode;
      if (stateRef.current.bindingCode !== recent.bindingCode) {
        const next = { ...stateRef.current, bindingCode: recent.bindingCode };
        stateRef.current = next;
        setState(next);
      }
      return;
    }
    void restoreWithBinding(recent.bindingCode).catch((cause) => {
      console.warn('[Project Session] recent binding auto-open skipped:', cause instanceof Error ? cause.message : String(cause));
      if (currentProjectId) {
        void refreshSession(currentProjectId, clean(recordRef.current?.snapshot.episodeId), { silent: true }).catch(() => undefined);
      }
    });
  }, [refreshSession, restoreWithBinding]);

  useEffect(() => {
    if (!state.projectId) return;
    const timer = window.setInterval(() => {
      void refreshSession(state.projectId, state.episodeId, { silent: true }).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshSession, state.episodeId, state.projectId]);

  const value: ProjectSessionContextValue = {
    ...state,
    refreshSession,
    restoreWithBinding,
    syncLocalChanges,
    hydrateAsset,
    invalidateSession,
  };
  return (
    <ProjectSessionContext.Provider value={value}>
      {children}
    </ProjectSessionContext.Provider>
  );
};
