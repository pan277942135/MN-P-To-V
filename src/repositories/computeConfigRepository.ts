import { db } from '../db/database';
import type { SavedComputeConfig, ComputeConnectionType } from '../types';

export class ComputeConfigRepository {
  async get(): Promise<SavedComputeConfig | null> {
    try {
      const record = await db.computeConfigs.get('primary');
      if (record) {
        return {
          ...record,
          serviceAccountJson: '', // Security: Never retrieve or store raw service account JSON in client database
        };
      }

      // Fallback: check localStorage draft
      const saved = localStorage.getItem('zaojing_saved_compute_config');
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          id: 'primary',
          activeTab: (parsed.activeTab as ComputeConnectionType) || 'vertex_ai',
          projectId: parsed.projectId || 'xp-vertex-project',
          location: parsed.location || 'us-central1',
          serviceAccountJson: '', // Security: Never store raw JSON in localStorage
          apiKey: parsed.apiKey || '',
          analysisModel: parsed.analysisModel || 'gemini-2.5-flash',
          imageModel: parsed.imageModel || 'gemini-2.5-flash',
          videoModel: parsed.videoModel || 'veo-3.1-fast-generate-001',
          updatedAt: Date.now(),
          autoConnect: true,
        };
      }
      return null;
    } catch (err) {
      console.warn('Failed to read computeConfig from database:', err);
      return null;
    }
  }

  async save(config: Omit<SavedComputeConfig, 'id' | 'updatedAt'>): Promise<SavedComputeConfig> {
    // Security Mandate: Strip raw serviceAccountJson before saving to Dexie / localStorage
    const safeConfig = {
      ...config,
      serviceAccountJson: '',
    };

    const record: SavedComputeConfig = {
      ...safeConfig,
      id: 'primary',
      updatedAt: Date.now(),
      autoConnect: config.autoConnect ?? true,
    };

    try {
      await db.computeConfigs.put(record);
    } catch (err) {
      console.warn('Failed to save computeConfig to IndexedDB database:', err);
    }

    try {
      localStorage.setItem('zaojing_saved_compute_config', JSON.stringify(record));
    } catch {
      // ignore localStorage quota errors
    }

    return record;
  }

  async clear(): Promise<void> {
    try {
      await db.computeConfigs.delete('primary');
    } catch (err) {
      console.warn('Failed to delete computeConfig from database:', err);
    }
    localStorage.removeItem('zaojing_saved_compute_config');
  }
}

export const computeConfigRepository = new ComputeConfigRepository();
