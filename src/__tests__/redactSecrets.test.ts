import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../utils/redactSecrets';

describe('redactSecrets Utility', () => {
  it('redacts Google API Keys starting with AIzaSy', () => {
    const input = 'Error with key AIzaSyD1234567890abcdefghijklmnopqrstuvw';
    const redacted = redactSecrets(input);
    expect(redacted).not.toContain('AIzaSyD1234567890');
    expect(redacted).toContain('[REDACTED_API_KEY]');
  });

  it('redacts RSA private keys', () => {
    const input = `-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----`;
    const redacted = redactSecrets(input);
    expect(redacted).not.toContain('MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC');
    expect(redacted).toContain('[REDACTED_PRIVATE_KEY]');
  });

  it('redacts OAuth ya29 tokens', () => {
    const input = 'Token ya29.a0ARW5m7xX1234567890_abcdef';
    const redacted = redactSecrets(input);
    expect(redacted).not.toContain('ya29.a0ARW5m7xX1234567890_abcdef');
    expect(redacted).toContain('[REDACTED_OAUTH_TOKEN]');
  });

  it('handles null and undefined safely', () => {
    expect(redactSecrets(null)).toBe('');
    expect(redactSecrets(undefined)).toBe('');
  });
});
