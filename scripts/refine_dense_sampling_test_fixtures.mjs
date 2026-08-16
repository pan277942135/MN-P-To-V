import fs from 'node:fs';

function addManifest(path, anchor, timestampsSec, maximumGapSec) {
  let source = fs.readFileSync(path, 'utf8');
  if (!source.includes(anchor)) throw new Error(`${path}: fixture anchor not found`);
  const manifest = `    samplingManifest: {\n      version: 'fixture',\n      sampleCount: ${timestampsSec.length},\n      timestampsSec: [${timestampsSec.join(', ')}],\n      firstTimestampSec: ${timestampsSec[0]},\n      lastTimestampSec: ${timestampsSec[timestampsSec.length - 1]},\n      maximumGapSec: ${maximumGapSec},\n    },\n`;
  source = source.replace(anchor, `${anchor}${manifest}`);
  fs.writeFileSync(path, source);
}

addManifest(
  'src/__tests__/m23FailureDiagnosis.test.ts',
  `    identityDriftSegments: [\n      { startTimestampSec: 2, endTimestampSec: 2, minimumIdentityScore: 85, severity: 'review' },\n    ],\n`,
  [0, 2],
  2
);

addManifest(
  'src/__tests__/m24VideoRetryPolicy.test.ts',
  `    identityDriftSegments: [\n      { startTimestampSec: 2, endTimestampSec: 2, minimumIdentityScore: 82, severity: 'review' },\n    ],\n`,
  [0, 2],
  2
);

console.log('Aligned legacy QA fixtures with required samplingManifest evidence.');
