from pathlib import Path


def replace_once(src: str, label: str, before: str, after: str) -> str:
    count = src.count(before)
    if count != 1:
        raise RuntimeError(f'[p0-5 test patch] {label}: expected exactly 1 match, found {count}')
    return src.replace(before, after, 1)


# 1) Old Firestore fixtures must obey the already-certified completed => GCS invariant.
firestore_path = Path('src/__tests__/firestoreTaskRepository.test.ts')
firestore_src = firestore_path.read_text(encoding='utf-8')
if "outputObjectPath: 'veo/t2/video.mp4'" not in firestore_src:
    firestore_src = replace_once(
        firestore_src,
        'list completed fixture',
        """      durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', generateAudio: false, pollAttempt: 2,\n      createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000""",
        """      durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', generateAudio: false, pollAttempt: 2,\n      artifactPersisted: true, outputBucket: 'ai-studio-bucket-89614354864-asia-south1',\n      outputObjectPath: 'veo/t2/video.mp4', videoUri: 'gs://ai-studio-bucket-89614354864-asia-south1/veo/t2/video.mp4',\n      createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000""",
    )

if "outputObjectPath: 'veo/task_completed/video.mp4'" not in firestore_src:
    firestore_src = replace_once(
        firestore_src,
        'operationName completed fixture',
        """      resolution: '720p', generateAudio: false, pollAttempt: 3, videoDataUrl: 'data:video/mp4;base64,aaa',\n      createdAt: Date.now() - 5000, updatedAt: Date.now(), completedAt: Date.now()""",
        """      resolution: '720p', generateAudio: false, pollAttempt: 3, videoDataUrl: '/api/videos/stream/task_completed',\n      artifactPersisted: true, outputBucket: 'ai-studio-bucket-89614354864-asia-south1',\n      outputObjectPath: 'veo/task_completed/video.mp4', videoUri: 'gs://ai-studio-bucket-89614354864-asia-south1/veo/task_completed/video.mp4',\n      createdAt: Date.now() - 5000, updatedAt: Date.now(), completedAt: Date.now()""",
    )
firestore_path.write_text(firestore_src, encoding='utf-8')


# 2) This route suite tests identity-gate/provider-call behavior, not Firestore transaction
# internals. Inject the durable-state boundary so production can require a lease without
# turning this unrelated integration test into a Firestore emulator test.
route_path = Path('src/__tests__/apiVideoStartRouteIntegration.test.ts')
route_src = route_path.read_text(encoding='utf-8')

if "taskStateMachineService } from '../server/services/taskStateMachineService'" not in route_src:
    route_src = replace_once(
        route_src,
        'state machine import',
        "import { firestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';",
        "import { firestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';\nimport { taskStateMachineService } from '../server/services/taskStateMachineService';",
    )

if 'let mockDurableTask: any = null;' not in route_src:
    route_src = replace_once(
        route_src,
        'durable task fixture variable',
        """  let app: Express;\n  let originalEnvBucket: string | undefined;""",
        """  let app: Express;\n  let originalEnvBucket: string | undefined;\n  let mockDurableTask: any = null;""",
    )

marker = '// Mock the durable execution boundary used by the production route.'
if marker not in route_src:
    route_src = replace_once(
        route_src,
        'durable route mocks',
        """    // Mock Firestore repository for integration tests\n    vi.spyOn(firestoreTaskRepository, 'isAvailable').mockReturnValue(true);\n    vi.spyOn(firestoreTaskRepository, 'createTask').mockImplementation(async (task: any) => task);""",
        """    // Mock Firestore repository for integration tests\n    mockDurableTask = null;\n    vi.spyOn(firestoreTaskRepository, 'isAvailable').mockReturnValue(true);\n    vi.spyOn(firestoreTaskRepository, 'createTask').mockImplementation(async (task: any) => {\n      mockDurableTask = { ...task };\n    });\n    vi.spyOn(firestoreTaskRepository, 'getTask').mockImplementation(async () => mockDurableTask);\n    vi.spyOn(firestoreTaskRepository, 'updateTask').mockImplementation(async (taskId: string, patch: any) => {\n      mockDurableTask = { ...(mockDurableTask || { id: taskId, taskId }), ...patch, id: taskId, taskId };\n      return mockDurableTask;\n    });\n\n    // Mock the durable execution boundary used by the production route.\n    vi.spyOn(taskStateMachineService, 'acquireLease').mockImplementation(async ({ taskId, leaseOwner }: any) => {\n      const now = Date.now();\n      mockDurableTask = {\n        ...(mockDurableTask || { id: taskId, taskId, status: 'submitting' }),\n        executionId: 'exec_route_test',\n        leaseOwner,\n        leaseExpiresAt: now + 180000,\n        stateVersion: 2,\n        statusVersion: 2,\n      };\n      return { acquired: true, reason: 'acquired', executionId: 'exec_route_test', task: mockDurableTask };\n    });\n    vi.spyOn(taskStateMachineService, 'transitionTask').mockImplementation(async ({ taskId, toStatus, patch }: any) => {\n      mockDurableTask = {\n        ...(mockDurableTask || { id: taskId, taskId }),\n        ...(patch || {}),\n        id: taskId,\n        taskId,\n        status: toStatus,\n        stateVersion: (mockDurableTask?.stateVersion || 1) + 1,\n      };\n      mockDurableTask.statusVersion = mockDurableTask.stateVersion;\n      return mockDurableTask;\n    });\n    vi.spyOn(taskStateMachineService, 'releaseLease').mockImplementation(async () => {\n      if (mockDurableTask) mockDurableTask.leaseExpiresAt = 0;\n      return true;\n    });""",
    )

route_path.write_text(route_src, encoding='utf-8')
print('[p0-5 test patch] test hardening applied successfully')
