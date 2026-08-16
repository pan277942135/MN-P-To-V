import fs from 'node:fs';

const path = 'src/__tests__/preProviderDurabilityBoundary.test.ts';
let source = fs.readFileSync(path, 'utf8');

source = source.replace(
  "import { MockFirestore } from './helpers/mockFirestore';\n",
  `\nclass MockCollection {\n  docs = new Map<string, any>();\n  doc(id: string) {\n    return {\n      get: async () => {\n        const data = this.docs.get(id);\n        return { exists: data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };\n      },\n      set: async (data: any) => this.docs.set(id, structuredClone(data)),\n      update: async (patch: any) => this.docs.set(id, { ...(this.docs.get(id) || {}), ...structuredClone(patch) }),\n      delete: async () => this.docs.delete(id),\n    };\n  }\n  orderBy() { return this; }\n  limit() { return this; }\n  get = async () => [];\n}\n\nclass MockFirestore {\n  collections = new Map<string, MockCollection>();\n  collection(name: string) {\n    if (!this.collections.has(name)) this.collections.set(name, new MockCollection());\n    return this.collections.get(name)!;\n  }\n  runTransaction = async (fn: any) => fn({\n    get: async (ref: any) => ref.get(),\n    set: (ref: any, data: any) => ref.set(data),\n    update: (ref: any, patch: any) => ref.update(patch),\n    delete: (ref: any) => ref.delete(),\n  });\n}\n`
);

source = source.replace(
  "projectId: 'pre-provider-test', region: 'us-central1',",
  "projectId: `pre-provider-test-${id}`, region: 'us-central1',"
);
source = source.replace(
  "    await firestoreTaskRepository.updateTask(fresh.taskId, { projectId: 'pre-provider-test-2' });\n",
  ''
);

if (source.includes("./helpers/mockFirestore")) {
  throw new Error('MockFirestore helper import was not removed.');
}
if (!source.includes('class MockFirestore')) {
  throw new Error('Inline MockFirestore was not inserted.');
}
if (!source.includes('pre-provider-test-${id}')) {
  throw new Error('Per-task project admission scope was not inserted.');
}
fs.writeFileSync(path, source);
console.log('Refined pre-provider boundary test fixtures.');
