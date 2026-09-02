import { Storage } from '@google-cloud/storage';
import { resolveVeoOutputBucket } from './gcsArtifactStore';

export interface AiObjectRef {
  bucket: string;
  objectPath: string;
}

export interface AiStoredObject extends AiObjectRef {
  uri: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AiDirectorStorageLike {
  bucketName(): string;
  putObject(input: { objectPath: string; buffer: Buffer; mimeType: string }): Promise<AiStoredObject>;
  getObject(ref: AiObjectRef): Promise<{ buffer: Buffer; mimeType: string }>;
  getSignedUrl(ref: AiObjectRef, expiresAt: Date): Promise<string>;
  diagnoseSigning?(objectPath?: string): Promise<{ bucket: string; object: string; signingAvailable: boolean; errorCode?: string }>;
}

export type AiStorageErrorCode = 'GCS_NOT_FOUND' | 'GCS_PERMISSION_DENIED' | 'SIGN_BLOB_FAILED' | 'SIGNING_CONFIG_ERROR';

export class AiDirectorStorageError extends Error {
  public readonly errorCode: AiStorageErrorCode;
  constructor(errorCode: AiStorageErrorCode, message: string) {
    super(message);
    this.name = 'AiDirectorStorageError';
    this.errorCode = errorCode;
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseGsUri(value: unknown): AiObjectRef | null {
  const raw = clean(value);
  const match = raw.match(/^gs:\/\/([^/]+)\/(.+)$/i);
  return match ? { bucket: match[1], objectPath: match[2] } : null;
}

function parseGoogleStorageUrl(value: unknown): AiObjectRef | null {
  const raw = clean(value);
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (host === 'storage.googleapis.com' || host === 'storage.cloud.google.com') {
      const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
      if (segments.length >= 2) return { bucket: segments[0], objectPath: segments.slice(1).join('/') };
    }
    if (host.endsWith('.storage.googleapis.com')) {
      const bucket = host.slice(0, -'.storage.googleapis.com'.length);
      const objectPath = url.pathname.replace(/^\/+/, '').split('/').map((segment) => decodeURIComponent(segment)).join('/');
      if (bucket && objectPath) return { bucket, objectPath };
    }
    const apiMatch = url.pathname.match(/^\/download\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/i);
    if (apiMatch) return { bucket: decodeURIComponent(apiMatch[1]), objectPath: decodeURIComponent(apiMatch[2]) };
  } catch {
    return null;
  }
  return null;
}

export function resolveAiObjectRef(value: unknown, fallbackBucket = ''): AiObjectRef | null {
  const parsed = parseGsUri(value);
  if (parsed) return parsed;
  const googleStorageUrl = parseGoogleStorageUrl(value);
  if (googleStorageUrl) return googleStorageUrl;
  const objectPath = clean(value);
  const bucket = clean(fallbackBucket);
  if (!bucket || !objectPath || /^https?:\/\//i.test(objectPath) || objectPath.startsWith('/')) return null;
  return { bucket, objectPath };
}

let storageClient: Storage | null = null;

function getStorageClient(): Storage {
  if (!storageClient) storageClient = new Storage();
  return storageClient;
}

class AiDirectorStorage implements AiDirectorStorageLike {
  public bucketName(): string {
    return resolveVeoOutputBucket();
  }

  public async putObject(input: { objectPath: string; buffer: Buffer; mimeType: string }): Promise<AiStoredObject> {
    const objectPath = clean(input.objectPath);
    const mimeType = clean(input.mimeType) || 'application/octet-stream';
    if (!objectPath || !input.buffer?.length) throw new Error('AI_DIRECTOR_OBJECT_INPUT_INVALID');
    const bucket = this.bucketName();
    const file = getStorageClient().bucket(bucket).file(objectPath);
    await file.save(input.buffer, {
      resumable: false,
      metadata: {
        contentType: mimeType,
        cacheControl: 'private, max-age=900',
      },
    });
    const [metadata] = await file.getMetadata();
    return {
      bucket,
      objectPath,
      uri: `gs://${bucket}/${objectPath}`,
      mimeType: String(metadata.contentType || mimeType),
      sizeBytes: Number(metadata.size || input.buffer.length),
    };
  }

  public async getObject(ref: AiObjectRef): Promise<{ buffer: Buffer; mimeType: string }> {
    const bucket = clean(ref.bucket);
    const objectPath = clean(ref.objectPath);
    if (!bucket || !objectPath) throw new Error('AI_DIRECTOR_OBJECT_REF_INVALID');
    const file = getStorageClient().bucket(bucket).file(objectPath);
    const [[metadata], [buffer]] = await Promise.all([file.getMetadata(), file.download()]);
    return {
      buffer,
      mimeType: String(metadata.contentType || 'application/octet-stream'),
    };
  }

  public async getSignedUrl(ref: AiObjectRef, expiresAt: Date): Promise<string> {
    const bucket = clean(ref.bucket);
    const objectPath = clean(ref.objectPath);
    if (!bucket || !objectPath) throw new AiDirectorStorageError('SIGNING_CONFIG_ERROR', 'AI_DIRECTOR_OBJECT_REF_INVALID');
    try {
      const [url] = await getStorageClient().bucket(bucket).file(objectPath).getSignedUrl({
        version: 'v4', action: 'read', expires: expiresAt,
      });
      return url;
    } catch (error: any) {
      const message = String(error?.message || error || '').toLowerCase();
      const errorCode: AiStorageErrorCode = message.includes('not found') || message.includes('no such object')
        ? 'GCS_NOT_FOUND'
        : message.includes('permission') || message.includes('forbidden') || message.includes('access denied')
          ? 'GCS_PERMISSION_DENIED'
          : message.includes('signblob') || message.includes('sign blob') || message.includes('iam.serviceaccounts.signblob')
            ? 'SIGN_BLOB_FAILED'
            : 'SIGNING_CONFIG_ERROR';
      throw new AiDirectorStorageError(errorCode, 'GCS Signed URL generation failed.');
    }
  }

  public async diagnoseSigning(objectPath = 'projects/__gcs_signing_diagnostic__/probe.txt') {
    const bucket = this.bucketName();
    try {
      await this.getSignedUrl({ bucket, objectPath }, new Date(Date.now() + 15 * 60 * 1000));
      return { bucket, object: objectPath, signingAvailable: true };
    } catch (error: any) {
      return { bucket, object: objectPath, signingAvailable: false, errorCode: error?.errorCode || 'SIGN_BLOB_FAILED' };
    }
  }
}

export const aiDirectorStorage = new AiDirectorStorage();
