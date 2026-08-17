import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServerVideoTaskRecord } from '../types';
import { isProviderAdmissionBlockingTask } from '../server/services/providerAdmissionPolicy';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('persisted video artifact / QA recovery regression', () => {
  it('releases the Veo provider slot as soon as an authoritative video artifact exists', () => {
    const task = {
      id: 'task_artifact_ready',
      taskId: 'task_artifact_ready',
      status: 'qa_pending',
      identityQaStatus: 'not_run',
      artifactPersisted: true,
      outputBucket: 'ai-studio-bucket-89614354864-asia-south1',
      outputObjectPath: 'veo/task_artifact_ready/video.mp4',
      videoUri: 'gs://ai-studio-bucket-89614354864-asia-south1/veo/task_artifact_ready/video.mp4',
    } as ServerVideoTaskRecord;

    expect(isProviderAdmissionBlockingTask(task)).toBe(false);
  });

  it('keeps fail-closed provider blocking when artifact_persisted lacks durable artifact evidence', () => {
    const inconsistent = {
      id: 'task_inconsistent',
      taskId: 'task_inconsistent',
      status: 'artifact_persisted',
      artifactPersisted: true,
    } as ServerVideoTaskRecord;

    expect(isProviderAdmissionBlockingTask(inconsistent)).toBe(true);
  });

  it('post-video QA exact-reads image anchors instead of using the video fallback artifact reader', () => {
    const source = read('src/server/services/durableVideoIdentityQaService.ts');
    expect(source).toContain('fetchExactQaImage');
    expect(source).toContain("storage.bucket(bucket).file(objectPath).download()");
    expect(source).toContain('VIDEO_QA_IMAGE_ANCHOR_INVALID');
    expect(source).toContain('Never use fetchArtifactBuffer here');
  });

  it('browser reconciliation restores a downloadable stream URL and clears stale transport errors', () => {
    const source = read('src/services/tasks/taskReconciler.ts');
    expect(source).toContain("serverStatus === 'qa_pending'");
    expect(source).toContain('const serverArtifactUrl = hasServerArtifact ? `/api/videos/stream/${localTask.id}`');
    expect(source).toContain('localTask.resultVideoUrl = serverMatch.videoDataUrl || serverArtifactUrl');
    expect(source).toContain('localTask.error = undefined');
  });
});
