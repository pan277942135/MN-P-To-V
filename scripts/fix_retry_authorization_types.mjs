import fs from 'node:fs';

const path = 'src/server/services/taskStateMachineService.ts';
let source = fs.readFileSync(path, 'utf8');
const anchor = `  public async reconcileStaleAutomaticRetryReservation(params: {\n    taskId: string;\n    now?: number;\n    staleAfterMs?: number;\n  }): Promise<{ reclaimed: boolean; task: ServerVideoTaskRecord }> {\n    const { taskId, now = Date.now(), staleAfterMs = 180000 } = params;\n    return await firestoreTaskRepository.runTaskTransaction(taskId, (currentTask) => {`;
const replacement = `  public async reconcileStaleAutomaticRetryReservation(params: {\n    taskId: string;\n    now?: number;\n    staleAfterMs?: number;\n  }): Promise<{ reclaimed: boolean; task: ServerVideoTaskRecord }> {\n    const { taskId, now = Date.now(), staleAfterMs = 180000 } = params;\n    return await firestoreTaskRepository.runTaskTransaction<{ reclaimed: boolean; task: ServerVideoTaskRecord }>(taskId, (currentTask) => {`;
if (!source.includes(anchor)) throw new Error('retry reconciliation typing anchor not found');
source = source.replace(anchor, replacement);
fs.writeFileSync(path, source);
console.log('Fixed retry reconciliation transaction generic.');
