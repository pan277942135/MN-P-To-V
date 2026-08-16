import fs from 'node:fs';

function replaceOnce(path, needle, replacement) {
  const source = fs.readFileSync(path, 'utf8');
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${path}: expected exactly one refinement anchor, found ${count}`);
  fs.writeFileSync(path, source.replace(needle, replacement));
}

function insertBefore(path, marker, insertion) {
  replaceOnce(path, marker, `${insertion}${marker}`);
}

const gcsPath = 'src/server/storage/gcsArtifactStore.ts';
insertBefore(
  gcsPath,
  '  public async discoverTaskPrefixVideo(params: {',
  `  private async fetchExactArtifactBuffer(\n    bucketName: string,\n    objectPath: string,\n    options?: { session?: any }\n  ): Promise<Buffer> {\n    const exactMockKey = \`\${bucketName}/\${objectPath}\`;\n    if (this.mockStore.has(exactMockKey)) {\n      return this.mockStore.get(exactMockKey)!.buffer;\n    }\n    if (this.useMock || process.env.NODE_ENV === 'test') {\n      throw new Error(\`[GcsArtifactStore Mock] Exact artifact gs://\${bucketName}/\${objectPath} not found.\`);\n    }\n\n    const clients = await getStorageClientsForSessions({ session: options?.session });\n    let lastError: any = null;\n    for (const storage of clients) {\n      try {\n        const [bytes] = await storage.bucket(bucketName).file(objectPath).download();\n        const buffer = Buffer.from(bytes);\n        if (buffer.length > 0) return buffer;\n      } catch (err) {\n        lastError = err;\n      }\n    }\n    throw new Error(\n      \`[GcsArtifactStore] Exact artifact download failed for gs://\${bucketName}/\${objectPath}: \${sanitizeGcsError(String(lastError?.message || lastError || 'no usable storage client'))}\`\n    );\n  }\n\n`
);

replaceOnce(
  gcsPath,
  `        const buffer = await this.fetchArtifactBuffer(bucketName, candidate.outputObjectPath, { session: params.session });`,
  `        // Recovery evidence must be the exact object returned by the exact task/attempt\n        // prefix listing. The general artifact fetcher intentionally has historical\n        // fallback paths, so it is forbidden here.\n        const buffer = await this.fetchExactArtifactBuffer(bucketName, candidate.outputObjectPath, { session: params.session });`
);

const testPath = 'src/__tests__/gcsUnknownRecovery.test.ts';
replaceOnce(
  testPath,
  `  it('returns not_found without manufacturing provider evidence', async () => {`,
  `  it('does not let a corrupt current-attempt object borrow a valid root fallback', async () => {\n    await gcsArtifactStore.uploadVideoArtifact({ taskId: 'task_exact', videoBuffer: validMp4() });\n    await gcsArtifactStore.uploadImageArtifact({\n      objectPath: 'veo/task_exact/attempts/2/provider-output/video.mp4',\n      buffer: Buffer.alloc(1200, 7),\n      contentType: 'video/mp4',\n    });\n\n    const result = await gcsArtifactStore.discoverTaskPrefixVideo({ taskKey: 'task_exact/attempts/2' });\n    expect(result.status).toBe('not_found');\n    expect(result.artifact).toBeUndefined();\n  });\n\n  it('returns not_found without manufacturing provider evidence', async () => {`
);

const contractPath = 'src/__tests__/gcsUnknownRecoverySourceContract.test.ts';
replaceOnce(
  contractPath,
  `    expect(gcs).toContain('VideoGenerator.isMp4Valid(buffer)');`,
  `    expect(gcs).toContain('fetchExactArtifactBuffer');\n    expect(gcs).toContain('file(objectPath).download()');\n    expect(gcs).toContain('VideoGenerator.isMp4Valid(buffer)');`
);

console.log('Applied exact-object GCS recovery evidence refinement.');
