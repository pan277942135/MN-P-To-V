import express from 'express';
import { getFirestoreInstance, getFirestoreRuntimeConfig } from '../db/firestore';

interface FirestoreDiagnosticCollection {
  id: string;
}

interface FirestoreDiagnosticDatabase {
  listCollections(): Promise<FirestoreDiagnosticCollection[]>;
  collection(name: string): {
    limit(count: number): {
      get(): Promise<unknown>;
    };
  };
}

export interface FirestoreDiagnosticRouterDependencies {
  getDatabase?: () => FirestoreDiagnosticDatabase | null;
  getConfig?: () => { projectId: string; databaseId: string };
  env?: NodeJS.ProcessEnv;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 240);
}

function safeCode(error: any): string {
  return error?.code === undefined || error?.code === null ? 'UNKNOWN' : String(error.code);
}

export function createFirestoreDiagnosticRouter(
  dependencies: FirestoreDiagnosticRouterDependencies = {},
) {
  const router = express.Router();
  const env = dependencies.env || process.env;
  const getDatabase = dependencies.getDatabase || (() => getFirestoreInstance() as FirestoreDiagnosticDatabase | null);
  const getConfig = dependencies.getConfig || getFirestoreRuntimeConfig;

  router.get('/', async (_req, res) => {
    // This route is intentionally disabled unless explicitly enabled by the UAT
    // deployment environment. It never returns credentials or access tokens.
    if (env.FIRESTORE_DIAGNOSTIC_ENABLED !== '1') {
      return res.status(404).json({ ok: false, error: 'FIRESTORE_DIAGNOSTIC_DISABLED' });
    }

    const config = getConfig();
    const base = {
      runtimeProjectId: config.projectId,
      firestoreDatabaseId: config.databaseId,
      serviceAccount: env.RUNTIME_SERVICE_ACCOUNT_EMAIL || '',
      firestoreReachable: false,
      collections: [] as string[],
    };
    const database = getDatabase();
    if (!database) {
      return res.status(503).json({
        ok: false,
        ...base,
        error: 'FIRESTORE_CLIENT_UNAVAILABLE',
      });
    }

    try {
      const collections = await database.listCollections();
      base.collections = collections.map((collection) => collection.id).filter(Boolean).sort();
      // A root collection listing proves ListCollectionIds; this read proves the
      // runtime can access a Director collection with the same ADC identity.
      await database.collection('director_projects').limit(1).get();
      base.firestoreReachable = true;
      return res.status(200).json({ ok: true, ...base });
    } catch (error: any) {
      return res.status(503).json({
        ok: false,
        ...base,
        error: 'FIRESTORE_UNREACHABLE',
        errorCode: safeCode(error),
        message: safeMessage(error),
      });
    }
  });

  return router;
}
