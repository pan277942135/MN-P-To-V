import crypto from 'crypto';
import { GoogleGenAI, GenerateVideosOperation } from '@google/genai';
import { CredentialService, type ActiveSession } from '../google/credentialService';
import { VertexClient } from '../google/vertexClient';
import { redactSecrets } from '../../utils/redactSecrets';
import { callWithRetry } from '../../utils/retryHelper';
import { PromptCompiler } from '../prompt/PromptCompiler';
import type { IdentitySpec, VideoGenerationDiagnostics, ImageDiagnosticInfo, FailureReason, RetryMode } from '../../types';
import { resolveVeoOutputBucket, EXPECTED_PRODUCTION_VEO_BUCKET } from '../../server/storage/gcsArtifactStore';

export interface VideoStartResult {
  engine: 'omni_flash' | 'veo_31';
  operationName?: string;
  interactionId?: string;
  videoBuffer?: Buffer; // For sync completion (Omni Flash)
  mimeType?: string;
  diagnostics?: VideoGenerationDiagnostics;
}

export function unwrapProtobufStruct(val: any): any {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;

  if (Array.isArray(val)) {
    return val.map(unwrapProtobufStruct);
  }

  if (val.fields && typeof val.fields === 'object') {
    const result: Record<string, any> = {};
    for (const [key, fieldVal] of Object.entries(val.fields)) {
      if (fieldVal && typeof fieldVal === 'object') {
        if ('stringValue' in fieldVal) {
          result[key] = (fieldVal as any).stringValue;
        } else if ('numberValue' in fieldVal) {
          result[key] = (fieldVal as any).numberValue;
        } else if ('boolValue' in fieldVal) {
          result[key] = (fieldVal as any).boolValue;
        } else if ('structValue' in fieldVal) {
          result[key] = unwrapProtobufStruct((fieldVal as any).structValue);
        } else if ('listValue' in fieldVal) {
          result[key] = unwrapProtobufStruct((fieldVal as any).listValue?.values || []);
        } else if ('nullValue' in fieldVal) {
          result[key] = null;
        } else {
          result[key] = unwrapProtobufStruct(fieldVal);
        }
      } else {
        result[key] = fieldVal;
      }
    }
    return result;
  }

  const copy: Record<string, any> = {};
  for (const [k, v] of Object.entries(val)) {
    copy[k] = unwrapProtobufStruct(v);
  }
  return copy;
}

export class VideoGenerator {
  static async startVideoGeneration(
    ai: GoogleGenAI,
    session: ActiveSession,
    modelName: string,
    firstFrameBuffer: Buffer,
    firstFrameMimeType: string,
    masterImageBuffers: Buffer[],
    masterMimeTypes: string[],
    normalizedPromptEnglish: string,
    identitySpec: IdentitySpec,
    previousInteractionId?: string,
    directionalRepairInstruction?: string,
    sceneMode?: string,
    characterDescription?: string,
    durationSeconds = 6,
    taskId?: string
  ): Promise<VideoStartResult> {
    const isOmni = typeof modelName === 'string' && modelName.includes('omni') && session.type !== 'vertex_ai';

    const charDesc = characterDescription || identitySpec.identityLockPromptEnglish || identitySpec.identityLockPromptChinese || '';
    const lockedTraitsJson = JSON.stringify(identitySpec?.lockedTraits || []);

    // Clean, positive, safe prompt structure optimized for Veo 3.1 & Vertex AI without triggering RAI safety filters
    let fullPrompt = `A high quality, realistic video based on the uploaded first frame image.
Subject action: ${normalizedPromptEnglish || 'Natural posture with subtle expression and smooth motion'}.
Maintain character identity, facial features, original composition, framing, outfit, and background environment.
Ensure steady focused gaze, natural facial motion, consistent lighting, and clean camera movement.`;

    if (charDesc && charDesc.trim()) {
      const cleanCharDesc = PromptCompiler.cleanUserMotionPrompt(charDesc.trim());
      if (cleanCharDesc && !cleanCharDesc.includes('角色呈自然动态')) {
        fullPrompt += `\nCharacter details: ${cleanCharDesc}`;
      }
    }

    if (directionalRepairInstruction) {
      fullPrompt += `\nRepair directive: Restore character consistency to the approved first frame. Fix issues: ${directionalRepairInstruction}.`;
    }

    const masterSlice = masterImageBuffers.slice(0, 3);
    const ffHash = crypto.createHash('sha256').update(firstFrameBuffer).digest('hex').slice(0, 12);

    const masterDiagList: ImageDiagnosticInfo[] = masterSlice.map((buf, i) => ({
      role: `Master Image ${i + 1} (${i === 0 ? 'Front' : i === 1 ? '45-Deg' : 'Full-Body'})`,
      hash: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12),
      sizeBytes: buf.length,
      mimeType: masterMimeTypes?.[i] || 'image/jpeg',
    }));

