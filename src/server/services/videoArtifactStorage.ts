import { gcsArtifactStore, getVeoBucketName, ArtifactMetadata } from '../storage/gcsArtifactStore';

export class VideoArtifactStorageService {
  public static getOutputBucket(): string {
    return getVeoBucketName();
  }

  public async uploadVideoArtifact(params: {
    taskId: string;
    videoBuffer: Buffer;
    contentType?: string;
  }): Promise<ArtifactMetadata> {
    return gcsArtifactStore.uploadVideoArtifact(params);
  }

  public async getVideoArtifactMetadata(bucketName: string, objectPath: string): Promise<ArtifactMetadata | null> {
    return gcsArtifactStore.getVideoArtifactMetadata(bucketName, objectPath);
  }

  public async artifactExists(bucketName: string, objectPath: string): Promise<boolean> {
    return gcsArtifactStore.artifactExists(bucketName, objectPath);
  }

  public async streamVideoArtifact(bucketName: string, objectPath: string): Promise<Buffer> {
    return gcsArtifactStore.fetchArtifactBuffer(bucketName, objectPath);
  }

  public async deleteVideoArtifact(bucketName: string, objectPath: string): Promise<boolean> {
    return gcsArtifactStore.deleteVideoArtifact(bucketName, objectPath);
  }

  public async migrateLegacyArtifact(params: {
    taskId: string;
    videoUri: string;
    accessToken?: string;
    apiKey?: string;
  }): Promise<ArtifactMetadata> {
    return gcsArtifactStore.migrateArtifactToGcs(params);
  }
}

export const videoArtifactStorage = new VideoArtifactStorageService();
