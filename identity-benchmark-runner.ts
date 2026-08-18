import crypto from 'crypto';
import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { getFirestoreInstance } from './src/server/db/firestore';
import { VideoGenerator } from './src/services/video/videoGenerator';
import { VideoInspector } from './src/services/video/videoInspector';
import { redactSecrets } from './src/utils/redactSecrets';
import {
  buildIdentitySafePrompt,
  qaVideoIdentityAgainstInput,
  type MvpIdentityQaReport,
} from './src/mvp/identitySafe';
import {
  IDENTITY_STABILITY_BENCHMARK_V1,
  summarizeIdentityBenchmark,
  type IdentityBenchmarkResult,
  type IdentityBenchmarkCase,
} from './src/mvp/identityBenchmark';
import { MVP_VIDEO_MODEL } from './src/mvp/mvpContract';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'xp-vertex-project';
const REGION = process.env.VERTEX_LOCATION || 'us-central1';
const OUTPUT_BUCKET = String(process.env.VEO_OUTPUT_BUCKET || '').replace(/^gs:\/\//, '').replace(/\/+$/, '');
const FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '';
const IDENTITY_QA_MODEL = process.env.IDENTITY_QA_MODEL || 'gemini-2.5-flash';
const BENCHMARK_VERSION = 'identity-stability-benchmark-v1';
const RUN_ID = `idsafe_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MAX_CASE_MS = 15 * 60 * 1000;
const POLL_MS = 10_000;
const CONCURRENCY = Math.max(1, Math.min(3, Number(process.env.BENCHMARK_CONCURRENCY || 2)));

const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
const storage = new Storage();

interface ReferenceSource {
  source: 'character_library' | 'mvp_manually_confirmed_input' | 'legacy_m2_qa_reference';
  sourceId: string;
  characterId: string;
  characterName: string;
  bucket: string;
  objectPath: string;
  mimeType: string;
  imageBuffer: Buffer;
}

interface RealBenchmarkCaseResult {
  caseId: string;
  category: string;
  durationSeconds: number;
  status: 'evaluated' | 'provider_failed' | 'qa_failed';
  retried: boolean;
  providerAttempts: number;
  firstAttemptReport?: MvpIdentityQaReport;
  finalReport?: MvpIdentityQaReport;
  error?: string;
}

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function normalizedName(value: unknown): string { return String(value || '').toLowerCase().replace(/[\s_-]+/g, ''); }
function isMeiNing(value: unknown): boolean {
  const raw = String(value || '');
  const normalized = normalizedName(value);
  return raw.includes('梅凝') || normalized.includes('meining');
}

async function getAccessToken(): Promise<string> {
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  const token = typeof result === 'string' ? result : result?.token;
  if (!token) throw new Error('Runtime ADC did not return an access token.');
  return token;
}

function submitEndpoint() {
  return `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${MVP_VIDEO_MODEL}:predictLongRunning`;
}
function pollEndpoint() {
  return `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${MVP_VIDEO_MODEL}:fetchPredictOperation`;
}
function casePrefix(caseId: string, attempt: number) {
  return `benchmarks/${BENCHMARK_VERSION}/runs/${RUN_ID}/${caseId}/provider/attempt-${attempt}/`;
}
function caseStorageUri(caseId: string, attempt: number) {
  return `gs://${OUTPUT_BUCKET}/${casePrefix(caseId, attempt)}`;
}

class ProviderError extends Error {
  constructor(message: string, public status: number | null = null, public providerStatus: string | null = null) { super(message); }
}

async function submit(caseItem: IdentityBenchmarkCase, reference: ReferenceSource, attempt: number): Promise<string> {
  const prompt = buildIdentitySafePrompt(caseItem.prompt, attempt === 2);
  const delays = [2_000, 4_000];
  for (let retry = 0; retry <= delays.length; retry++) {
    const token = await getAccessToken();
    const response = await fetch(submitEndpoint(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{
          prompt,
          image: { bytesBase64Encoded: reference.imageBuffer.toString('base64'), mimeType: reference.mimeType },
        }],
        parameters: {
          sampleCount: 1,
          aspectRatio: '9:16',
          durationSeconds: caseItem.durationSeconds,
          resolution: '1080p',
          personGeneration: 'allow_adult',
          generateAudio: false,
          storageUri: caseStorageUri(caseItem.id, attempt),
        },
      }),
    });
    const raw = await response.text();
    let json: any = null;
    try { json = JSON.parse(raw); } catch {}
    if (response.ok && typeof json?.name === 'string') return json.name;
    const providerStatus = json?.error?.status || null;
    if ((response.status === 429 || providerStatus === 'RESOURCE_EXHAUSTED') && retry < delays.length) {
      await sleep(delays[retry]);
      continue;
    }
    throw new ProviderError(redactSecrets(json?.error?.message || raw || `HTTP ${response.status}`), response.status, providerStatus);
  }
  throw new Error('Unreachable submit state.');
}

