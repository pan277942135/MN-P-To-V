import express from 'express';
import { aiDirectorStorage } from '../storage/aiDirectorStorage';

export function createGcsSigningDiagnosticRouter() {
  const router = express.Router();
  router.get('/', async (req, res) => {
    if (process.env.FIRESTORE_DIAGNOSTIC_ENABLED !== '1') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const object = typeof req.query.object === 'string' ? req.query.object.trim() : undefined;
    const result = await aiDirectorStorage.diagnoseSigning(object);
    return res.status(200).json({
      bucket: result.bucket,
      object: result.object,
      runtimeServiceAccount: process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL || '',
      signingAvailable: result.signingAvailable,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
  });
  return router;
}
