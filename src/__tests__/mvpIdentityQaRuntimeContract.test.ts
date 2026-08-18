import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const wrapper = readFileSync('mvp-server-v021.ts', 'utf8');
const identitySafe = readFileSync('src/mvp/identitySafe.ts', 'utf8');

describe('MVP identity QA runtime contract', () => {
  it('does not publish attempt-1 identity QA as current while a provider retry is active', () => {
    expect(wrapper).toContain("['RETRYING', 'GENERATING', 'QUALITY_CHECKING']");
    expect(wrapper).toContain('identityReport: currentIdentityReport');
    expect(wrapper).toContain('originalJson({ ...body, identityReport: null })');
    expect(wrapper).toContain('firstAttemptIdentityReport: task.firstAttemptIdentityReport || null');
  });

  it('pins Gemini identity scores to 0-100 and keeps legacy normalization at the parser boundary', () => {
    expect(identitySafe).toContain('All numeric identity scores MUST be integers on a 0–100 scale');
    expect(identitySafe).toContain('normalizeIdentityQaParsedScores');
    expect(identitySafe).toContain('IDENTITY_QA_EVIDENCE_CONFLICT');
    expect(identitySafe).toContain("sourceScoreScale: 'legacy-1-5-normalized'");
  });
});
