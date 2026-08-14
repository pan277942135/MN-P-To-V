import { describe, expect, it } from 'vitest';
import { VideoGenerator } from '../services/video/videoGenerator';

const VEO_TYPE_MARKER = 'type.googleapis.com/cloud.ai.large_models.vision.GenerateVideoResponse';

describe('Veo artifact parser regression: 48-byte @type false base64', () => {
  it('reproduces the exact 48-byte Node base64 decode signature from the Google @type marker', () => {
    expect(Buffer.from(VEO_TYPE_MARKER, 'base64').length).toBe(48);
  });

  it('prefers the official Vertex Veo videos[0].gcsUri and never treats @type as video bytes', () => {
    const gcsUri = 'gs://example-bucket/veo/task_regression/sample_0.mp4';
    const response = {
      raiMediaFilteredCount: 0,
      '@type': VEO_TYPE_MARKER,
      videos: [
        {
          gcsUri,
          mimeType: 'video/mp4',
        },
      ],
    };

    expect(VideoGenerator.extractVideoData(response)).toEqual({ uri: gcsUri });
    expect(VideoGenerator.checkSafetyBlock(response).isBlocked).toBe(false);
  });

  it('does not manufacture video base64 from metadata-only strings', () => {
    const response = {
      raiMediaFilteredCount: 0,
      '@type': VEO_TYPE_MARKER,
      operationFingerprint: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };

    expect(VideoGenerator.extractVideoData(response)).toEqual({});
    expect(VideoGenerator.checkSafetyBlock(response).isBlocked).toBe(false);
  });

  it('still accepts real inline MP4 base64 from an explicit video data field', () => {
    const mp4 = Buffer.alloc(2048);
    Buffer.from('....ftypisom').copy(mp4, 0);
    const base64 = mp4.toString('base64');

    expect(VideoGenerator.extractVideoData({ data: base64 })).toEqual({ base64 });
  });

  it('still reports a genuine positive RAI signal as blocked', () => {
    const response = {
      raiMediaFilteredCount: 1,
      raiMediaFilteredReasons: ['RAI_MEDIA_FILTERED'],
      '@type': VEO_TYPE_MARKER,
    };

    const result = VideoGenerator.checkSafetyBlock(response);
    expect(result.isBlocked).toBe(true);
    expect(result.raiMediaFilteredCount).toBe(1);
  });
});
