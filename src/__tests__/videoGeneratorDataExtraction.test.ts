import { describe, it, expect } from 'vitest';
import { VideoGenerator } from '../services/video/videoGenerator';

describe('VideoGenerator.extractVideoData', () => {
  it('extracts base64 from Vertex AI predictions array', () => {
    const resp = {
      predictions: [
        {
          bytesBase64Encoded: 'AAAA_FAKEE_BASE64_VIDEO_BYTES_AAAA',
          mimeType: 'video/mp4',
        },
      ],
    };

    const extracted = VideoGenerator.extractVideoData(resp);
    expect(extracted.base64).toBe('AAAA_FAKEE_BASE64_VIDEO_BYTES_AAAA');
  });

  it('extracts gcsUri from Vertex AI predictions array', () => {
    const resp = {
      predictions: [
        {
          gcsUri: 'gs://vertex-bucket/output_video.mp4',
          mimeType: 'video/mp4',
        },
      ],
    };

    const extracted = VideoGenerator.extractVideoData(resp);
    expect(extracted.uri).toBe('gs://vertex-bucket/output_video.mp4');
  });

  it('extracts uri from nested video object in predictions', () => {
    const resp = {
      predictions: [
        {
          video: {
            uri: 'gs://vertex-bucket/nested_video.mp4',
          },
        },
      ],
    };

    const extracted = VideoGenerator.extractVideoData(resp);
    expect(extracted.uri).toBe('gs://vertex-bucket/nested_video.mp4');
  });

  it('extracts base64 from Gemini API generatedVideos array', () => {
    const resp = {
      generatedVideos: [
        {
          video: {
            bytesBase64Encoded: 'GEMINI_BASE64_BYTES',
          },
        },
      ],
    };

    const extracted = VideoGenerator.extractVideoData(resp);
    expect(extracted.base64).toBe('GEMINI_BASE64_BYTES');
  });
});
