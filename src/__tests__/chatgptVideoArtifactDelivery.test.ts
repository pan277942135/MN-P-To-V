import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const gateway = fs.readFileSync('chatgpt-gateway.ts', 'utf8');
const artifactRouter = fs.readFileSync('chatgpt-video-artifact-router.ts', 'utf8');
const schema = fs.readFileSync('chatgpt-action-openapi.yaml', 'utf8');
const mvp = fs.readFileSync('mvp-server-v02.ts', 'utf8');
const contract = fs.readFileSync('src/mvp/mvpContract.ts', 'utf8');
const storage = fs.readFileSync('src/server/storage/gcsArtifactStore.ts', 'utf8');

describe('ChatGPT verified video artifact delivery', () => {
  it('preserves the existing canonical artifact and private stream implementation', () => {
    expect(mvp).toContain('persistCanonicalArtifact');
    expect(mvp).toContain('outputBucket: OUTPUT_BUCKET');
    expect(mvp).toContain('videoUri: `gs://${OUTPUT_BUCKET}/${objectPath}`');
    expect(mvp).toContain("app.get('/api/mvp/videos/:taskId/stream'");
    expect(mvp).toContain("task.status !== 'COMPLETED'");
    expect(mvp).toContain('assertIdentitySafeCompletion(task)');
  });

  it('keeps completion dependent on a verified persisted video location', () => {
    expect(contract).toContain('task.artifactPersisted === true');
    expect(contract).toContain('task.artifactVerified === true');
    expect(contract).toContain('task.outputBucket');
    expect(contract).toContain('task.outputObjectPath');
    expect(contract).toContain('task.videoUri');
  });

  it('uses the configured owned GCS bucket and canonical task path', () => {
    expect(storage).toContain("EXPECTED_PRODUCTION_VEO_BUCKET = 'ai-studio-bucket-89614354864-asia-south1'");
    expect(storage).toContain('process.env.VEO_OUTPUT_BUCKET');
    expect(storage).toContain('return `veo/${taskId}/${fileName}`');
  });

  it('mounts a read-only artifact resolver on the ChatGPT gateway', () => {
    expect(gateway).toContain("import { createChatGptVideoArtifactRouter } from './chatgpt-video-artifact-router'");
    expect(gateway).toContain("app.use('/v1/videos', createChatGptVideoArtifactRouter())");
    expect(artifactRouter).toContain("router.get('/:taskId/artifact'");
    expect(artifactRouter).not.toContain("router.post('/:taskId/artifact'");
  });

  it('fails closed unless the task and artifact satisfy Identity Safe completion', () => {
    expect(artifactRouter).toContain("task.status !== 'COMPLETED'");
    expect(artifactRouter).toContain('isIdentitySafeCompletionSatisfied(task)');
    expect(artifactRouter).toContain('task.artifactPersisted !== true');
    expect(artifactRouter).toContain('task.artifactVerified !== true');
    expect(artifactRouter).toContain('file.exists()');
    expect(artifactRouter).toContain('file.getMetadata()');
  });

  it('returns short-lived V4 signed playback and download URLs without exposing gs://', () => {
    expect(artifactRouter).toContain("version: 'v4' as const");
    expect(artifactRouter).toContain("action: 'read' as const");
    expect(artifactRouter).toContain('file.getSignedUrl(common)');
    expect(artifactRouter).toContain('responseDisposition');
    expect(artifactRouter).toContain('videoUrl');
    expect(artifactRouter).toContain('downloadUrl');
    expect(artifactRouter).toContain('expiresAt');
    expect(artifactRouter).not.toContain('videoUri: task.videoUri');
  });

  it('exposes getIdentitySafeVideoArtifact in the Action schema and directs completed tasks to it', () => {
    expect(schema).toContain('/v1/videos/{taskId}/artifact:');
    expect(schema).toContain('operationId: getIdentitySafeVideoArtifact');
    expect(schema).toContain('Returns short-lived signed HTTPS URLs');
    expect(schema).toContain('call getIdentitySafeVideoArtifact');
    const artifactOperation = schema.indexOf('operationId: getIdentitySafeVideoArtifact');
    const recoverOperation = schema.indexOf('operationId: recoverIdentitySafeVideoArtifact');
    expect(artifactOperation).toBeGreaterThanOrEqual(0);
    expect(recoverOperation).toBeGreaterThan(artifactOperation);
    expect(schema.slice(artifactOperation, recoverOperation)).toContain('x-openai-isConsequential: false');
  });
});
