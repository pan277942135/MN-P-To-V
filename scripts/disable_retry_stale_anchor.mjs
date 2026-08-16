import fs from 'node:fs';

const path = 'scripts/apply_retry_provider_authorization_patch.mjs';
let source = fs.readFileSync(path, 'utf8');
const target = 'replaceAtLeastOnce(serverPath, oldStaleBlock, newStaleBlock);';
if (!source.includes(target)) throw new Error('stale retry anchor call not found');
source = source.replace(target, '// stale retry server block is applied separately');
fs.writeFileSync(path, source);
console.log('Disabled brittle stale retry anchor in primary patch.');
