import crypto from 'crypto';
import { getFirestoreInstance } from './src/server/db/firestore';
import { createMvpAppV021 } from './mvp-server-v021';

const PORT = Number(process.env.PORT || 8080);
const CHATGPT_KEY_COLLECTION = 'mvp_chatgpt_api_keys';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function createMvpAppV022() {
  const app = await createMvpAppV021();

  // This route is intentionally hosted only on the existing IAP-protected MVP service.
  // It creates a random bearer credential and persists only its SHA-256 hash.
  app.post('/api/mvp/chatgpt/keys', async (_req, res) => {
    try {
      const db = getFirestoreInstance();
      if (!db) return res.status(503).json({ error: { code: 'FIRESTORE_UNAVAILABLE', message: 'Firestore unavailable.' } });
      const apiKey = `zjg_${crypto.randomBytes(32).toString('base64url')}`;
      const keyHash = sha256(apiKey);
      const createdAt = Date.now();
      await db.collection(CHATGPT_KEY_COLLECTION).doc(keyHash).create({
        createdAt,
        revokedAt: null,
        purpose: 'chatgpt-actions-v1',
      });
      return res.status(201).json({
        apiKey,
        createdAt,
        warning: 'This key is shown once. Store it only in the GPT Action Bearer API-key configuration.',
      });
    } catch (error: any) {
      return res.status(500).json({ error: { code: 'CHATGPT_KEY_CREATE_FAILED', message: String(error?.message || error) } });
    }
  });

  return app;
}

export async function startMvpServerV022() {
  const app = await createMvpAppV022();
  return app.listen(PORT, '0.0.0.0', () => console.log(`[MVP_IDENTITY_SAFE_V022] listening on :${PORT}; ChatGPT pairing enabled`));
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) void startMvpServerV022();
