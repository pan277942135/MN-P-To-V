import { db } from '../db/database';
import type { GenerationTask } from '../types';
import { parseJsonResponse } from '../utils/apiClient';

export interface ITaskRepository {
  getAll(): Promise<GenerationTask[]>;
  getById(id: string): Promise<GenerationTask | undefined>;
  save(task: GenerationTask): Promise<void>;
  delete(id: string): Promise<void>;
  clearFailed(): Promise<void>;
}

export class DexieTaskRepository implements ITaskRepository {
  async getAll(): Promise<GenerationTask[]> {
    try {
      const connectionId = typeof window !== 'undefined' ? (localStorage.getItem('zaojing_connection_id') || '') : '';
      const res = await fetch('/api/videos/list', {
        headers: { 'x-connection-id': connectionId },
      });
      if (res.ok) {
        const data = await parseJsonResponse(res).catch(() => null);
        if (data && Array.isArray(data.tasks)) {
          for (const t of data.tasks) {
            try {
              if (!t || !t.id) continue;
              const existing = await db.tasks.get(t.id);
              if (existing) {
                await db.tasks.put({
                  ...existing,
                  ...t,
                  sceneImageBlob: existing.sceneImageBlob || t.sceneImageBlob,
                  sceneImageUrl: existing.sceneImageUrl || t.sceneImageUrl,
                  userPromptChinese: existing.userPromptChinese || t.userPromptChinese || (t as any).normalizedPromptChinese,
                  resultVideoUrl: t.resultVideoUrl || existing.resultVideoUrl,
                  error: t.error || existing.error,
                  status: t.status || existing.status,
                });
              } else {
                await db.tasks.put(t);
              }
            } catch (err) {
              console.warn('[taskRepository] Failed to merge task into db:', err);
            }
          }
        }
      }
    } catch {
      // network/offline fallback
    }
    try {
      const raw = await db.tasks.toArray();
      return (raw || []).sort(
        (a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0) || (b.id || '').localeCompare(a.id || '')
      );
    } catch {
      return [];
    }
  }

  async getById(id: string): Promise<GenerationTask | undefined> {
    try {
      return await db.tasks.get(id);
    } catch {
      return undefined;
    }
  }

  async save(task: GenerationTask): Promise<void> {
    try {
      await db.tasks.put(task);
    } catch (err) {
      console.warn('[taskRepository] Failed to save task to db:', err);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      // Delete on server
      const connectionId = typeof window !== 'undefined' ? (localStorage.getItem('zaojing_connection_id') || '') : '';
      await fetch(`/api/videos/${id}`, {
        method: 'DELETE',
        headers: { 'x-connection-id': connectionId },
      });
    } catch {}

    try {
      // Delete in IndexedDB
      await db.tasks.delete(id);
    } catch (err) {
      console.warn('[taskRepository] Failed to delete task from db:', err);
    }
  }

  async clearFailed(): Promise<void> {
    try {
      const connectionId = typeof window !== 'undefined' ? (localStorage.getItem('zaojing_connection_id') || '') : '';
      await fetch('/api/videos/clear-failed', {
        method: 'POST',
        headers: { 'x-connection-id': connectionId },
      });
    } catch {}

    try {
      const allTasks = await db.tasks.toArray();
      const deletableIds = allTasks.filter((t) => {
        if (!t || !t.id) return false;
        return t.status === 'failed' ||
          t.status === 'orphaned_local_task' ||
          (t.status as string) === 'submit_failed_safe_to_retry' ||
          Boolean(t.error) ||
          (typeof t.progressStage === 'string' && t.progressStage.includes('失败'));
      }).map((t) => t.id).filter(Boolean);

      for (const fid of deletableIds) {
        await db.tasks.delete(fid);
      }
    } catch (err) {
      console.warn('[taskRepository] Failed to clear failed tasks from db:', err);
    }
  }
}

export const taskRepository: ITaskRepository = new DexieTaskRepository();
