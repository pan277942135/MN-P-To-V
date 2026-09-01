import { randomInt } from 'node:crypto';
import { getFirestoreInstance, markFirestoreUnavailable } from '../db/firestore';
import { DIRECTOR_PROJECT_COLLECTION } from '../repositories/firestoreDirectorProjectRepository';

export const PROJECT_BINDING_COLLECTION = 'director_project_bindings';
export const PROJECT_BINDING_STATUS_ACTIVE = 'ACTIVE' as const;
export const PROJECT_BINDING_FORMAT = /^ZJ-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/;

export interface ProjectBindingRecord {
  bindingCode: string;
  normalizedCode: string;
  projectId: string;
  createdAt: number;
  status: typeof PROJECT_BINDING_STATUS_ACTIVE | 'REVOKED' | 'EXPIRED';
  expiresAt?: number;
}

export interface ProjectBindingStoreLike {
  isAvailable(): boolean;
  reserveBinding(record: ProjectBindingRecord): Promise<boolean>;
  getBinding(normalizedCode: string): Promise<ProjectBindingRecord | null>;
}

export interface ProjectBindingServiceOptions {
  store?: ProjectBindingStoreLike;
  now?: () => number;
  createCode?: () => string;
  maxAttempts?: number;
}

export class ProjectBindingError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'ProjectBindingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Binding codes are case-insensitive for people entering them on a phone.
 * Whitespace is ignored, while the displayed code keeps its mixed-case form.
 */
export function normalizeBindingCode(value: unknown): string {
  return clean(value).replace(/\s+/g, '').toUpperCase();
}

export function isValidBindingCode(value: unknown): boolean {
  const normalized = normalizeBindingCode(value);
  return PROJECT_BINDING_FORMAT.test(normalized);
}

const UPPERCASE = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';
const ALL_CHARS = `${UPPERCASE}${LOWERCASE}${DIGITS}`;

function secureChar(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)] || alphabet[0];
}

function shuffled<T>(items: T[]): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

/** Generates a readable mixed-case, mixed-alphanumeric code that is not a Firestore ID. */
export function generateProjectBindingCode(): string {
  const segment = () => shuffled([
    secureChar(UPPERCASE),
    secureChar(LOWERCASE),
    secureChar(DIGITS),
    secureChar(ALL_CHARS),
  ]).join('');
  return `ZJ-${segment()}-${segment()}`;
}

class FirestoreProjectBindingStore implements ProjectBindingStoreLike {
  isAvailable(): boolean {
    return Boolean(getFirestoreInstance());
  }

  async reserveBinding(record: ProjectBindingRecord): Promise<boolean> {
    const db = getFirestoreInstance();
    if (!db) throw new ProjectBindingError('PROJECT_BINDING_UNAVAILABLE', 'Director Firestore 当前不可用。', 503);

    try {
      const bindingRef = db.collection(PROJECT_BINDING_COLLECTION).doc(record.normalizedCode);
      const projectRef = db.collection(DIRECTOR_PROJECT_COLLECTION).doc(record.projectId);

      // Firestore transactions make the code reservation atomic under concurrent
      // requests. The fallback keeps the store usable with lightweight test doubles.
      if (typeof (db as any).runTransaction === 'function') {
        return await (db as any).runTransaction(async (transaction: any) => {
          const bindingDoc = await transaction.get(bindingRef);
          if (bindingDoc.exists) return false;
          const projectDoc = await transaction.get(projectRef);
          if (!projectDoc.exists) {
            throw new ProjectBindingError(
              'PROJECT_NOT_FOUND',
              `找不到 Director 项目 ${record.projectId}。请先保存项目到 Director Cloud。`,
              404,
            );
          }
          if (typeof transaction.create === 'function') transaction.create(bindingRef, record);
          else transaction.set(bindingRef, record);
          transaction.set(projectRef, {
            bindingCode: record.bindingCode,
            bindingCodeNormalized: record.normalizedCode,
            bindingStatus: record.status,
            updatedAt: record.createdAt,
          }, { merge: true });
          return true;
        });
      }

      const projectDoc = await projectRef.get();
      if (!projectDoc.exists) {
        throw new ProjectBindingError(
          'PROJECT_NOT_FOUND',
          `找不到 Director 项目 ${record.projectId}。请先保存项目到 Director Cloud。`,
          404,
        );
      }
      const existing = await bindingRef.get();
      if (existing.exists) return false;
      if (typeof (bindingRef as any).create === 'function') await (bindingRef as any).create(record);
      else await bindingRef.set(record);
      await projectRef.set({
        bindingCode: record.bindingCode,
        bindingCodeNormalized: record.normalizedCode,
        bindingStatus: record.status,
        updatedAt: record.createdAt,
      }, { merge: true });
      return true;
    } catch (error) {
      if (error instanceof ProjectBindingError) throw error;
      markFirestoreUnavailable(error);
      throw error;
    }
  }

