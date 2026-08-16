import fs from 'node:fs';

const path = 'src/__tests__/providerStorageIntentSourceContract.test.ts';
let source = fs.readFileSync(path, 'utf8');
const old = `    expect(retry).toContain('M2_4_RETRY_STORAGE_INTENT_MISMATCH');\n    expect(retry).toContain('task.expectedProviderStorageUri !== derivedStorageUri');\n    expect(retry).toContain('task.expectedProviderStorageUri\\n    );');`;
const replacement = `    expect(retry).toContain('M2_4_RETRY_STORAGE_INTENT_MISMATCH');\n    expect(retry).toContain('task.expectedProviderStorageUri !== derivedStorageUri');\n    expect(retry).toContain('expectedStorageUri: task.expectedProviderStorageUri');\n    expect(retry).toContain('prepared.expectedStorageUri !== task.expectedProviderStorageUri');\n    expect(retry).toContain('prepared.expectedStorageUri\\n    );');`;
if (!source.includes(old)) throw new Error('provider storage intent source-contract anchor not found');
source = source.replace(old, replacement);
fs.writeFileSync(path, source);
console.log('Aligned provider storage intent source contract with prepared retry flow.');
