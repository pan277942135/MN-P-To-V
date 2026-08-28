import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Director Console source contract', () => {
  it('makes the Episode Director Console the default React surface without removing single-shot Studio', () => {
    const app = read('src/App.tsx');
    const sidebar = read('src/components/Sidebar.tsx');
    const director = read('src/pages/DirectorConsolePage.tsx');

    expect(app).toContain("useState<NavTab>('director')");
    expect(app).toContain('<DirectorConsolePage />');
    expect(app).toContain('<StudioPage');
    expect(sidebar).toContain("label: '导演台'");
    expect(sidebar).toContain("'director' | 'studio'");
    expect(director).toContain('整集导演控制台');
    expect(director).toContain('S01–S06 Production Board');
    expect(director).toContain('Durable GCS');
    expect(director).toContain('Preview 已锁定执行');
  });

  it('deploys the React/Episode server with the formal Dockerfile in a read-only public preview', () => {
    const workflow = read('.github/workflows/director-console-uat-deploy.yml');

    expect(workflow).toContain('docker build -f Dockerfile');
    expect(workflow).not.toContain('Dockerfile.mvp');
    expect(workflow).toContain('PUBLIC_PREVIEW_READ_ONLY=1');
    expect(workflow).toContain('DIRECTOR_PRODUCTION_RUN_ENABLED=0');
    expect(workflow).toContain('P0_DISABLE_STARTUP_RECOVERY=1');
    expect(workflow).toContain('/api/director/capabilities');
  });
});
