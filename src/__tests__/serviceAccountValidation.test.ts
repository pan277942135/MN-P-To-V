import { describe, it, expect } from 'vitest';
import { ServiceAccountJsonSchema } from '../types';

describe('Service Account JSON Validation', () => {
  it('validates a valid service account JSON schema', () => {
    const validJson = {
      type: 'service_account',
      project_id: 'my-gcp-project',
      private_key_id: 'key123',
      private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      client_email: 'sa-name@my-gcp-project.iam.gserviceaccount.com',
      client_id: '123456789',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    };

    const result = ServiceAccountJsonSchema.safeParse(validJson);
    expect(result.success).toBe(true);
  });

  it('rejects invalid type or missing required fields', () => {
    const invalidJson = {
      type: 'authorized_user',
      project_id: 'my-gcp-project',
    };

    const result = ServiceAccountJsonSchema.safeParse(invalidJson);
    expect(result.success).toBe(false);
  });
});
