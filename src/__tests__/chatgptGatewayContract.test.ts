import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const gateway = fs.readFileSync('chatgpt-gateway.ts', 'utf8');
const schema = fs.readFileSync('chatgpt-action-openapi.yaml', 'utf8');
const wrapper = fs.readFileSync('mvp-server-v021.ts', 'utf8');
const deploy = fs.readFileSync('.github/workflows/chatgpt-gateway-uat-deploy.yml', 'utf8');

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

  it('keeps the signed-JWT IAP authentication path available as a fallback', () => {
    expect(gateway).toContain('iamcredentials.googleapis.com');
    expect(gateway).toContain("aud: UPSTREAM_URL + '/*'");
    expect(gateway).toContain('IAP_SIGN_JWT_FAILED');
  });

  it('uses a dedicated private Cloud Run IAM upstream for UAT without project IAM mutation', () => {
    expect(gateway).toContain('ZAOJING_UPSTREAM_AUTH_MODE');
    expect(gateway).toContain('metadata.google.internal');
    expect(gateway).toContain("UPSTREAM_AUTH_MODE === 'cloud-run-id-token'");
    expect(deploy).toContain('CHATGPT_UPSTREAM_SERVICE: zaojing-chatgpt-upstream-uat');
    expect(deploy).toContain('--no-allow-unauthenticated --no-iap');
    expect(deploy).toContain('--role="roles/run.invoker"');
    expect(deploy).toContain('ZAOJING_UPSTREAM_AUTH_MODE=cloud-run-id-token');
    expect(deploy).not.toContain('roles/iap.httpsResourceAccessor');
    expect(deploy).not.toContain('roles/iam.serviceAccountTokenCreator');
  });

  it('makes public gateway health prove authenticated upstream reachability', () => {
    expect(gateway).toContain("await upstream('/api/mvp/health')");
    expect(gateway).toContain('upstreamReachable');
    expect(deploy).toContain("grep -q '\"upstreamReachable\":true' health.json");
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

  it('supports a hash-only UAT bootstrap key without storing plaintext credentials in source', () => {
    expect(gateway).toContain('ZAOJING_CHATGPT_BOOTSTRAP_KEY_HASH');
    expect(gateway).toContain("purpose: 'chatgpt-actions-v1-bootstrap'");
    expect(gateway).toContain('await ensureBootstrapApiKey()');
    expect(deploy).toContain('BOOTSTRAP_KEY_HASH:');
    expect(deploy).toContain('ZAOJING_CHATGPT_BOOTSTRAP_KEY_HASH=$BOOTSTRAP_KEY_HASH');
    expect(deploy).not.toMatch(/zjg_[A-Za-z0-9_-]{20,}/);
  });

  it('records exact gateway UAT verification evidence and verifies the unauthenticated boundary', () => {
    expect(deploy).toContain('issues: write');
    expect(deploy).toContain('ChatGPT Gateway UAT deployment evidence');
    expect(deploy).toContain('HEALTH_STATUS=');
    expect(deploy).toContain('OPENAPI_STATUS=');
    expect(deploy).toContain('UNAUTH_STATUS=');
    expect(deploy).toContain("test \"$UNAUTH_STATUS\" = '401'");
    expect(deploy).toContain('bootstrapKeyConfigured');
  });
});