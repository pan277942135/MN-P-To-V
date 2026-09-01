import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createFirestoreDiagnosticRouter } from '../server/services/firestoreDiagnosticRouter';

function app(dependencies: any) {
  const server = express();
  server.use('/api/debug/firestore', createFirestoreDiagnosticRouter(dependencies));
  return server;
}

describe('Firestore diagnostic router', () => {
  it('is disabled unless explicitly enabled by the UAT environment', async () => {
    const response = await request(app({ env: {} })).get('/api/debug/firestore');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('FIRESTORE_DIAGNOSTIC_DISABLED');
  });

  it('reports the safe runtime identity and Firestore collections', async () => {
    const response = await request(app({
      env: {
        FIRESTORE_DIAGNOSTIC_ENABLED: '1',
        RUNTIME_SERVICE_ACCOUNT_EMAIL: 'runtime@example.iam.gserviceaccount.com',
      },
      getConfig: () => ({ projectId: 'xp-vertex-project', databaseId: 'director-db' }),
      getDatabase: () => ({
        listCollections: async () => [{ id: 'director_assets' }, { id: 'director_projects' }],
        collection: () => ({ limit: () => ({ get: async () => ({ empty: true }) }) }),
      }),
    })).get('/api/debug/firestore');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      runtimeProjectId: 'xp-vertex-project',
      firestoreDatabaseId: 'director-db',
      serviceAccount: 'runtime@example.iam.gserviceaccount.com',
      firestoreReachable: true,
      collections: ['director_assets', 'director_projects'],
    });
    expect(JSON.stringify(response.body)).not.toContain('token');
    expect(JSON.stringify(response.body)).not.toContain('credential');
  });

  it('returns a diagnostic error without exposing credentials', async () => {
    const response = await request(app({
      env: { FIRESTORE_DIAGNOSTIC_ENABLED: '1' },
      getConfig: () => ({ projectId: 'xp-vertex-project', databaseId: 'director-db' }),
      getDatabase: () => ({
        listCollections: async () => { throw Object.assign(new Error('7 PERMISSION_DENIED'), { code: 7 }); },
        collection: () => ({ limit: () => ({ get: async () => ({}) }) }),
      }),
    })).get('/api/debug/firestore');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      error: 'FIRESTORE_UNREACHABLE',
      errorCode: '7',
      runtimeProjectId: 'xp-vertex-project',
      firestoreReachable: false,
    });
    expect(JSON.stringify(response.body)).not.toContain('access_token');
  });
});
