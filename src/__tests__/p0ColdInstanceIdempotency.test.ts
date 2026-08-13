import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GeminiClientFactory } from '../services/google/geminiClient';
import type { ActiveSession } from '../services/google/credentialService';

describe('P0-5 cold-instance ADC + early durable idempotency regressions', () => {
  it('resolves a promise-backed ADC auth client before requesting an access token', async () => {
    const getAccessToken = vi.fn().mockResolvedValue({ token: 'mock-adc-token' });
    const session: ActiveSession = {
      connectionId: 'runtime_adc_cold_test',
      type: 'vertex_ai',
      credentialSource: 'ADC',
      serviceAccountJwt: Promise.resolve({ getAccessToken }),
      projectId: 'xp-vertex-project',
      location: 'us-central1',
      region: 'us-central1',
      requestedModel: 'veo-3.1-fast-generate-001',
      actualModel: 'veo-3.1-fast-generate-001',
      analysisModel: 'gemini-2.5-flash',
      imageModel: 'gemini-2.5-flash',
      videoModel: 'veo-3.1-fast-generate-001',
      serviceAccountEmail: 'runtime@example.invalid',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    const client = await GeminiClientFactory.getClientForSession(session);
    expect(client).toBeTruthy();
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('checks durable requested task reuse before Gemini/ADC client construction', () => {
    const serverPath = path.resolve(process.cwd(), 'server.ts');
    const source = fs.readFileSync(serverPath, 'utf8');
    const routeStart = source.indexOf("app.post('/api/videos/start'");
    const routeEnd = source.indexOf("app.get('/api/videos/status/:taskId'", routeStart);
    const route = source.slice(routeStart, routeEnd);

    const durableGate = route.indexOf('const requestedTaskId = req.body.taskId;');
    const clientCreation = route.indexOf('GeminiClientFactory.getClientForSession(session)');
    const createTask = route.indexOf('await firestoreTaskRepository.createTask(taskRecord);');

    expect(durableGate).toBeGreaterThanOrEqual(0);
    expect(clientCreation).toBeGreaterThanOrEqual(0);
    expect(createTask).toBeGreaterThanOrEqual(0);
    expect(durableGate).toBeLessThan(clientCreation);
    expect(clientCreation).toBeLessThan(createTask);
    expect(route.match(/const requestedTaskId = req\.body\.taskId;/g)?.length).toBe(1);
  });
});
