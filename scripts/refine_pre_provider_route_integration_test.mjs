import fs from 'node:fs';

const path = 'src/__tests__/apiVideoStartRouteIntegration.test.ts';
let source = fs.readFileSync(path, 'utf8');

const oldBlock = `    // Mock the durable execution boundary used by the production route.\n    vi.spyOn(taskStateMachineService, 'acquireLease').mockImplementation(async ({ taskId, leaseOwner }: any) => {\n      const now = Date.now();\n      mockDurableTask = {\n        ...(mockDurableTask || { id: taskId, taskId, status: 'submitting' }),\n        executionId: 'exec_route_test',\n        leaseOwner,\n        leaseExpiresAt: now + 180000,\n        stateVersion: 2,\n        statusVersion: 2,\n      };\n      return { acquired: true, reason: 'acquired', executionId: 'exec_route_test', task: mockDurableTask };\n    });\n`;

const newBlock = `    // Mock Firestore transactions, not Provider authorization itself. Successful route\n    // cases must prove the durable preparing -> submitting transaction can commit before\n    // predictLongRunning is allowed to execute.\n    vi.spyOn(firestoreTaskRepository, 'runTaskTransaction').mockImplementation(async (taskId: string, mutator: any) => {\n      const outcome = await mutator(mockDurableTask);\n      if (outcome?.taskPatch) {\n        mockDurableTask = {\n          ...(mockDurableTask || { id: taskId, taskId }),\n          ...outcome.taskPatch,\n          id: taskId,\n          taskId,\n        };\n      }\n      return outcome?.result;\n    });\n`;

if (!source.includes(oldBlock)) {
  throw new Error('Legacy acquireLease integration mock block not found.');
}
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(path, source);
console.log('Upgraded /api/videos/start integration test to mock durable Firestore transactions.');
