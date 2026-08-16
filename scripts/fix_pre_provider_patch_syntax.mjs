import fs from 'node:fs';

const path = 'scripts/apply_pre_provider_boundary_patch.mjs';
let source = fs.readFileSync(path, 'utf8');
const bad = "expect(server).toContain('const initialExecutionId = `exec_${crypto.randomUUID()}`');";
const good = "expect(server).toContain('const initialExecutionId = \\x60exec_\\${crypto.randomUUID()}\\x60');";
if (!source.includes(bad)) {
  throw new Error('Expected unescaped source-contract line was not found.');
}
source = source.replace(bad, good);
fs.writeFileSync(path, source);
console.log('Fixed pre-provider patch template escaping.');
