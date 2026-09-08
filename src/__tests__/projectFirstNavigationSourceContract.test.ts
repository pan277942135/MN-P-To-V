import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('Project First Navigation source contract', () => {
  it('starts at Project List and defers session restore to workspace entry', () => {
    const app = read('src/App.tsx');
    const session = read('src/context/ProjectSessionContext.tsx');

    expect(app).toContain("<ProjectHomePage");
    expect(app).toContain("pathname === '/projects'");
    expect(app).toContain('refreshSession(projectFromRoute)');
    expect(session).toContain('Project List may render without any Project Session API request');
    expect(session).not.toContain('recent binding auto-open skipped');
    expect(session).not.toContain('cloudProjectId');
  });
});
