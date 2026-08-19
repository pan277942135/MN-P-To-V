import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const wrapper = fs.readFileSync('mvp-server-v021.ts', 'utf8');
const gateway = fs.readFileSync('src/mvp/chatgptGateway.ts', 'utf8');
const schema = fs.readFileSync('openapi/chatgpt-gateway.yaml', 'utf8');

describe('ChatGPT gateway contract', () => {
  it('requires bearer authentication before the ChatGPT namespace', () => {
    expect(wrapper).toContain("app.use('/api/chatgpt', requireChatgptGatewayAuth)");
    expect(gateway).toContain('crypto.timingSafeEqual');
    expect(gateway).toContain('CHATGPT_GATEWAY_API_KEY');
  });

  it('requires idempotency before any ChatGPT video creation can reach the MVP start route', () => {
    expect(wrapper).toContain("app.post('/api/chatgpt/videos', requireIdempotencyKey");
    expect(wrapper).toContain("req.url = '/api/mvp/videos/start'");
    expect(gateway).toContain('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('reuses the existing MVP state machine instead of adding a direct Veo call', () => {
    expect(wrapper).not.toContain('predictLongRunning');
    expect(wrapper).not.toContain('submitVeoOnce');
    expect(wrapper).toContain("req.url = `/api/mvp/videos/${encodeURIComponent(req.params.taskId)}`");
    expect(wrapper).toContain("req.url = `/api/mvp/videos/${encodeURIComponent(req.params.taskId)}/recover`");
  });

  it('returns a result only after the artifact is both persisted and verified', () => {
    expect(wrapper).toContain("task.status !== 'COMPLETED' || !task.artifactPersisted || !task.artifactVerified");
    expect(wrapper).toContain('resultReady: false');
    expect(wrapper).toContain('resultReady: true');
  });

  it('publishes an OpenAPI action contract with bearer auth and explicit idempotency', () => {
    expect(schema).toContain('openapi: 3.1.0');
    expect(schema).toContain('bearerAuth');
    expect(schema).toContain('Idempotency-Key');
    expect(schema).toContain('operationId: createIdentitySafeVideo');
    expect(schema).toContain('operationId: recoverIdentitySafeVideoArtifact');
  });
});