    const inputDiagList: ImageDiagnosticInfo[] = [
      {
        role: 'Image 1: Approved First Frame (Initial)',
        hash: ffHash,
        sizeBytes: firstFrameBuffer.length,
        mimeType: firstFrameMimeType,
      },
      ...masterDiagList.map((m, i) => ({
        role: `Image ${i + 2}: Master Image ${i + 1} (Asset Reference)`,
        hash: m.hash,
        sizeBytes: m.sizeBytes,
        mimeType: m.mimeType,
      })),
    ];

    const diagnostics: VideoGenerationDiagnostics = {
      firstFrame: {
        role: 'Approved First Frame',
        hash: ffHash,
        width: 1080,
        height: 1920,
        sizeBytes: firstFrameBuffer.length,
        mimeType: firstFrameMimeType,
      },
      masterImages: masterDiagList,
      inputImages: inputDiagList,
      fullPrompt,
      videoModel: modelName || (isOmni ? 'gemini-omni-flash-preview' : 'veo-3.1-fast-generate-001'),
      useReferenceImages: masterSlice.length > 0,
      engine: isOmni ? 'omni_flash' : 'veo_31',
      timestamp: Date.now(),
    };

    if (isOmni) {
      // Gemini Omni Flash path via Interactions API
      try {
        const inputParts: any[] = [];

        // Image 1: approvedFirstFrame
        inputParts.push({
          type: 'image',
          mime_type: firstFrameMimeType,
          data: firstFrameBuffer.toString('base64'),
        });

        // Image 2..N: masterImages
        masterSlice.forEach((buf, idx) => {
          inputParts.push({
            type: 'image',
            mime_type: masterMimeTypes?.[idx] || 'image/jpeg',
            data: buf.toString('base64'),
          });
        });

        // Explicit Binding syntax
        let bindingHeader = `[# Sources <FIRST_FRAME>@Image1]\n`;
        const refTags: string[] = [];
        masterSlice.forEach((_, idx) => {
          refTags.push(`<IMAGE_REF_${idx}>@Image${idx + 2}`);
        });
        if (refTags.length > 0) {
          bindingHeader += `[# References ${refTags.join(' ')}]\n`;
        }

        const omniPrompt = `${bindingHeader}\n${fullPrompt}`;

        inputParts.push({
          type: 'text',
          text: omniPrompt,
        });

        const interactionParams: any = {
          model: modelName || 'gemini-omni-flash-preview',
          input: inputParts,
          background: false,
          store: false,
          response_format: {
            type: 'video',
            aspect_ratio: '9:16',
          },
        };

        const interaction = await ai.interactions.create(interactionParams, {
          timeout: 400000,
        });

        const videoPart = interaction.output_video;
        if (videoPart && videoPart.data) {
          const videoBuffer = Buffer.from(videoPart.data, 'base64');
          return {
            engine: 'omni_flash',
            interactionId: interaction.id,
            videoBuffer,
            mimeType: videoPart.mime_type || 'video/mp4',
            diagnostics,
          };
        }

        throw new Error('Omni Flash 交互未返回视频数据');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Gemini Omni Flash 视频生成失败: ${redactSecrets(msg)}`);
      }
    } else if (session.type === 'vertex_ai') {
      // Veo path via Vertex AI REST predictLongRunning endpoint
      const targetModel = 'veo-3.1-fast-generate-001';
      diagnostics.videoModel = targetModel;

      const { operationName, endpoint } = await callWithRetry(
        () =>
          VertexClient.predictLongRunning(session, {
            prompt: fullPrompt,
            imageBase64: firstFrameBuffer.toString('base64'),
            mimeType: firstFrameMimeType,
            modelId: targetModel,
            durationSeconds,
            taskId,
          }),
        { actionName: `Veo predictLongRunning 启动 (${targetModel})` }
      );

      return {
        engine: 'veo_31',
        operationName,
        diagnostics,
      };
    } else {
      // Veo path via Gemini API Developer Key generateVideos
      const targetModel = 'veo-3.1-fast-generate-001';
      diagnostics.videoModel = targetModel;

      const operation = await callWithRetry(
        () =>
          ai.models.generateVideos({
            model: targetModel,
            prompt: fullPrompt,
            image: {
              imageBytes: firstFrameBuffer.toString('base64'),
              mimeType: firstFrameMimeType,
            },
            config: {
              numberOfVideos: 1,
              resolution: '1080p',
              aspectRatio: '9:16',
              personGeneration: 'allow_adult',
            } as any,
          }),
        { actionName: `Veo 视频生成启动 (${targetModel})` }
      );

      if (!operation.name) {
        throw new Error('Veo API 未返回 Operation Name');
      }

      return {
        engine: 'veo_31',
        operationName: operation.name,
        diagnostics,
      };
    }
  }

  static extractVideoData(resp: any): { base64?: string; uri?: string } {
    if (!resp || typeof resp !== 'object') return {};

    const isUriStr = (str: string) => {
      if (typeof str !== 'string') return false;
      const trimmed = str.trim();
      return (
        trimmed.startsWith('gs://') ||
        trimmed.startsWith('http://') ||
        trimmed.startsWith('https://') ||
        trimmed.startsWith('data:video/') ||
        trimmed.startsWith('files/')
      );
    };

    const isBase64Str = (str: string) => {
      if (typeof str !== 'string') return false;
      const trimmed = str.trim();
      return (
        trimmed.length >= 10 &&
        !trimmed.includes(' ') &&
        !trimmed.startsWith('http') &&
        !trimmed.startsWith('gs://') &&
        !trimmed.startsWith('projects/') &&
        !trimmed.startsWith('files/')
      );
    };

    let foundBase64: string | undefined;
    let foundUri: string | undefined;

    // Direct path inspection for standard Gemini / Veo / Vertex AI SDK structures
    const directCandidates = [
      resp,
      resp?.response,
      resp?.result,
      resp?.response?.result,
      resp?.generatedVideos?.[0],
      resp?.generatedVideos?.[0]?.video,
      resp?.generatedSamples?.[0],
      resp?.generatedSamples?.[0]?.video,
      resp?.response?.generatedVideos?.[0],
      resp?.response?.generatedVideos?.[0]?.video,
      resp?.response?.generatedSamples?.[0],
      resp?.response?.generatedSamples?.[0]?.video,
      resp?.videos?.[0],
      resp?.response?.videos?.[0],
    ];

    for (const item of directCandidates) {
      if (!item || typeof item !== 'object') continue;
      const uri =
        item.gcsUri ||
        item.gcs_uri ||
        item.uri ||
        item.videoUri ||
        item.video_uri ||
        item.fileUri ||
        item.file_uri ||
        item.downloadUri ||
        item.download_uri ||
        item.url ||
        item.videoUrl ||
        item.video_url;
      if (typeof uri === 'string' && isUriStr(uri)) {
        foundUri = uri.trim();
        break;
      }

      const b64 =
        item.bytesBase64Encoded ||
        item.bytes ||
        item.bytes_base64_encoded ||
        item.videoBytes ||
        item.video_bytes ||
        item.data ||
        item.b64;
      if (typeof b64 === 'string' && isBase64Str(b64)) {
        foundBase64 = b64.trim();
        break;
      }
    }

    if (foundBase64 || foundUri) {
      if (foundUri && foundUri.startsWith('files/')) {
        foundUri = `https://generativelanguage.googleapis.com/v1beta/${foundUri}`;
      }
      return { base64: foundBase64, uri: foundUri };
    }

