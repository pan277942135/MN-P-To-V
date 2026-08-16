import fs from 'node:fs';

const path = 'scripts/apply_retry_provider_authorization_patch.mjs';
let source = fs.readFileSync(path, 'utf8');
const oldLine = 'replaceAtLeastOnce(serverPath, oldStaleBlock, newStaleBlock);';
if (!source.includes(oldLine)) throw new Error('Expected stale-block patch call not found.');
const replacement = `const serverSourceForStaleRetry = fs.readFileSync(serverPath, 'utf8');
const staleRetryPattern = /      if \\(\\n        record\\.status === 'generating' &&\\n        record\\.retrySubmissionState === 'reserved' &&\\n        !record\\.operationName\\n      \\) \\{\\n        const reservedAgeMs = Date\\.now\\(\\) - \\(record\\.retryReservedAt \\|\\| record\\.updatedAt \\|\\| Date\\.now\\(\\)\\);[\\s\\S]*?AUTOMATIC_RETRY_RESERVATION_STALE:[\\s\\S]*?\\n        \\}\\n      \\}/g;
const staleMatches = serverSourceForStaleRetry.match(staleRetryPattern) || [];
if (staleMatches.length < 1) throw new Error(\\`server.ts: expected at least one stale retry reservation block, found \\${staleMatches.length}\\`);
fs.writeFileSync(serverPath, serverSourceForStaleRetry.replace(staleRetryPattern, newStaleBlock));`;
source = source.replace(oldLine, replacement);
fs.writeFileSync(path, source);
console.log('Refined stale retry reservation patch to structural regex matching.');
