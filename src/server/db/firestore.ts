import { Firestore } from '@google-cloud/firestore';
import fs from 'fs';
import path from 'path';

let firestoreInstance: Firestore | null = null;
let isInitialized = false;
let firestoreApiDisabled = false;

function getConfigFromAppletFile(): { projectId?: string; databaseId?: string } {
  try {
    const cfgPath = path.join(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      const cfg = JSON.parse(raw);
      return {
        projectId: cfg.projectId || undefined,
        databaseId: cfg.firestoreDatabaseId || undefined,
      };
    }
  } catch (err) {
    console.warn('[Firestore DB] Failed to read firebase-applet-config.json:', err);
  }
  return {};
}

export function getFirestoreInstance(): Firestore | null {
  if (firestoreApiDisabled) {
    return null;
  }
  if (isInitialized) {
    return firestoreInstance;
  }

  try {
    const { projectId, databaseId } = getFirestoreRuntimeConfig();

    if (process.env.NODE_ENV === 'test' && !process.env.FIRESTORE_EMULATOR_HOST && !process.env.TEST_FIRESTORE_ENABLED) {
      // In unit test environment unless explicitly enabled, keep firestoreInstance null unless mock is set
      isInitialized = true;
      return firestoreInstance;
    }

    firestoreInstance = new Firestore({
      projectId: projectId || undefined,
      databaseId,
    });
    isInitialized = true;
    console.log(`[Firestore DB] Initialized server-side Firestore instance (project=${projectId || 'default'}, database=${databaseId}).`);
  } catch (err) {
    console.warn('[Firestore DB] Failed to initialize Firestore SDK:', err);
    firestoreInstance = null;
    firestoreApiDisabled = true;
    isInitialized = true;
  }

  return firestoreInstance;
}

export function getFirestoreRuntimeConfig(): { projectId: string; databaseId: string } {
  const fileCfg = getConfigFromAppletFile();
  return {
    projectId: process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || fileCfg.projectId || '',
    databaseId: process.env.FIRESTORE_DATABASE_ID || fileCfg.databaseId || '(default)',
  };
}

function isFirestoreAvailabilityError(error: any): boolean {
  if (!error) return true;

  const code = error.code;
  const numericCode = Number(code);
  const status = Number(error.status || error.statusCode);
  const message = String(error.message || error);

  return (
    numericCode === 7 || code === 'PERMISSION_DENIED' || status === 403 ||
    numericCode === 16 || code === 'UNAUTHENTICATED' || status === 401 ||
    numericCode === 8 || code === 'RESOURCE_EXHAUSTED' || status === 429 ||
    numericCode === 14 || code === 'UNAVAILABLE' ||
    message.includes('PERMISSION_DENIED') ||
    message.includes('UNAUTHENTICATED') ||
    message.includes('RESOURCE_EXHAUSTED') ||
    message.includes('UNAVAILABLE') ||
    message.includes('Could not load the default credentials') ||
    message.includes('has not been used in project') ||
    message.includes('API disabled') ||
    message.includes('is not enabled') ||
    message.includes('DATABASE_NOT_FOUND') ||
    (message.includes('NOT_FOUND') && message.toLowerCase().includes('database'))
  );
}

export function markFirestoreUnavailable(err?: any): void {
  if (err && !isFirestoreAvailabilityError(err)) {
    // Invalid document IDs, schema errors, and other request-level failures
    // must not poison the shared client for every later request in the same
    // Cloud Run instance.
    console.warn('[Firestore DB] Keeping Firestore available after non-infrastructure error:', err?.message || err);
    return;
  }
  if (err) {
    console.warn('[Firestore DB] Marking Firestore unavailable due to runtime error:', err?.message || err);
  }
  firestoreApiDisabled = true;
}

export function setFirestoreInstanceForTesting(instance: Firestore | null): void {
  firestoreInstance = instance;
  isInitialized = true;
  firestoreApiDisabled = false;
}

export function isFirestoreAvailable(): boolean {
  if (firestoreApiDisabled) {
    return false;
  }
  const db = getFirestoreInstance();
  return db !== null && !firestoreApiDisabled;
}

export function getStorageAuthority(): 'firestore' | 'server_memory' | 'unavailable' {
  if (isFirestoreAvailable()) {
    return 'firestore';
  }
  return 'unavailable';
}