  async getBinding(normalizedCode: string): Promise<ProjectBindingRecord | null> {
    const db = getFirestoreInstance();
    if (!db) throw new ProjectBindingError('PROJECT_BINDING_UNAVAILABLE', 'Director Firestore 当前不可用。', 503);

    try {
      const doc = await db.collection(PROJECT_BINDING_COLLECTION).doc(normalizedCode).get();
      if (!doc.exists) return null;
      const data = doc.data() || {};
      const bindingCode = clean(data.bindingCode);
      const storedNormalizedCode = clean(data.normalizedCode) || normalizedCode;
      if (!bindingCode || storedNormalizedCode !== normalizedCode || normalizeBindingCode(bindingCode) !== normalizedCode) {
        return null;
      }
      return {
        bindingCode,
        normalizedCode: storedNormalizedCode,
        projectId: clean(data.projectId),
        createdAt: Number(data.createdAt || 0),
        status: data.status || 'ACTIVE',
        ...(data.expiresAt !== undefined && data.expiresAt !== null
          ? { expiresAt: Number(data.expiresAt) }
          : {}),
      };
    } catch (error) {
      markFirestoreUnavailable(error);
      throw error;
    }
  }
}

export class ProjectBindingService {
  private readonly store: ProjectBindingStoreLike;
  private readonly now: () => number;
  private readonly createCode: () => string;
  private readonly maxAttempts: number;

  constructor(options: ProjectBindingServiceOptions = {}) {
    this.store = options.store || new FirestoreProjectBindingStore();
    this.now = options.now || (() => Date.now());
    this.createCode = options.createCode || generateProjectBindingCode;
    this.maxAttempts = Math.max(1, Math.min(50, options.maxAttempts || 12));
  }

  async createBinding(projectIdInput: string): Promise<string> {
    const projectId = clean(projectIdInput);
    if (!projectId) {
      throw new ProjectBindingError('PROJECT_ID_REQUIRED', 'projectId 不能为空。', 400);
    }
    if (!this.store.isAvailable()) {
      throw new ProjectBindingError('PROJECT_BINDING_UNAVAILABLE', 'Director Firestore 当前不可用。', 503);
    }

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const bindingCode = this.createCode();
      const normalizedCode = normalizeBindingCode(bindingCode);
      if (!isValidBindingCode(bindingCode)) continue;
      const reserved = await this.store.reserveBinding({
        bindingCode,
        normalizedCode,
        projectId,
        createdAt: this.now(),
        status: PROJECT_BINDING_STATUS_ACTIVE,
      });
      if (reserved) return bindingCode;
    }

    throw new ProjectBindingError(
      'PROJECT_BINDING_COLLISION',
      '绑定码生成冲突，请稍后重试。',
      503,
    );
  }

  async resolveBinding(bindingCodeInput: string): Promise<string | null> {
    if (!isValidBindingCode(bindingCodeInput)) {
      throw new ProjectBindingError('BINDING_CODE_INVALID', '绑定码格式无效，应为 ZJ-XXXX-XXXX。', 400);
    }
    if (!this.store.isAvailable()) {
      throw new ProjectBindingError('PROJECT_BINDING_UNAVAILABLE', 'Director Firestore 当前不可用。', 503);
    }

    const record = await this.store.getBinding(normalizeBindingCode(bindingCodeInput));
    if (!record || record.status !== PROJECT_BINDING_STATUS_ACTIVE) return null;
    if (record.expiresAt && record.expiresAt <= this.now()) return null;
    return record.projectId || null;
  }
}

export const projectBindingService = new ProjectBindingService();

export function createBinding(projectId: string): Promise<string> {
  return projectBindingService.createBinding(projectId);
}

export function resolveBinding(bindingCode: string): Promise<string | null> {
  return projectBindingService.resolveBinding(bindingCode);
}
