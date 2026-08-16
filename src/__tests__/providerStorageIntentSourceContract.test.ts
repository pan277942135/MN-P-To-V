import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const server = readFileSync('server.ts', 'utf8');
const types = readFileSync('src/types/index.ts', 'utf8');
const state = readFileSync('src/server/services/taskStateMachineService.ts', 'utf8');
const retry = readFileSync('src/server/services/durableVideoRetryService.ts', 'utf8');
const generator = readFileSync('src/services/video/videoGenerator.ts', 'utf8');

describe('durable provider storage intent source contract', () => {
  it('persists initial attempt storage intent before createTask/provider launch', () => {
    expect(types).toContain('providerStorageTaskKey?: string');
    expect(types).toContain('expectedProviderStorageUri?: string');
    expect(types).toContain('providerStorageIntentPersistedAt?: number');
    const intentIndex = server.indexOf('const providerStorageTaskKey = DurableVideoRetryService.getAttemptTaskKey(taskId, 1)');
    const recordIndex = server.indexOf('const taskRecord: ServerVideoTaskRecord');
    const createIndex = server.indexOf('await firestoreTaskRepository.createTask(taskRecord)');
    const providerIndex = server.indexOf('VideoGenerator.startVideoGeneration(');
    expect(intentIndex).toBeGreaterThan(-1);
    expect(intentIndex).toBeLessThan(recordIndex);
    expect(recordIndex).toBeLessThan(createIndex);
    expect(createIndex).toBeLessThan(providerIndex);
    expect(server).toContain('providerStorageIntentPersistedAt: now');
  });

  it('binds the actual Vertex request to the already-durable expected storage URI', () => {
    expect(server).toContain('taskId,\n              expectedProviderStorageUri');
    expect(generator).toContain('expectedStorageUri?: string');
    expect(generator).toContain('storageUri: expectedStorageUri');
  });

  it('reserves retry storage intent atomically before launch and revalidates it at launch', () => {
    expect(server).toContain('retryProviderStorageTaskKey');
    expect(server).toContain('retryExpectedProviderStorageUri');
    expect(state).toContain('providerStorageTaskKey: string');
    expect(state).toContain('expectedProviderStorageUri: string');
    expect(state).toContain('providerStorageIntentPersistedAt: now');
    expect(retry).toContain('M2_4_RETRY_STORAGE_INTENT_MISMATCH');
    expect(retry).toContain('task.expectedProviderStorageUri !== derivedStorageUri');
    expect(retry).toContain('expectedStorageUri: task.expectedProviderStorageUri');
    expect(retry).toContain('prepared.expectedStorageUri !== task.expectedProviderStorageUri');
    expect(retry).toContain('prepared.expectedStorageUri\n    );');
  });

  it('fails closed on persisted/derived intent mismatch while retaining legacy derived fallback', () => {
    expect(server).toContain("failureReason: 'provider_storage_intent_mismatch'");
    expect(server).toContain('predictLongRunningCalls: 0');
    expect(server).toContain('const recoveryTaskKey = persistedStorageTaskKey || derivedRecoveryTaskKey');
    expect(server).toContain('hasAnyPersistedStorageIntent && !hasCompletePersistedStorageIntent');
    expect(server).toContain('persistedExpectedStorageUri !== derivedExpectedStorageUri');
  });
});
