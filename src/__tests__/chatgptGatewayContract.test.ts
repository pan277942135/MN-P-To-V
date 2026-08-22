import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const gateway = fs.readFileSync('chatgpt-gateway.ts', 'utf8');
const schema = fs.readFileSync('chatgpt-action-openapi.yaml', 'utf8');
const wrapper = fs.readFileSync('mvp-server-v021.ts', 'utf8');
const resolver = fs.readFileSync('src/server/services/chatgptCharacterInputResolver.ts', 'utf8');
const characterRouter = fs.readFileSync('chatgpt-character-router.ts', 'utf8');
const deploy = fs.readFileSync('.github/workflows/chatgpt-gateway-uat-deploy.yml', 'utf8');

describe('ChatGPT Actions gateway contract', () => {
  it('keeps hashed Bearer auth as the default while allowing an explicit bounded UAT direct override', () => {
    expect(gateway).toContain("if (!UAT_DIRECT_MODE) app.use('/v1', authenticateApiKey)");
    expect(gateway).toContain("token.startsWith('zjg_')");
    expect(gateway).toContain("collection(KEY_COLLECTION).doc(sha256(token))");
    expect(gateway).toContain('revokedAt');
    expect(gateway).toContain('ZAOJING_CHATGPT_UAT_DIRECT');
    expect(deploy).toContain('ZAOJING_CHATGPT_UAT_DIRECT=true');
  });

  it('bounds direct UAT creation with a Firestore-backed daily new-intent quota', () => {
    expect(gateway).toContain('UAT_DIRECT_DAILY_LIMIT');
    expect(gateway).toContain("UAT_ADMISSION_COLLECTION = 'mvp_chatgpt_uat_admissions'");
    expect(gateway).toContain("UAT_QUOTA_COLLECTION = 'mvp_chatgpt_uat_daily_quota'");
    expect(gateway).toContain('admitUatDirectIntent');
    expect(gateway).toContain("requestRejected('uat_direct_daily_limit_reached'");
    expect(deploy).toContain("UAT_DIRECT_DAILY_LIMIT: '12'");
  });

  it('accepts only short-lived OpenAI-hosted conversation image download URLs', () => {
    expect(gateway).toContain('openaiFileIdRefs');
    expect(gateway).toContain("host.endsWith('.oaiusercontent.com')");
    expect(gateway).toContain("host.endsWith('.openai.com')");
    expect(gateway).toContain('MAX_IMAGE_BYTES = 20 * 1024 * 1024');
    expect(gateway).toContain("SUPPORTED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp']");
  });

  it('diagnoses the observed GPT Actions plain file-id payload without pretending it has a download URL', () => {
    expect(gateway).toContain('type OpenAIFileRef = string | OpenAIFileRefObject');
    expect(gateway).toContain("referenceKind: 'string_file_id'");
    expect(gateway).toContain('fileIdPresent: ref.trim().length > 0');
    expect(gateway).toContain('downloadLinkPresent: false');
    expect(gateway).toContain("throw new OpenAIFileBridgeError('OPENAI_FILE_URL_INVALID'");
  });

  it('validates downloaded image bytes by magic signature instead of trusting declared MIME', () => {
    expect(gateway).toContain('function detectImageMime(bytes: Buffer)');
    expect(gateway).toContain("bytes[0] === 0xff && bytes[1] === 0xd8");
    expect(gateway).toContain("bytes[0] === 0x89 && bytes[1] === 0x50");
    expect(gateway).toContain("bytes.subarray(0, 4).toString('ascii') === 'RIFF'");
    expect(gateway).toContain("throw new OpenAIFileBridgeError('OPENAI_FILE_CONTENT_INVALID'");
    expect(gateway).toContain('contentSha256');
    expect(gateway).toContain('prefixHex');
  });

  it('exposes a non-billable file-bridge preflight action that never calls the upstream video start route', () => {
    expect(gateway).toContain("app.post('/v1/images/preflight'");
    expect(schema).toContain('operationId: preflightIdentityImage');
    expect(schema).toContain('x-openai-isConsequential: false');
    const preflightStart = gateway.indexOf("app.post('/v1/images/preflight'");
    const videoStart = gateway.indexOf("app.post('/v1/videos'");
    expect(preflightStart).toBeGreaterThanOrEqual(0);
    expect(videoStart).toBeGreaterThan(preflightStart);
    const preflightBlock = gateway.slice(preflightStart, videoStart);
    expect(preflightBlock).not.toContain("upstream('/api/mvp/videos/start'");
    expect(preflightBlock).toContain('downloadOpenAIImage');
    expect(preflightBlock).toContain("status: 'PREFLIGHT_OK'");
    expect(preflightBlock).toContain('providerCalled: false');
  });

  it('returns handled preflight and file-bridge failures as HTTP 200 action-safe envelopes', () => {
    expect(gateway).toContain("status: 'FILE_BRIDGE_FAILED'");
    expect(gateway).toContain('taskCreated: false');
    expect(gateway).toContain('providerCalled: false');
    expect(gateway).toContain("stage: 'action_file_bridge'");
    const preflightStart = gateway.indexOf("app.post('/v1/images/preflight'");
    const videoStart = gateway.indexOf("app.post('/v1/videos'");
    const preflightBlock = gateway.slice(preflightStart, videoStart);
    expect(preflightBlock).toContain('return res.status(200).json');
    expect(schema).toContain('Handled file-bridge failures return HTTP 200');
  });

  it('normalizes forwarded image MIME and filename from detected bytes', () => {
    expect(gateway).toContain('normalizedImageName');
    expect(gateway).toContain('mimeType: detectedMime');
    expect(gateway).toContain("new Blob([image.bytes], { type: image.mimeType })");
    expect(gateway).toContain('inputFile: image.diagnostics');
  });

  it('supports durable character_reference input without routing the master through the ChatGPT file bridge', () => {
    expect(schema).toContain('enum: [character_reference, conversation_file]');
    expect(schema).toContain('characterId:');
    expect(schema).toContain('referenceId:');
    expect(gateway).toContain('resolveCharacterReferenceInput');
    expect(gateway).toContain("sourceType === 'character_reference'");
    expect(gateway).toContain("form.append('characterId', image.source.characterId)");
    expect(gateway).toContain("form.append('characterReferenceId', image.source.referenceId)");
    expect(resolver).toContain("CHARACTER_COLLECTION = 'characters'");
    expect(resolver).toContain("artifactAuthority: 'gcs'");
    expect(resolver).toContain('identitySpecSha256');
  });

  it('uses actual character master bytes as MIME authority and reports stale catalog metadata instead of rejecting the master', () => {
    expect(resolver).toContain('detectSupportedImageMime');
    expect(resolver).toContain('metadataMimeMismatch');
    expect(resolver).toContain("mimeAuthority: 'magic_bytes'");
    expect(resolver).not.toContain('CHARACTER_REFERENCE_MIME_MISMATCH');
    expect(characterRouter).toContain('resolveCharacterReferenceInput(characterId, referenceId)');
    expect(characterRouter).toContain("res.setHeader('Content-Type', resolved.mimeType)");
    expect(characterRouter).toContain("res.setHeader('X-Zaojing-Mime-Authority', 'magic-bytes')");
  });

  it('persists durable source provenance and rejects idempotency reuse with a different source', () => {
    expect(gateway).toContain("INPUT_BINDING_COLLECTION = 'mvp_chatgpt_input_bindings'");
    expect(gateway).toContain("TASK_INPUT_BINDING_COLLECTION = 'mvp_chatgpt_task_input_bindings'");
    expect(gateway).toContain('inputSourceFingerprint');
    expect(gateway).toContain('IDEMPOTENCY_INPUT_MISMATCH');
    expect(gateway).toContain('getTaskInputBinding');
  });

  it('adds the durable character identity lock server-side before the existing provider pipeline', () => {
    expect(gateway).toContain('[ZAOJING_DURABLE_CHARACTER_IDENTITY]');
    expect(gateway).toContain('characterIdentityPrompt(prompt, image)');
    expect(resolver).toContain('identityLockPromptEnglish');
    expect(resolver).toContain('identityLockPromptChinese');
  });

  it('requires a stable idempotency key in direct UAT mode and recovers durable tasks before resubmission', () => {
    expect(gateway).toContain("requestRejected('idempotency_key_required_in_uat_direct_mode')");
    expect(gateway).toContain("upstream('/api/mvp/videos/lookup'");
    expect(gateway).toContain("recoveredBy: 'idempotency_lookup_before_submit'");
    expect(gateway).toContain("recoveredBy: 'idempotency_lookup_after_transport_failure'");
    expect(schema).toContain('required: [prompt, durationSeconds, idempotencyKey]');
  });

  it('exposes a non-billable intent resolver for create client-response loss and never submits Veo', () => {
    expect(gateway).toContain("app.post('/v1/videos/resolve'");
    expect(gateway).toContain("status: 'INTENT_NOT_FOUND'");
    expect(gateway).toContain("status: 'RESOLVE_FAILED'");
    expect(gateway).toContain("stage: 'action_intent_resolve'");
    const resolveStart = gateway.indexOf("app.post('/v1/videos/resolve'");
    const videoStart = gateway.indexOf("app.post('/v1/videos'");
    expect(resolveStart).toBeGreaterThanOrEqual(0);
    expect(videoStart).toBeGreaterThan(resolveStart);
    const resolveBlock = gateway.slice(resolveStart, videoStart);
    expect(resolveBlock).toContain('lookupUpstreamTask');
    expect(resolveBlock).not.toContain("upstream('/api/mvp/videos/start'");
    expect(schema).toContain('operationId: resolveIdentitySafeVideoIntent');
    expect(schema).toContain('Call this immediately after any create client or transport error before retrying create.');
    expect(schema).toContain('It only queries the durable idempotency index and never calls Veo.');
  });

  it('makes create return an observable action-safe result even when the private upstream transport fails', () => {
    const videoStart = gateway.indexOf("app.post('/v1/videos'");
    const getStart = gateway.indexOf("app.get('/v1/videos/:taskId'");
    const createBlock = gateway.slice(videoStart, getStart);
    expect(createBlock).toContain('return res.status(200).json');
    expect(createBlock).toContain("status: 'UPSTREAM_OUTCOME_UNKNOWN'");
    expect(createBlock).toContain('UPSTREAM_REQUEST_AND_LOOKUP_FAILED');
    expect(createBlock).toContain('UPSTREAM_REQUEST_FAILED_NO_TASK_FOUND');
    expect(createBlock).toContain('Call resolveIdentitySafeVideoIntent with the same idempotencyKey before any create retry.');
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

  it('makes public gateway health prove authenticated upstream reachability and UAT direct mode', () => {
    expect(gateway).toContain("await upstream('/api/mvp/health')");
    expect(gateway).toContain('upstreamReachable');
    expect(gateway).toContain('uatDirectMode');
    expect(deploy).toContain("grep -q '\"upstreamReachable\":true' health.json");
    expect(deploy).toContain("grep -q '\"uatDirectMode\":true' health.json");
  });

  it('marks Veo creation consequential and recovery/resolve non-consequential', () => {
    expect(schema).toContain('operationId: createIdentitySafeVideo');
    expect(schema).toContain('x-openai-isConsequential: true');
    expect(schema).toContain('operationId: resolveIdentitySafeVideoIntent');
    expect(schema).toContain('operationId: recoverIdentitySafeVideoArtifact');
    const resolveStart = schema.indexOf('operationId: resolveIdentitySafeVideoIntent');
    const createStart = schema.indexOf('operationId: createIdentitySafeVideo');
    expect(schema.slice(resolveStart, createStart)).toContain('x-openai-isConsequential: false');
    expect(schema).toContain('x-openai-isConsequential: false');
    expect(schema).toContain('openaiFileIdRefs');
  });

  it('exposes verified video delivery URLs and a non-creating MP4 stream path', () => {
    expect(gateway).toContain('videoUrl');
    expect(gateway).toContain('downloadUrl');
    expect(gateway).toContain('artifactPersisted');
    expect(gateway).toContain('artifactVerified');
    expect(gateway).toContain("app.get('/v1/videos/:taskId/stream'");
    expect(gateway).toContain('req.headers.range');
    expect(gateway).toContain('download=1');
    expect(schema).toContain('version: 1.3.0');
    expect(schema).toContain('/v1/videos/{taskId}/stream:');
    expect(schema).toContain('operationId: streamIdentitySafeVideo');
  });

  it('stays within ChatGPT Actions editor schema validation constraints', () => {
    expect(schema).toContain('components:\n  schemas: {}');
    for (const match of schema.matchAll(/^\s+description:\s+(.+)$/gm)) {
      expect(match[1].length).toBeLessThanOrEqual(300);
    }
  });

  it('exposes one-time key creation only from the existing IAP-protected MVP app', () => {
    expect(wrapper).toContain("app.post('/api/mvp/chatgpt/keys'");
    expect(wrapper).toContain('crypto.randomBytes(32)');
    expect(wrapper).toContain('CHATGPT_KEY_COLLECTION');
    expect(wrapper).toContain('keyHash');
  });

  it('supports a hash-only bootstrap key without storing plaintext credentials in source', () => {
    expect(gateway).toContain('ZAOJING_CHATGPT_BOOTSTRAP_KEY_HASH');
    expect(gateway).toContain("purpose: 'chatgpt-actions-v1-bootstrap'");
    expect(gateway).toContain('await ensureBootstrapApiKey()');
    expect(deploy).toContain('BOOTSTRAP_KEY_HASH:');
    expect(deploy).toContain('ZAOJING_CHATGPT_BOOTSTRAP_KEY_HASH=$BOOTSTRAP_KEY_HASH');
    expect(deploy).not.toMatch(/zjg_[A-Za-z0-9_-]{20,}/);
  });

  it('records exact gateway UAT evidence and verifies the bounded direct action boundary', () => {
    expect(deploy).toContain('issues: write');
    expect(deploy).toContain('ChatGPT Gateway UAT deployment evidence');
    expect(deploy).toContain('HEALTH_STATUS=');
    expect(deploy).toContain('OPENAPI_STATUS=');
    expect(deploy).toContain('DIRECT_STATUS=');
    expect(deploy).toContain("test \"$DIRECT_STATUS\" = '200'");
    expect(deploy).toContain('uatDirectMode');
  });
});