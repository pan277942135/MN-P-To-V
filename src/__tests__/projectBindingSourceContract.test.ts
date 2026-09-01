import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Step 4.0.1-C Project Binding source contract', () => {
  it('mounts the requested API and keeps production data in Firestore/GCS', () => {
    const server = read('director-server.ts');
    const service = read('src/server/services/projectBindingService.ts');
    const router = read('src/server/services/projectBindingRouter.ts');
    const repository = read('src/server/repositories/firestoreDirectorProjectRepository.ts');
    const page = read('src/pages/GeminiStoryboardDirectorPage.tsx');
    const panel = read('src/components/ProjectBindingPanel.tsx');

    expect(server).toContain("app.use('/api/director/project-binding'");
    expect(service).toContain("PROJECT_BINDING_COLLECTION = 'director_project_bindings'");
    expect(service).toContain('createBinding');
    expect(service).toContain('resolveBinding');
    expect(service).toContain('runTransaction');
    expect(router).toContain("router.post('/create'");
    expect(router).toContain("router.post('/restore'");
    expect(router).toContain('project');
    expect(router).toContain('episode');
    expect(router).toContain('shots');
    expect(router).toContain('stages');
    expect(router).toContain('assets');
    expect(repository).toContain('getRestoreBundle');
    expect(repository).toContain("collection('stages')");
    expect(repository).toContain("collection('shots')");
    expect(page).toContain('<ProjectBindingPanel');
    expect(panel).toContain('生成项目绑定码');
    expect(panel).toContain('恢复已有项目');
    expect(panel).toContain('Firestore + GCS');
  });

  it('does not add browser persistence to the new Project Binding layer', () => {
    const files = [
      'src/server/services/projectBindingService.ts',
      'src/server/services/projectBindingRouter.ts',
      'src/services/director/projectBindingClient.ts',
      'src/components/ProjectBindingPanel.tsx',
    ];
    for (const file of files) {
      const source = read(file);
      expect(source).not.toMatch(/localStorage|indexedDB|sessionStorage/i);
    }
  });
});