async function pollUntilDone(operationName: string): Promise<any> {
  const started = Date.now();
  while (Date.now() - started < MAX_CASE_MS) {
    const token = await getAccessToken();
    const response = await fetch(pollEndpoint(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationName }),
    });
    const raw = await response.text();
    let json: any = null;
    try { json = JSON.parse(raw); } catch {}
    if (!response.ok) throw new ProviderError(redactSecrets(json?.error?.message || raw || `HTTP ${response.status}`), response.status, json?.error?.status || null);
    if (json?.done) return json;
    await sleep(POLL_MS);
  }
  throw new Error(`GENERATION_TIMEOUT: ${operationName}`);
}

async function exactDownload(bucket: string, objectPath: string): Promise<Buffer> {
  const [bytes] = await storage.bucket(bucket).file(objectPath).download();
  return Buffer.from(bytes);
}

function parseGcsLocation(defaultBucket: string, value: string): { bucket: string; objectPath: string } {
  const raw = String(value || '').trim();
  if (raw.startsWith('gs://')) {
    const without = raw.slice(5);
    const slash = without.indexOf('/');
    if (slash <= 0) throw new Error(`Invalid GCS URI: ${raw}`);
    return { bucket: without.slice(0, slash), objectPath: without.slice(slash + 1) };
  }
  return { bucket: defaultBucket, objectPath: raw.replace(/^\/+/, '') };
}

async function loadReference(params: Omit<ReferenceSource, 'imageBuffer'>): Promise<ReferenceSource | null> {
  try {
    if (!params.bucket || !params.objectPath) return null;
    const location = parseGcsLocation(params.bucket, params.objectPath);
    const imageBuffer = await exactDownload(location.bucket, location.objectPath);
    if (imageBuffer.length < 1000) return null;
    return { ...params, bucket: location.bucket, objectPath: location.objectPath, imageBuffer };
  } catch (error: any) {
    console.warn(`[Benchmark] reference candidate unavailable source=${params.source} id=${params.sourceId}: ${redactSecrets(error?.message || String(error))}`);
    return null;
  }
}

async function findCharacterLibraryReference(db: any): Promise<ReferenceSource | null> {
  const snapshot = await db.collection('characters').get();
  const matches: any[] = [];
  snapshot.forEach((doc: any) => {
    const data: any = doc.data();
    if (isMeiNing(data?.name)) matches.push({ id: doc.id, ...data });
  });
  matches.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  for (const character of matches) {
    const refs = Array.isArray(character.referenceImages) ? [...character.referenceImages] : [];
    refs.sort((a: any, b: any) => {
      const frontA = /front|frontal|正脸/i.test(String(a?.angle || '')) ? 0 : 1;
      const frontB = /front|frontal|正脸/i.test(String(b?.angle || '')) ? 0 : 1;
      return frontA - frontB || Number(a?.sortOrder || 0) - Number(b?.sortOrder || 0);
    });
    for (const ref of refs) {
      if (!ref?.outputBucket || !ref?.outputObjectPath) continue;
      const loaded = await loadReference({
        source: 'character_library',
        sourceId: character.id,
        characterId: character.id,
        characterName: String(character.name || '梅凝'),
        bucket: String(ref.outputBucket),
        objectPath: String(ref.outputObjectPath),
        mimeType: String(ref.mimeType || 'image/jpeg'),
      });
      if (loaded) return loaded;
    }
  }
  return null;
}

async function findMvpConfirmedInputReference(db: any): Promise<ReferenceSource | null> {
  let snapshot: any;
  try {
    snapshot = await db.collection('mvp_video_tasks').orderBy('createdAt', 'desc').limit(100).get();
  } catch {
    snapshot = await db.collection('mvp_video_tasks').limit(100).get();
  }
  const candidates: any[] = [];
  snapshot.forEach((doc: any) => {
    const data = doc.data() as any;
    if (data?.identitySafeMode === true && data?.inputBucket && data?.inputObjectPath) {
      candidates.push({ id: doc.id, ...data });
    }
  });
  candidates.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  for (const task of candidates) {
    const loaded = await loadReference({
      source: 'mvp_manually_confirmed_input',
      sourceId: task.id,
      characterId: 'mvp-manually-confirmed-meining',
      characterName: '梅凝 (MVP 人工确认输入)',
      bucket: String(task.inputBucket),
      objectPath: String(task.inputObjectPath),
      mimeType: String(task.inputMimeType || 'image/jpeg'),
    });
    if (loaded) return loaded;
  }
  return null;
}

