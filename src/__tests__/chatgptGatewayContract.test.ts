import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const gateway = fs.readFileSync('chatgpt-gateway.ts', 'utf8');
const schema = fs.readFileSync('chatgpt-action-openapi.yaml', 'utf8');
const wrapper = fs.readFileSync('mvp-server-v021.ts', 'utf8');

describe('ChatGPT Actions gateway contract', () => {
  it('requires a hashed, revocable Bearer key for every v1 action', () => {
    expect(gateway).toContain("app.use('/v1', authenticateApiKey)");
    expect(gateway).toContain("token.startsWith('zjg_')");
    expect(gateway).toContain("collection(KEY_COLLECTION).doc(sha256(token))");
    expect(gateway).toContain('revokedAt');
  });

  it('accepts only short-lived OpenAI-hosted conversation image references', () => {
    expect(gateway).toContain('openaiFileIdRefs');
    expect(gateway).toContain("host.endsWith('.oaiusercontent.com')");
    expect(gateway).toContain("host.endsWith('.openai.com')");
    expect(gateway).toContain('MAX_IMAGE_BYTES = 20 * 1024 * 1024');
    expect(gateway).toContain("['image/jpeg', 'image/png', 'image/webp']");
  });

  it('reuses the existing Identity Safe start/status/recover pipeline instead of bypassing it', () => {
    expect(gateway).toContain("upstream('/api/mvp/videos/start'");
    expect(gateway).toContain('identitySafeMode');
    expect(gateway).toContain('/api/mvp/videos/${encodeURIComponent(req.params.taskId)}');
    expect(gateway).toContain("/recover`, { method: 'POST' }");
  });

  it('uses service-account JWT authentication for the IAP-protected upstream', () => {
    expect(gateway).toContain('iamcredentials.googleapis.com');
    expect(gateway).toContain("aud: UPSTREAM_URL + '/*'");
    expect(gateway).toContain('IAP_SIGN_JWT_FAILED');
  });

  it('marks Veo creation consequential and recovery non-consequential', () => {
    expect(schema).toContain('operationId: createIdentitySafeVideo');
    expect(schema).toContain('x-openai-isConsequential: true');
    expect(schema).toContain('operationId: recoverIdentitySafeVideoArtifact');
    expect(schema).toContain('x-openai-isConsequential: false');
    expect(schema).toContain('openaiFileIdRefs');
  });

  it('exposes one-time key creation only from the existing IAP-protected MVP app', () => {
    expect(wrapper).toContain("app.post('/api/mvp/chatgpt/keys'");
    expect(wrapper).toContain('crypto.randomBytes(32)');
    expect(wrapper).toContain('CHATGPT_KEY_COLLECTION');
    expect(wrapper).toContain('keyHash');
  });
});