    // Helper to extract getters and own/prototype properties from class instances
    const expandObjectProperties = (obj: any): any => {
      if (!obj || typeof obj !== 'object') return obj;
      try {
        const copy: Record<string, any> = {};
        let current = obj;
        let depth = 0;
        while (current && current !== Object.prototype && depth < 5) {
          for (const key of Object.getOwnPropertyNames(current)) {
            if (key === 'constructor' || key === '__proto__') continue;
            try {
              if (copy[key] === undefined) {
                copy[key] = (obj as any)[key];
              }
            } catch {}
          }
          current = Object.getPrototypeOf(current);
          depth++;
        }
        return copy;
      } catch {
        return obj;
      }
    };

    const expandedResp = expandObjectProperties(resp);
    const unwrapped = unwrapProtobufStruct(expandedResp);

    const walk = (node: any, depth = 0) => {
      if (depth > 12 || !node || (foundBase64 && foundUri)) return;

      if (typeof node === 'string') {
        if (!foundUri && isUriStr(node)) {
          foundUri = node.trim();
        } else if (!foundBase64 && isBase64Str(node)) {
          foundBase64 = node.trim();
        }
        return;
      }

      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item, depth + 1);
        }
        return;
      }

      if (typeof node === 'object') {
        const b64 =
          node.bytesBase64Encoded ||
          node.bytes ||
          node.bytes_base64_encoded ||
          node.videoBytes ||
          node.video_bytes ||
          node.data ||
          node.b64;
        if (!foundBase64 && typeof b64 === 'string' && isBase64Str(b64)) {
          foundBase64 = b64.trim();
        }

        const uri =
          node.gcsUri ||
          node.gcs_uri ||
          node.uri ||
          node.videoUri ||
          node.video_uri ||
          node.fileUri ||
          node.file_uri ||
          node.downloadUri ||
          node.download_uri ||
          node.url ||
          node.videoUrl ||
          node.video_url ||
          node.video;
        if (!foundUri && typeof uri === 'string' && isUriStr(uri)) {
          foundUri = uri.trim();
        }

        for (const [, value] of Object.entries(node)) {
          walk(value, depth + 1);
        }
      }
    };

    walk(unwrapped);
    if (!foundUri && !foundBase64) {
      walk(resp);
    }

    if (foundUri && foundUri.startsWith('files/')) {
      foundUri = `https://generativelanguage.googleapis.com/v1beta/${foundUri}`;
    }

    if (foundBase64 || foundUri) {
      return { base64: foundBase64, uri: foundUri };
    }

    // Regex fallback
    try {
      const str = JSON.stringify(expandedResp);

      const gcsMatch = str.match(/gs:\/\/[a-zA-Z0-9_.\-]+(?:\/[^\s"':{}]+)+/);
      if (gcsMatch && gcsMatch[0]) {
        return { uri: gcsMatch[0] };
      }

      const httpMatch = str.match(/https?:\/\/[a-zA-Z0-9_.\-]+(?:\/[^\s"':{}]+)+/);
      if (httpMatch && httpMatch[0]) {
        return { uri: httpMatch[0] };
      }

      const filesMatch = str.match(/files\/[a-zA-Z0-9_\-]+/);
      if (filesMatch && filesMatch[0]) {
        return { uri: `https://generativelanguage.googleapis.com/v1beta/${filesMatch[0]}` };
      }

      const b64Match = str.match(/"(?:bytesBase64Encoded|bytes|data|b64)"\s*:\s*"([A-Za-z0-9+/=]{100,})"/);
      if (b64Match && b64Match[1]) {
        return { base64: b64Match[1] };
      }
    } catch {}

    return {};
  }

  static checkSafetyBlock(resp: any, errorObj?: any): {
    isBlocked: boolean;
    reason?: string;
    raiMediaFilteredCount?: number;
    raiMediaFilteredReasons?: string[];
  } {
    const defaultRaiMessage = '视频生成结果被 Google Vertex AI 安全策略过滤，未生成可下载的视频。请调整输入图片或提示词后重新生成。';

    if (errorObj) {
      const errStr = typeof errorObj === 'string' ? errorObj : JSON.stringify(errorObj);
      if (/RAI_MEDIA_FILTERED|raiMediaFiltered|finishReason.*SAFETY|BLOCK_REASON_SAFETY|PROHIBITED_CONTENT|SAFETY_FILTER|violates Vertex AI|usage guidelines|Support codes/i.test(errStr)) {
        return {
          isBlocked: true,
          reason: defaultRaiMessage,
          raiMediaFilteredCount: 1,
          raiMediaFilteredReasons: typeof errorObj === 'string' ? [errorObj] : (errorObj.message ? [errorObj.message] : [errStr]),
        };
      }
    }

    if (!resp || typeof resp !== 'object') return { isBlocked: false };

    const str = JSON.stringify(resp);

    const raiCount =
      resp.raiMediaFilteredCount ||
      resp.rai_media_filtered_count ||
      resp.response?.raiMediaFilteredCount ||
      resp.response?.rai_media_filtered_count ||
      resp.result?.raiMediaFilteredCount ||
      resp.result?.rai_media_filtered_count ||
      0;

    const rawReasons =
      resp.raiMediaFilteredReasons ||
      resp.rai_media_filtered_reasons ||
      resp.response?.raiMediaFilteredReasons ||
      resp.response?.rai_media_filtered_reasons ||
      resp.result?.raiMediaFilteredReasons ||
      resp.result?.rai_media_filtered_reasons ||
      [];

    const hasRaiCount = raiCount > 0 || rawReasons.length > 0;

    const hasSafetyKeyword =
      str.includes('RAI_MEDIA_FILTERED') ||
      str.includes('raiMediaFiltered') ||
      str.includes('rai_media_filtered') ||
      str.includes('violates Vertex AI') ||
      str.includes('usage guidelines') ||
      str.includes('"finishReason":"SAFETY"') ||
      str.includes('"finish_reason":"SAFETY"') ||
      str.includes('"BLOCK_REASON_SAFETY"');

    if (hasRaiCount || hasSafetyKeyword) {
      return {
        isBlocked: true,
        reason: defaultRaiMessage,
        raiMediaFilteredCount: raiCount > 0 ? raiCount : 1,
        raiMediaFilteredReasons: Array.isArray(rawReasons) && rawReasons.length > 0 ? rawReasons : [defaultRaiMessage],
      };
    }

    return { isBlocked: false };
  }

  static isMp4Valid(buf: Buffer): boolean {
    if (!buf || buf.length < 1000) return false;
    const header = buf.subarray(0, 128).toString('ascii');
    return header.includes('ftyp') || header.includes('moov') || header.includes('mdat');
  }

  static async fetchGcsVideoBuffer(videoUri: string, accessToken?: string, apiKey?: string): Promise<Buffer> {
    if (videoUri.startsWith('data:video/')) {
      const commaIdx = videoUri.indexOf(',');
      if (commaIdx !== -1) {
        const b64Data = videoUri.substring(commaIdx + 1);
        const buf = Buffer.from(b64Data, 'base64');
        if (VideoGenerator.isMp4Valid(buf)) return buf;
      }
    }

    const backoffDelays = [1000, 2000, 3000, 5000, 8000, 10000];

    if (!videoUri.startsWith('gs://')) {
      let baseUrl = videoUri;
      if (baseUrl.startsWith('files/')) {
        baseUrl = `https://generativelanguage.googleapis.com/v1beta/${baseUrl}`;
      }

      // Check file state if it's Gemini File API
      if (baseUrl.includes('generativelanguage.googleapis.com')) {
        for (let pollAttempt = 0; pollAttempt < 10; pollAttempt++) {
          try {
            let metaUrl = baseUrl;
            if (apiKey && !metaUrl.includes('key=')) {
              metaUrl += (metaUrl.includes('?') ? '&' : '?') + `key=${apiKey}`;
            }
            const headers: Record<string, string> = {};
            if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
            if (apiKey) headers['x-goog-api-key'] = apiKey;

            const metaRes = await fetch(metaUrl, { headers });
            if (metaRes.ok) {
              const metaJson: any = await metaRes.json().catch(() => null);
              if (metaJson && metaJson.state === 'PROCESSING') {
                console.log(`[File API Wait] 视频文件尚在转码中 (attempt ${pollAttempt + 1}), 等待 2s...`);
                await new Promise((r) => setTimeout(r, 2000));
                continue;
              }
            }
          } catch {}
          break;
        }
      }

      let downloadUrl = baseUrl;
      if (downloadUrl.includes('generativelanguage.googleapis.com') && !downloadUrl.includes('alt=')) {
        downloadUrl += (downloadUrl.includes('?') ? '&' : '?') + 'alt=media';
      }
      if (apiKey && downloadUrl.includes('generativelanguage.googleapis.com') && !downloadUrl.includes('key=')) {
        downloadUrl += (downloadUrl.includes('?') ? '&' : '?') + `key=${apiKey}`;
      }

      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      if (apiKey) headers['x-goog-api-key'] = apiKey;

      for (let attempt = 0; attempt < backoffDelays.length; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, backoffDelays[attempt - 1]));
        try {
          const res = await fetch(downloadUrl, { headers });
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            if (VideoGenerator.isMp4Valid(buf)) {
              return buf;
            } else {
              console.warn(`[Video Download Warning] URL ${downloadUrl} 返回的数据非有效 MP4 (${buf.length} bytes):`, buf.subarray(0, 100).toString('utf-8'));
            }
          } else {
            console.warn(`[Video Download Warning] Attempt ${attempt + 1} HTTP ${res.status} for ${downloadUrl}`);
          }
        } catch (e) {
          console.warn(`[Video Download Error] Attempt ${attempt + 1} failed for ${downloadUrl}:`, e);
        }
      }
      throw new Error(`下载视频失败，未获取到有效 MP4 字节流 (${videoUri})`);
    }

    const pathWithoutGs = videoUri.replace('gs://', '');
    const firstSlash = pathWithoutGs.indexOf('/');
    if (firstSlash === -1) {
      throw new Error(`无效的 GCS URI 路径: ${videoUri}`);
    }

    const uriBucket = pathWithoutGs.substring(0, firstSlash);
    const rawObjectPath = pathWithoutGs.substring(firstSlash + 1);
    const encodedObjectPath = encodeURIComponent(rawObjectPath);

    const activeBucket = resolveVeoOutputBucket();
    const candidateBuckets = Array.from(
      new Set([uriBucket, activeBucket, EXPECTED_PRODUCTION_VEO_BUCKET].filter(Boolean))
    );

    const candidateUrls: string[] = [];
    for (const b of candidateBuckets) {
      candidateUrls.push(
        `https://storage.googleapis.com/storage/v1/b/${b}/o/${encodedObjectPath}?alt=media`,
        `https://storage.googleapis.com/download/storage/v1/b/${b}/o/${encodedObjectPath}?alt=media`,
        `https://storage.googleapis.com/${b}/${rawObjectPath}`
      );
    }

    let lastError = '';
    for (let attempt = 0; attempt < backoffDelays.length; attempt++) {
      if (attempt > 0) {
        await new Promise((res) => setTimeout(res, backoffDelays[attempt - 1]));
      }
      for (const rawUrl of candidateUrls) {
        try {
          let url = rawUrl;
          if (apiKey && !url.includes('key=')) {
            url += (url.includes('?') ? '&' : '?') + `key=${apiKey}`;
          }
          const headers: Record<string, string> = {};
          if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
          if (apiKey) headers['x-goog-api-key'] = apiKey;

          const res = await fetch(url, { headers });
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            if (VideoGenerator.isMp4Valid(buf)) {
              return buf;
            } else {
              lastError = `返回的数据未包含 MP4 标识 (${buf.length} bytes)`;
            }
          } else {
            lastError = `HTTP ${res.status} (${url})`;
          }
        } catch (e) {
          lastError = String(e);
        }
      }
    }

    throw new Error(`从 GCS 下载视频多路径拉取均失败 (${videoUri}): ${lastError}`);
  }

  static async pollVeoOperation(
    ai: GoogleGenAI,
    session: ActiveSession,
    operationName: string
  ): Promise<{
    done: boolean;
    videoBuffer?: Buffer;
    videoUri?: string;
    sizeBytes?: number;
    error?: string;
    isSafetyBlock?: boolean;
    failureReason?: FailureReason;
    retryMode?: RetryMode;
    raiStatus?: 'filtered' | 'not_filtered' | 'unknown';
    raiMediaFilteredCount?: number;
    raiMediaFilteredReasons?: string[];
  }> {
    if (session.type === 'vertex_ai') {
      const result = await VertexClient.pollOperation(session, operationName);
      if (!result.done) {
        return { done: false };
      }

      if (result.error) {
        const safetyCheck = VideoGenerator.checkSafetyBlock(null, result.error);
        if (safetyCheck.isBlocked) {
          return {
            done: true,
            error: safetyCheck.reason || '视频生成结果被 Google Vertex AI 安全策略过滤，未生成可下载的视频。请调整输入图片或提示词后重新生成。',
            isSafetyBlock: true,
            failureReason: 'output_rai_filtered',
            raiStatus: 'filtered',
            raiMediaFilteredCount: safetyCheck.raiMediaFilteredCount || 1,
            raiMediaFilteredReasons: safetyCheck.raiMediaFilteredReasons || [],
            retryMode: 'REWRITE_INPUT_THEN_REGENERATE',
          };
        }
        return {
          done: true,
          error: redactSecrets(JSON.stringify(result.error)),
          isSafetyBlock: false,
          failureReason: 'upstream_failed',
          raiStatus: 'not_filtered',
          retryMode: 'SAFE_TO_REGENERATE',
        };
      }

      const respObj = result.response || result;
      const safetyCheck = VideoGenerator.checkSafetyBlock(respObj);
      const videoData = VideoGenerator.extractVideoData(respObj);

      if (safetyCheck.isBlocked && !videoData.base64 && !videoData.uri) {
        return {
          done: true,
          error: safetyCheck.reason || '视频生成结果被 Google Vertex AI 安全策略过滤，未生成可下载的视频。请调整输入图片或提示词后重新生成。',
          isSafetyBlock: true,
          failureReason: 'output_rai_filtered',
          raiStatus: 'filtered',
          raiMediaFilteredCount: safetyCheck.raiMediaFilteredCount || 1,
          raiMediaFilteredReasons: safetyCheck.raiMediaFilteredReasons || [],
          retryMode: 'REWRITE_INPUT_THEN_REGENERATE',
        };
      }

      if (!videoData.base64 && !videoData.uri) {
        console.error('[Veo Polling Diagnostic] 渲染完成但未在 response 中提取到视频数据:', JSON.stringify(respObj).slice(0, 500));
        return {
          done: true,
          error: '云端 Veo 任务已完成，但未返回可用的视频数据。',
          isSafetyBlock: false,
          failureReason: 'upstream_empty_response',
          raiStatus: 'not_filtered',
          retryMode: 'SAFE_TO_REGENERATE',
        };
      }

      if (videoData.base64) {
        const buf = Buffer.from(videoData.base64, 'base64');
        if (buf.length < 1000 || !VideoGenerator.isMp4Valid(buf)) {
          return {
            done: true,
            videoUri: videoData.uri,
            error: `云端返回的视频数据无效或尺寸异常 (sizeBytes=${buf.length})。`,
            isSafetyBlock: false,
            failureReason: 'artifact_invalid',
            raiStatus: 'not_filtered',
            retryMode: 'SAFE_TO_REGENERATE',
          };
        }
        return {
          done: true,
          videoBuffer: buf,
          videoUri: videoData.uri,
          sizeBytes: buf.length,
          raiStatus: 'not_filtered',
        };
      }

      try {
        const accessToken = await VertexClient.getAccessToken(session);
        const videoBuffer = await VideoGenerator.fetchGcsVideoBuffer(videoData.uri!, accessToken);
        if (!videoBuffer || videoBuffer.length < 1000 || !VideoGenerator.isMp4Valid(videoBuffer)) {
          return {
            done: true,
            videoUri: videoData.uri,
            error: `从 GCS 下载的视频数据无效或尺寸异常 (sizeBytes=${videoBuffer?.length || 0})。`,
            isSafetyBlock: false,
            failureReason: 'artifact_invalid',
            raiStatus: 'not_filtered',
            retryMode: 'SAFE_TO_REGENERATE',
          };
        }
        return {
          done: true,
          videoBuffer,
          videoUri: videoData.uri,
          sizeBytes: videoBuffer.length,
          raiStatus: 'not_filtered',
        };
      } catch (dlErr: any) {
        console.error('[pollVeoOperation Vertex Download Error]:', dlErr);
        return {
          done: true,
          videoUri: videoData.uri,
          error: '云端任务已完成，但视频文件拉取失败。',
          isSafetyBlock: false,
          failureReason: 'artifact_fetch_failed',
          raiStatus: 'not_filtered',
          retryMode: 'RETRY_DOWNLOAD',
        };
      }
    } else {
      // Gemini API Key mode
      const op = new GenerateVideosOperation();
      op.name = operationName;

      const updated = await ai.operations.getVideosOperation({ operation: op });

      if (!updated.done) {
        return { done: false };
      }

      if (updated.error) {
        const safetyCheck = VideoGenerator.checkSafetyBlock(null, updated.error);
        if (safetyCheck.isBlocked) {
          return {
            done: true,
            error: safetyCheck.reason || '视频生成结果被 Google Vertex AI 安全策略过滤，未生成可下载的视频。请调整输入图片或提示词后重新生成。',
            isSafetyBlock: true,
            failureReason: 'output_rai_filtered',
            raiStatus: 'filtered',
            raiMediaFilteredCount: safetyCheck.raiMediaFilteredCount || 1,
            raiMediaFilteredReasons: safetyCheck.raiMediaFilteredReasons || [],
            retryMode: 'REWRITE_INPUT_THEN_REGENERATE',
          };
        }
        return {
          done: true,
          error: redactSecrets(JSON.stringify(updated.error)),
          isSafetyBlock: false,
          failureReason: 'upstream_failed',
          raiStatus: 'not_filtered',
          retryMode: 'SAFE_TO_REGENERATE',
        };
      }

      const respObj = updated.response || updated;
      const safetyCheck = VideoGenerator.checkSafetyBlock(respObj);
      const videoData = VideoGenerator.extractVideoData(respObj);

      if (safetyCheck.isBlocked && !videoData.base64 && !videoData.uri) {
        return {
          done: true,
          error: safetyCheck.reason || '视频生成结果被 Google Vertex AI 安全策略过滤，未生成可下载的视频。请调整输入图片或提示词后重新生成。',
          isSafetyBlock: true,
          failureReason: 'output_rai_filtered',
          raiStatus: 'filtered',
          raiMediaFilteredCount: safetyCheck.raiMediaFilteredCount || 1,
          raiMediaFilteredReasons: safetyCheck.raiMediaFilteredReasons || [],
          retryMode: 'REWRITE_INPUT_THEN_REGENERATE',
        };
      }

      if (!videoData.base64 && !videoData.uri) {
        console.error('[Veo Polling Diagnostic Gemini API] Operation 完成但未在 response 中提取到视频数据:', JSON.stringify(respObj).slice(0, 500));
        return {
          done: true,
          error: '云端 Veo 任务已完成，但未返回可用的视频数据。',
          isSafetyBlock: false,
          failureReason: 'upstream_empty_response',
          raiStatus: 'not_filtered',
          retryMode: 'SAFE_TO_REGENERATE',
        };
      }

      if (videoData.base64) {
        const buf = Buffer.from(videoData.base64, 'base64');
        if (buf.length < 1000 || !VideoGenerator.isMp4Valid(buf)) {
          return {
            done: true,
            videoUri: videoData.uri,
            error: `云端返回的视频数据无效或尺寸异常 (sizeBytes=${buf.length})。`,
            isSafetyBlock: false,
            failureReason: 'artifact_invalid',
            raiStatus: 'not_filtered',
            retryMode: 'SAFE_TO_REGENERATE',
          };
        }
        return {
          done: true,
          videoBuffer: buf,
          videoUri: videoData.uri,
          sizeBytes: buf.length,
          raiStatus: 'not_filtered',
        };
      }

      try {
        const apiKey = session.apiKey || process.env.GEMINI_API_KEY;
        const videoBuffer = await VideoGenerator.fetchGcsVideoBuffer(videoData.uri!, undefined, apiKey);
        if (!videoBuffer || videoBuffer.length < 1000 || !VideoGenerator.isMp4Valid(videoBuffer)) {
          return {
            done: true,
            videoUri: videoData.uri,
            error: `从 GCS 下载的视频数据无效或尺寸异常 (sizeBytes=${videoBuffer?.length || 0})。`,
            isSafetyBlock: false,
            failureReason: 'artifact_invalid',
            raiStatus: 'not_filtered',
            retryMode: 'SAFE_TO_REGENERATE',
          };
        }
        return {
          done: true,
          videoBuffer,
          videoUri: videoData.uri,
          sizeBytes: videoBuffer.length,
          raiStatus: 'not_filtered',
        };
      } catch (dlErr: any) {
        console.error('[pollVeoOperation Gemini API Download Error]:', dlErr);
        return {
          done: true,
          videoUri: videoData.uri,
          error: '云端任务已完成，但视频文件拉取失败。',
          isSafetyBlock: false,
          failureReason: 'artifact_fetch_failed',
          raiStatus: 'not_filtered',
          retryMode: 'RETRY_DOWNLOAD',
        };
      }
    }
  }
}