async function findLegacyM2Reference(db: any): Promise<ReferenceSource | null> {
  let snapshot: any;
  try {
    snapshot = await db.collection('video_tasks').orderBy('updatedAt', 'desc').limit(200).get();
  } catch {
    snapshot = await db.collection('video_tasks').limit(200).get();
  }
  const candidates: any[] = [];
  snapshot.forEach((doc: any) => {
    const data = doc.data() as any;
    const explicitMeiNing = isMeiNing(data?.characterName) || isMeiNing(data?.characterDescription);
    if (!explicitMeiNing) return;
    const approvedFirstFrame = String(data?.qaApprovedFirstFrameObjectPath || '');
    const masterPaths = Array.isArray(data?.qaMasterImageObjectPaths) ? data.qaMasterImageObjectPaths.filter(Boolean) : [];
    if (!approvedFirstFrame && !masterPaths.length) return;
    candidates.push({ id: doc.id, ...data, _approvedFirstFrame: approvedFirstFrame, _masterPaths: masterPaths });
  });
  candidates.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));

  for (const task of candidates) {
    const paths = [task._approvedFirstFrame, ...task._masterPaths].filter(Boolean);
    for (const path of paths) {
      const loaded = await loadReference({
        source: 'legacy_m2_qa_reference',
        sourceId: task.id,
        characterId: String(task.characterId || 'legacy-meining'),
        characterName: String(task.characterName || '梅凝'),
        bucket: String(task.outputBucket || OUTPUT_BUCKET),
        objectPath: String(path),
        mimeType: String(task.qaApprovedFirstFrameMimeType || task.qaMasterImageMimeTypes?.[0] || 'image/jpeg'),
      });
      if (loaded) return loaded;
    }
  }
  return null;
}

async function findMeiNingReference(): Promise<ReferenceSource> {
  const db = getFirestoreInstance();
  if (!db) throw new Error('BENCHMARK_REFERENCE_NOT_FOUND: Firestore unavailable.');

  const characterReference = await findCharacterLibraryReference(db);
  if (characterReference) return characterReference;

  const mvpReference = await findMvpConfirmedInputReference(db);
  if (mvpReference) return mvpReference;

  const legacyReference = await findLegacyM2Reference(db);
  if (legacyReference) return legacyReference;

  throw new Error('BENCHMARK_REFERENCE_NOT_FOUND: no durable MeiNing reference found in characters, mvp_video_tasks, or explicitly named legacy video_tasks.');
}

async function fetchVideo(caseItem: IdentityBenchmarkCase, attempt: number, operation: any): Promise<Buffer> {
  if (operation?.error) throw new ProviderError(redactSecrets(JSON.stringify(operation.error)), operation.error?.code || null, operation.error?.status || null);
  const body = operation.response || operation;
  const safety = VideoGenerator.checkSafetyBlock(body);
  if (safety.isBlocked) throw new ProviderError(`SAFETY_REJECTED: ${safety.reason || 'filtered'}`);
  const extracted = VideoGenerator.extractVideoData(body);
  if (extracted.base64) {
    const buffer = Buffer.from(extracted.base64, 'base64');
    if (VideoGenerator.isMp4Valid(buffer)) return buffer;
  }
  if (extracted.uri) {
    if (extracted.uri.startsWith('gs://')) {
      const location = parseGcsLocation(OUTPUT_BUCKET, extracted.uri);
      const buffer = await exactDownload(location.bucket, location.objectPath);
      if (VideoGenerator.isMp4Valid(buffer)) return buffer;
    }
    const token = await getAccessToken();
    const buffer = await VideoGenerator.fetchGcsVideoBuffer(extracted.uri, token);
    if (VideoGenerator.isMp4Valid(buffer)) return buffer;
  }
  const [files] = await storage.bucket(OUTPUT_BUCKET).getFiles({ prefix: casePrefix(caseItem.id, attempt) });
  const mp4s = files.filter((file) => file.name.toLowerCase().endsWith('.mp4'));
  for (const file of mp4s) {
    const [meta] = await file.getMetadata();
    if (Number(meta.size || 0) < 1000) continue;
    const buffer = await exactDownload(OUTPUT_BUCKET, file.name);
    if (VideoGenerator.isMp4Valid(buffer)) return buffer;
  }
  throw new Error(`OUTPUT_MISSING: ${caseItem.id} attempt-${attempt}`);
}

