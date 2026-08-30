import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MVP production provider AUTO aspect ratio contract', () => {
  it('derives provider aspect ratio from the actual first-frame image instead of hard-coding 9:16', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'mvp-server-v02.ts'), 'utf8');

    expect(source).toContain("import { resolveAutoAspectRatio } from './src/services/google/vertexClient';");
    expect(source).toContain("const aspectRatio = await resolveAutoAspectRatio(params.imageBuffer.toString('base64'));");
    expect(source).toMatch(/parameters:\s*\{[\s\S]*?aspectRatio,/);
    expect(source).not.toContain("aspectRatio: '9:16'");
  });
});
