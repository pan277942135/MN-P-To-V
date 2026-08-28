import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Director Step 4.0 cloud persistence source contract', () => {
  it('uses Firestore/GCS as Director cloud authority while preserving local cache fallback', () => {
    const pkg = read('package.json');
    const app = read('src/App.tsx');
    const provider = read('src/components/DirectorCloudPersistenceProvider.tsx');
    const client = read('src/services/director/directorCloudPersistence.ts');
    const repository = read('src/server/repositories/firestoreDirectorProjectRepository.ts');
    const gcs = read('src/server/storage/directorGcsStore.ts');
    const service = read('src/server/services/directorCloudPersistenceService.ts');
    const router = read('src/server/services/directorCloudPersistenceRouter.ts');
    const wrapper = read('director-server.ts');

    expect(pkg).toContain('tsx director-server.ts');
    expect(pkg).toContain('esbuild director-server.ts');
    expect(app).toContain('<DirectorCloudPersistenceProvider>');
    expect(provider).toContain('bootstrapDirectorCloud');
    expect(provider).toContain('syncDirectorCloud');
    expect(provider).toContain('Cloud · Local fallback');
    expect(client).toContain("'zaojing.director.cloud.v1'");
    expect(client).toContain('keyframeAssetStore.get');
    expect(client).toContain('keyframeAssetStore.put');
    expect(client).toContain('/api/director/persistence/latest');
    expect(client).toContain("'X-Director-Persistence-Intent'");
    expect(repository).toContain("DIRECTOR_PROJECT_COLLECTION = 'director_projects'");
    expect(repository).toContain("collection('episodes')");
    expect(repository).toContain("collection('stages')");
    expect(repository).toContain("collection('shots')");
    expect(gcs).toContain("'director'");
    expect(gcs).toContain("'keyframes'");
    expect(gcs).toContain('resolveVeoOutputBucket');
    expect(service).toContain('keyframeCloudAssets');
    expect(router).toContain("DIRECTOR_CLOUD_PERSISTENCE_INTENT = 'director-cloud-v0.4.0'");
    expect(wrapper).toContain("app.use('/api/director/persistence'");
  });

  it('does not enable Episode/Veo production through the persistence wrapper', () => {
    const wrapper = read('director-server.ts');
    const router = read('src/server/services/directorCloudPersistenceRouter.ts');
    expect(wrapper).not.toContain('DIRECTOR_PRODUCTION_RUN_ENABLED=1');
    expect(router).not.toContain('/run');
    expect(router).not.toContain('VideoGenerator');
    expect(router).not.toContain('generateVideos');
  });
});