async function inspectAndQa(reference: ReferenceSource, video: Buffer): Promise<MvpIdentityQaReport> {
  const inspection = await VideoInspector.inspectAndExtractFrames(video);
  if (!inspection.valid || inspection.extractedFrames.length < 5) {
    throw new Error(`FRAME_EXTRACTION_FAILED: ${inspection.issueReason || inspection.extractedFrames.length}`);
  }
  return qaVideoIdentityAgainstInput({
    projectId: PROJECT_ID,
    location: REGION,
    model: IDENTITY_QA_MODEL,
    referenceImage: reference.imageBuffer,
    referenceMimeType: reference.mimeType,
    frames: inspection.extractedFrames,
  });
}

async function runCase(caseItem: IdentityBenchmarkCase, reference: ReferenceSource): Promise<RealBenchmarkCaseResult> {
  console.log(`[Benchmark] ${caseItem.id} start (${caseItem.durationSeconds}s / ${caseItem.category})`);
  let firstReport: MvpIdentityQaReport | undefined;
  try {
    const op1 = await submit(caseItem, reference, 1);
    const done1 = await pollUntilDone(op1);
    const video1 = await fetchVideo(caseItem, 1, done1);
    firstReport = await inspectAndQa(reference, video1);
    if (firstReport.pass) {
      console.log(`[Benchmark] ${caseItem.id} PASS attempt-1 mean=${firstReport.meanFaceSimilarityScore} min=${firstReport.minimumFaceSimilarityScore}`);
      return { caseId: caseItem.id, category: caseItem.category, durationSeconds: caseItem.durationSeconds, status: 'evaluated', retried: false, providerAttempts: 1, firstAttemptReport: firstReport, finalReport: firstReport };
    }

    console.log(`[Benchmark] ${caseItem.id} drift attempt-1; conservative retry`);
    try {
      const op2 = await submit(caseItem, reference, 2);
      const done2 = await pollUntilDone(op2);
      const video2 = await fetchVideo(caseItem, 2, done2);
      const finalReport = await inspectAndQa(reference, video2);
      console.log(`[Benchmark] ${caseItem.id} ${finalReport.pass ? 'PASS' : 'FAIL'} attempt-2 mean=${finalReport.meanFaceSimilarityScore} min=${finalReport.minimumFaceSimilarityScore}`);
      return { caseId: caseItem.id, category: caseItem.category, durationSeconds: caseItem.durationSeconds, status: 'evaluated', retried: true, providerAttempts: 2, firstAttemptReport: firstReport, finalReport };
    } catch (error: any) {
      const message = redactSecrets(error?.message || String(error));
      console.error(`[Benchmark] ${caseItem.id} attempt-2 provider/QA failure: ${message}`);
      return { caseId: caseItem.id, category: caseItem.category, durationSeconds: caseItem.durationSeconds, status: 'evaluated', retried: true, providerAttempts: 2, firstAttemptReport: firstReport, finalReport: firstReport, error: `RETRY_EXECUTION_FAILED: ${message}` };
    }
  } catch (error: any) {
    const message = redactSecrets(error?.message || String(error));
    console.error(`[Benchmark] ${caseItem.id} first attempt failed before identity evaluation: ${message}`);
    return { caseId: caseItem.id, category: caseItem.category, durationSeconds: caseItem.durationSeconds, status: firstReport ? 'qa_failed' : 'provider_failed', retried: false, providerAttempts: 1, firstAttemptReport: firstReport, finalReport: firstReport, error: message };
  }
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
  return results;
}

function groupedSummary(results: RealBenchmarkCaseResult[]) {
  const output: Record<string, any> = {};
  for (const duration of [4, 6, 8]) {
    const group = results.filter((item) => item.durationSeconds === duration && item.finalReport);
    output[`${duration}s`] = {
      evaluated: group.length,
      firstPass: group.filter((item) => item.firstAttemptReport?.pass).length,
      finalPass: group.filter((item) => item.finalReport?.pass).length,
      retried: group.filter((item) => item.retried).length,
    };
  }
  return output;
}

