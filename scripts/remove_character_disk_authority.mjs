import fs from 'node:fs';

const filePath = 'server.ts';
let source = fs.readFileSync(filePath, 'utf8');
const legacy = '  const serverCharacterStore = loadCharactersFromDisk();';
const durableCache = '  const serverCharacterStore = new Map<string, ServerCharacter>();';

if (source.includes(durableCache)) {
  console.log('[character-disk-authority] already removed');
  process.exit(0);
}
if (!source.includes(legacy)) {
  throw new Error('[character-disk-authority] legacy serverCharacterStore initializer not found');
}
source = source.replace(legacy, durableCache);
fs.writeFileSync(filePath, source);
console.log('[character-disk-authority] local disk removed as startup authority');
