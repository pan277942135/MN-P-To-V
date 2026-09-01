/**
 * Binding history is only a browser shortcut. It deliberately stores no
 * project snapshot, asset metadata, image, video, or audio data.
 */
export const PROJECT_BINDING_HISTORY_KEY = 'zaojing_director_project_binding_history_v1';
const MAX_BINDING_HISTORY = 12;

export interface ProjectBindingHistoryEntry {
  bindingCode: string;
  projectId: string;
  projectTitle: string;
  lastOpenedAt: number;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function normalizeEntry(value: unknown): ProjectBindingHistoryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const bindingCode = clean(raw.bindingCode);
  const projectId = clean(raw.projectId);
  if (!bindingCode || !projectId) return null;
  const lastOpenedAt = Number(raw.lastOpenedAt);
  return {
    bindingCode,
    projectId,
    projectTitle: clean(raw.projectTitle) || projectId,
    lastOpenedAt: Number.isFinite(lastOpenedAt) && lastOpenedAt > 0 ? lastOpenedAt : 0,
  };
}

export function readProjectBindingHistory(): ProjectBindingHistoryEntry[] {
  const target = storage();
  if (!target) return [];
  try {
    const raw = target.getItem(PROJECT_BINDING_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const entries = parsed
      .map(normalizeEntry)
      .filter((entry): entry is ProjectBindingHistoryEntry => Boolean(entry));
    const unique = new Map<string, ProjectBindingHistoryEntry>();
    for (const entry of entries) {
      const key = entry.bindingCode.toUpperCase();
      const current = unique.get(key);
      if (!current || entry.lastOpenedAt >= current.lastOpenedAt) unique.set(key, entry);
    }
    return [...unique.values()]
      .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
      .slice(0, MAX_BINDING_HISTORY);
  } catch {
    return [];
  }
}

export function rememberProjectBinding(
  entryInput: Omit<ProjectBindingHistoryEntry, 'lastOpenedAt'> & { lastOpenedAt?: number },
): ProjectBindingHistoryEntry[] {
  const bindingCode = clean(entryInput.bindingCode);
  const projectId = clean(entryInput.projectId);
  if (!bindingCode || !projectId) return readProjectBindingHistory();
  const entry: ProjectBindingHistoryEntry = {
    bindingCode,
    projectId,
    projectTitle: clean(entryInput.projectTitle) || projectId,
    lastOpenedAt: Number(entryInput.lastOpenedAt) > 0 ? Number(entryInput.lastOpenedAt) : Date.now(),
  };
  const next = [
    entry,
    ...readProjectBindingHistory().filter((item) => item.bindingCode.toUpperCase() !== bindingCode.toUpperCase()),
  ].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt).slice(0, MAX_BINDING_HISTORY);
  const target = storage();
  if (target) {
    try {
      target.setItem(PROJECT_BINDING_HISTORY_KEY, JSON.stringify(next));
    } catch {
      // A private browsing quota/storage error must not block project restore.
    }
  }
  return next;
}

export function removeProjectBinding(bindingCodeInput: string): ProjectBindingHistoryEntry[] {
  const bindingCode = clean(bindingCodeInput).toUpperCase();
  const next = readProjectBindingHistory().filter((entry) => entry.bindingCode.toUpperCase() !== bindingCode);
  const target = storage();
  if (target) {
    try {
      if (next.length) target.setItem(PROJECT_BINDING_HISTORY_KEY, JSON.stringify(next));
      else target.removeItem(PROJECT_BINDING_HISTORY_KEY);
    } catch {
      // History is optional UI state.
    }
  }
  return next;
}

export function clearProjectBindingHistory(): void {
  const target = storage();
  if (!target) return;
  try {
    target.removeItem(PROJECT_BINDING_HISTORY_KEY);
  } catch {
    // History is optional UI state.
  }
}

export function latestProjectBinding(): ProjectBindingHistoryEntry | null {
  return readProjectBindingHistory()[0] || null;
}
