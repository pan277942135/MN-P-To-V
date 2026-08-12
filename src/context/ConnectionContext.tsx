import React, { createContext, useContext, useState, useEffect } from 'react';
import type { ComputeConnectionInfo } from '../types';
import { parseJsonResponse } from '../utils/apiClient';
import { computeConfigRepository } from '../repositories/computeConfigRepository';

interface ConnectionContextType {
  connectionInfo: ComputeConnectionInfo | null;
  hasServerSecret: boolean;
  isConnected: boolean;
  setConnectionInfo: (info: ComputeConnectionInfo | null) => void;
  checkStatus: () => Promise<void>;
  autoReconnectFromDb: () => Promise<boolean>;
  disconnect: () => Promise<void>;
}

const ConnectionContext = createContext<ConnectionContextType | null>(null);

export const ConnectionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [connectionInfo, setConnectionInfo] = useState<ComputeConnectionInfo | null>(null);
  const [hasServerSecret, setHasServerSecret] = useState(false);

  const setInfo = (info: ComputeConnectionInfo | null) => {
    setConnectionInfo(info);
    if (info) {
      localStorage.setItem('zaojing_connection_id', info.connectionId);
    } else {
      localStorage.removeItem('zaojing_connection_id');
    }
  };

  const autoReconnectFromDb = async (): Promise<boolean> => {
    try {
      const savedConfig = await computeConfigRepository.get();
      if (savedConfig && savedConfig.autoConnect !== false) {
        let body: any = {
          type: savedConfig.activeTab,
          analysisModel: savedConfig.analysisModel || 'gemini-3.6-flash',
          imageModel: savedConfig.imageModel || 'gemini-3.1-flash-image',
          videoModel: savedConfig.videoModel || 'gemini-omni-flash-preview',
        };

        if (savedConfig.activeTab === 'vertex_ai') {
          if (savedConfig.projectId && savedConfig.serviceAccountJson) {
            body.projectId = savedConfig.projectId;
            body.location = savedConfig.location || 'global';
            body.serviceAccountJson = savedConfig.serviceAccountJson;
          } else {
            body = null;
          }
        } else if (savedConfig.activeTab === 'gemini_api_key') {
          if (savedConfig.apiKey) {
            body.apiKey = savedConfig.apiKey;
          } else {
            body = null;
          }
        } else if (savedConfig.activeTab === 'server_env_secret') {
          // keep body as server_env_secret
        } else {
          body = null;
        }

        if (body) {
          const res = await fetch('/api/connections/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          if (res.ok) {
            const data = await parseJsonResponse(res);
            if (data.success && data.info) {
              setInfo(data.info);
              return true;
            }
          }
        }
      }
    } catch (e) {
      console.warn('Auto reconnect failed:', e);
    }
    return false;
  };

  const checkStatus = async () => {
    try {
      const storedId = localStorage.getItem('zaojing_connection_id');
      const res = await fetch('/api/connections/status', {
        headers: storedId ? { 'x-connection-id': storedId } : {},
      });

      if (res.ok) {
        const data = await parseJsonResponse(res);
        setHasServerSecret(Boolean(data.hasServerSecret));

        if (data.isConnected && data.sessionInfo) {
          setConnectionInfo(data.sessionInfo);
          return;
        }

        // If server secret is available on backend, auto-connect to server secret
        if (data.hasServerSecret) {
          const connRes = await fetch('/api/connections/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'server_env_secret',
              analysisModel: 'gemini-3.6-flash',
              imageModel: 'gemini-3.1-flash-image',
              videoModel: 'gemini-omni-flash-preview',
            }),
          });
          if (connRes.ok) {
            const connData = await parseJsonResponse(connRes);
            if (connData.success && connData.info) {
              setInfo(connData.info);
              return;
            }
          }
        }
      }

      // If server session invalid, auto reconnect from database config
      const reconnected = await autoReconnectFromDb();
      if (!reconnected) {
        setConnectionInfo(null);
        localStorage.removeItem('zaojing_connection_id');
      }
    } catch {
      await autoReconnectFromDb();
    }
  };

  useEffect(() => {
    checkStatus();
  }, []);

  const disconnect = async () => {
    if (connectionInfo?.connectionId) {
      try {
        await fetch(`/api/connections/${connectionInfo.connectionId}`, {
          method: 'DELETE',
        });
      } catch {
        // ignore disconnect network error
      }
    }
    setInfo(null);
  };

  return (
    <ConnectionContext.Provider
      value={{
        connectionInfo,
        hasServerSecret,
        isConnected: Boolean(connectionInfo),
        setConnectionInfo: setInfo,
        checkStatus,
        autoReconnectFromDb,
        disconnect,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  );
};

export const useConnection = () => {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection must be used within ConnectionProvider');
  return ctx;
};
