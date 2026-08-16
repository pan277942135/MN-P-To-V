import { beforeEach, describe, expect, it } from 'vitest';
import { gcsArtifactStore, EXPECTED_PRODUCTION_VEO_BUCKET } from '../server/storage/gcsArtifactStore';
import { canTransition } from '../server/services/taskStateMachineService';

const validMp4 = () => {
  const buffer = Buffer.alloc(2048);
  buffer.write('ftyp', 4, 'ascii');
  return buffer;
};

describe('GCS evidence recovery for submission_outcome_unknown', () => {
  beforeEach(() => {
    process.env.VEO_OUTPUT_BUCKET = EXPECTED_PRODUCTION_VEO_BUCKET;
    gcsArtifactStore.setMockMode(true);
    gcsArtifactStore.resetMockStore();
  });

  it('allows only the evidence-backed unknown -> generation_succeeded transition', () => {
    expect(canTransition('submission_outcome_unknown' as any, 'generation_succeeded' as any)).toBe(true);
  });

  it('finds one valid provider MP4 under the exact task prefix', async () => {
    await gcsArtifactStore.uploadVideoArtifact({
      taskId: 'task_a/provider-output-1',
      videoBuffer: validMp4(),
    });
    await gcsArtifactStore.uploadImageArtifact({
      objectPath: 'veo/task_a/qa/master-0',
      buffer: Buffer.alloc(1200, 1),
      contentType: 'image/jpeg',
    });

    const result = await gcsArtifactStore.discoverTaskPrefixVideo({ taskKey: 'task_a' });
    expect(result.status).toBe('found');
    expect(result.artifact?.outputObjectPath).toContain('veo/task_a/provider-output-1/video.mp4');
    expect(result.videoBuffer?.length).toBe(2048);
  });

  it('prefers canonical video.mp4 after a crash even when provider files also remain', async () => {
    await gcsArtifactStore.uploadVideoArtifact({ taskId: 'task_b/provider-output-1', videoBuffer: validMp4() });
    await gcsArtifactStore.uploadVideoArtifact({ taskId: 'task_b', videoBuffer: validMp4() });

    const result = await gcsArtifactStore.discoverTaskPrefixVideo({ taskKey: 'task_b' });
    expect(result.status).toBe('found');
    expect(result.artifact?.outputObjectPath).toBe('veo/task_b/video.mp4');
  });

  it('fails closed when multiple non-canonical valid videos exist', async () => {
    await gcsArtifactStore.uploadVideoArtifact({ taskId: 'task_c/provider-output-1', videoBuffer: validMp4() });
    await gcsArtifactStore.uploadVideoArtifact({ taskId: 'task_c/provider-output-2', videoBuffer: validMp4() });

    const result = await gcsArtifactStore.discoverTaskPrefixVideo({ taskKey: 'task_c' });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
  });

  it('scopes automatic retry recovery to the current provider attempt prefix', async () => {
    await gcsArtifactStore.uploadVideoArtifact({ taskId: 'task_d/provider-output-old', videoBuffer: validMp4() });
    await gcsArtifactStore.uploadVideoArtifact({ taskId: 'task_d/attempts/2/provider-output-new', videoBuffer: validMp4() });

    const result = await gcsArtifactStore.discoverTaskPrefixVideo({ taskKey: 'task_d/attempts/2' });
    expect(result.status).toBe('found');
    expect(result.artifact?.outputObjectPath).toContain('veo/task_d/attempts/2/');
    expect(result.artifact?.outputObjectPath).not.toContain('provider-output-old');
  });

  it('returns not_found without manufacturing provider evidence', async () => {
    const result = await gcsArtifactStore.discoverTaskPrefixVideo({ taskKey: 'task_empty' });
    expect(result.status).toBe('not_found');
    expect(result.artifact).toBeUndefined();
  });
});
