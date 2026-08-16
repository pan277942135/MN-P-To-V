import fs from 'node:fs';

const path = 'server.ts';
let source = fs.readFileSync(path, 'utf8');
const marker = `      if (\n        record.status === 'generating' &&\n        record.retrySubmissionState === 'reserved' &&\n        !record.operationName\n      ) {`;
const replacement = `      if (\n        record.status === 'generating' &&\n        record.retrySubmissionState === 'reserved' &&\n        !record.operationName\n      ) {\n        const reconciled = await taskStateMachineService.reconcileStaleAutomaticRetryReservation({ taskId });\n        record = reconciled.task;\n        serverVideoTaskStore.set(taskId, record);\n        if (reconciled.reclaimed) {\n          return res.json({\n            status: record.status,\n            submissionState: 'not_submitted',\n            providerInvocationAuthorized: false,\n            failureReason: record.failureReason,\n            retryMode: record.retryMode,\n            error: record.error,\n            structuredError: record.structuredError,\n          });\n        }\n      }\n\n      if (\n        record.status === 'generating' &&\n        !record.operationName &&\n        record.retryProviderAuthorizedAt &&\n        record.retryProviderAuthorizedIdempotencyKey === record.providerRetryIdempotencyKey\n      ) {\n        const authorizedAgeMs = Date.now() - record.retryProviderAuthorizedAt;\n        if (authorizedAgeMs > 180000) {\n          const unknown = await taskStateMachineService.markAutomaticRetryOutcomeUnknown({\n            taskId,\n            idempotencyKey: record.providerRetryIdempotencyKey || 'missing',\n            message: 'AUTOMATIC_RETRY_AUTHORIZATION_STALE: retry crossed the durable Provider authorization boundary but no submission result was persisted; refusing automatic resubmission.',\n          });\n          return res.json({\n            status: unknown.status,\n            error: unknown.error,\n            structuredError: unknown.structuredError,\n            failureReason: unknown.failureReason,\n            retryMode: unknown.retryMode,\n          });\n        }\n      }`;

function findBlockEnd(text, start) {
  const braceStart = text.indexOf('{', start);
  if (braceStart < 0) throw new Error('opening brace not found');
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('closing brace not found');
}

let count = 0;
let cursor = 0;
while (true) {
  const start = source.indexOf(marker, cursor);
  if (start < 0) break;
  const markerEnd = findBlockEnd(source, start);
  const block = source.slice(start, markerEnd);
  if (!block.includes('AUTOMATIC_RETRY_RESERVATION_STALE')) {
    cursor = markerEnd;
    continue;
  }
  source = source.slice(0, start) + replacement + source.slice(markerEnd);
  cursor = start + replacement.length;
  count++;
}

if (count < 1) throw new Error(`expected at least one stale retry reservation block, found ${count}`);
fs.writeFileSync(path, source);
console.log(`Replaced ${count} stale retry reservation block(s) structurally.`);