async function persistResult(payload: any) {
  const cleanPayload = JSON.parse(JSON.stringify(payload));
  const json = Buffer.from(JSON.stringify(cleanPayload, null, 2));
  const runPath = `benchmarks/${BENCHMARK_VERSION}/results/${RUN_ID}.json`;
  const latestPath = `benchmarks/${BENCHMARK_VERSION}/latest.json`;
  await storage.bucket(OUTPUT_BUCKET).file(runPath).save(json, { resumable: false, metadata: { contentType: 'application/json' } });
  await storage.bucket(OUTPUT_BUCKET).file(latestPath).save(json, { resumable: false, metadata: { contentType: 'application/json' } });
  const db = getFirestoreInstance();
  if (db) {
    const summaryDoc = {
      benchmarkVersion: cleanPayload.benchmarkVersion,
      identitySafeVersion: cleanPayload.identitySafeVersion,
      runId: cleanPayload.runId,
      sourceSha: cleanPayload.sourceSha,
      projectId: cleanPayload.projectId,
      region: cleanPayload.region,
      videoModel: cleanPayload.videoModel,
      identityQaModel: cleanPayload.identityQaModel,
      reference: cleanPayload.reference,
      totalCases: cleanPayload.totalCases,
      providerFailedCases: cleanPayload.providerFailedCases,
      grouped: cleanPayload.grouped,
      summary: cleanPayload.summary,
      completedAt: cleanPayload.completedAt,
      resultUri: `gs://${OUTPUT_BUCKET}/${runPath}`,
    };
    await db.collection('mvp_identity_benchmarks').doc(RUN_ID).set(summaryDoc, { merge: false });
    await db.collection('mvp_identity_benchmarks').doc('latest').set(summaryDoc, { merge: false });
  }
  return { runPath, latestPath };
}

async function main() {
  if (!OUTPUT_BUCKET) throw new Error('VEO_OUTPUT_BUCKET is required.');
  console.log(`[Benchmark] runId=${RUN_ID} project=${PROJECT_ID} region=${REGION} database=${FIRESTORE_DATABASE_ID || 'default'} concurrency=${CONCURRENCY}`);
  const reference = await findMeiNingReference();
  console.log(`[Benchmark] referenceSource=${reference.source} sourceId=${reference.sourceId} character=${reference.characterName} (${reference.characterId}) gs://${reference.bucket}/${reference.objectPath}`);
  const results = await mapWithConcurrency(IDENTITY_STABILITY_BENCHMARK_V1, CONCURRENCY, (item) => runCase(item, reference));
  const eligible: IdentityBenchmarkResult[] = results
    .filter((item): item is RealBenchmarkCaseResult & { firstAttemptReport: MvpIdentityQaReport; finalReport: MvpIdentityQaReport } => Boolean(item.firstAttemptReport && item.finalReport))
    .map((item) => ({ caseId: item.caseId, firstAttemptReport: item.firstAttemptReport, finalReport: item.finalReport, retried: item.retried }));
  const summary = summarizeIdentityBenchmark(eligible);
  const payload = {
    benchmarkVersion: BENCHMARK_VERSION,
    identitySafeVersion: 'identity-safe-v0.2',
    runId: RUN_ID,
    sourceSha: process.env.SOURCE_SHA || null,
    projectId: PROJECT_ID,
    region: REGION,
    videoModel: MVP_VIDEO_MODEL,
    identityQaModel: IDENTITY_QA_MODEL,
    reference: {
      source: reference.source,
      sourceId: reference.sourceId,
      characterId: reference.characterId,
      characterName: reference.characterName,
      bucket: reference.bucket,
      objectPath: reference.objectPath,
      mimeType: reference.mimeType,
    },
    startedFromRealReference: true,
    totalCases: IDENTITY_STABILITY_BENCHMARK_V1.length,
    providerFailedCases: results.filter((item) => item.status === 'provider_failed').length,
    grouped: groupedSummary(results),
    summary,
    results,
    completedAt: new Date().toISOString(),
  };
  const paths = await persistResult(payload);
  console.log(`BENCHMARK_RESULT_GCS=gs://${OUTPUT_BUCKET}/${paths.runPath}`);
  console.log(`BENCHMARK_LATEST_GCS=gs://${OUTPUT_BUCKET}/${paths.latestPath}`);
  console.log(`BENCHMARK_SUMMARY_JSON=${JSON.stringify(summary)}`);
  if (summary.evaluatedCases < 20) {
    throw new Error(`BENCHMARK_INCOMPLETE: only ${summary.evaluatedCases}/24 cases produced identity-evaluable video.`);
  }
}

main().catch((error) => {
  console.error(`[Benchmark] FATAL ${redactSecrets(error?.stack || error?.message || String(error))}`);
  process.exitCode = 1;
});
