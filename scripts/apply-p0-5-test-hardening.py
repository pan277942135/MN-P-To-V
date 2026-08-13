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


# 3) State-machine lifecycle/recovery tests must provide a real mock-GCS artifact before
# crossing the artifact_persisted/completed boundary.
durable_path = Path('src/__tests__/p0DurableStateMachine.test.ts')
durable_src = durable_path.read_text(encoding='utf-8')
if 'const lifecycleArtifact = await gcsArtifactStore.uploadVideoArtifact' not in durable_src:
    durable_src = replace_once(
        durable_src,
        'lifecycle artifact persistence',
        """    // artifact_persisting -> artifact_persisted\n    updated = await taskStateMachineService.transitionTask({ taskId, toStatus: 'artifact_persisted' });""",
        """    // artifact_persisting -> artifact_persisted only after authoritative artifact persistence\n    const lifecycleArtifact = await gcsArtifactStore.uploadVideoArtifact({\n      taskId,\n      videoBuffer: Buffer.concat([\n        Buffer.from('000000206674797069736f6d0000020069736f6d69736f3261766331', 'hex'),\n        Buffer.alloc(2000, 1),\n      ]),\n    });\n    updated = await taskStateMachineService.transitionTask({\n      taskId,\n      toStatus: 'artifact_persisted',\n      patch: {\n        artifactPersisted: true,\n        outputBucket: lifecycleArtifact.outputBucket,\n        outputObjectPath: lifecycleArtifact.outputObjectPath,\n        videoUri: lifecycleArtifact.videoUri,\n        sizeBytes: lifecycleArtifact.sizeBytes,\n        artifactPersistedAt: lifecycleArtifact.artifactPersistedAt,\n      },\n    });""",
    )

if 'const generationSucceededArtifact = await gcsArtifactStore.uploadVideoArtifact' not in durable_src:
    durable_src = replace_once(
        durable_src,
        'generation_succeeded authoritative recovery fixture',
        """      outputObjectPath: objectPath,\n      modelId: 'veo-3.1-fast-generate-001',\n      projectId: 'test-project',\n      region: 'us-central1',\n      durationSeconds: 4,\n      aspectRatio: '9:16',\n      resolution: '720p',\n      generateAudio: false,\n      pollAttempt: 0,\n      createdAt: Date.now() - 60000,\n      updatedAt: Date.now() - 30000,\n    };\n\n    await firestoreTaskRepository.createTask(task);\n\n    const recoveryRes = await taskStateMachineService.recoverAbandonedTasks();""",
        """      outputObjectPath: objectPath,\n      modelId: 'veo-3.1-fast-generate-001',\n      projectId: 'test-project',\n      region: 'us-central1',\n      durationSeconds: 4,\n      aspectRatio: '9:16',\n      resolution: '720p',\n      generateAudio: false,\n      pollAttempt: 0,\n      createdAt: Date.now() - 60000,\n      updatedAt: Date.now() - 30000,\n    };\n\n    const generationSucceededArtifact = await gcsArtifactStore.uploadVideoArtifact({\n      taskId,\n      videoBuffer: Buffer.concat([\n        Buffer.from('000000206674797069736f6d0000020069736f6d69736f3261766331', 'hex'),\n        Buffer.alloc(2000, 2),\n      ]),\n    });\n    expect(generationSucceededArtifact.outputBucket).toBe(bucket);\n    expect(generationSucceededArtifact.outputObjectPath).toBe(objectPath);\n\n    await firestoreTaskRepository.createTask(task);\n\n    const recoveryRes = await taskStateMachineService.recoverAbandonedTasks();""",
    )
durable_path.write_text(durable_src, encoding='utf-8')


# 4) P0-2R is an integration-style authority suite. It must explicitly install a mock
# Firestore authority instead of accidentally depending on another test file's global state.
storage_path = Path('src/__tests__/p0StorageAuthorityRegression.test.ts')
storage_src = storage_path.read_text(encoding='utf-8')
if "setFirestoreInstanceForTesting" not in storage_src:
    storage_src = replace_once(
        storage_src,
        'storage regression firestore import',
        "import { firestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';",
        "import { firestoreTaskRepository } from '../server/repositories/firestoreTaskRepository';\nimport { setFirestoreInstanceForTesting } from '../server/db/firestore';",
    )

mock_marker = 'class StorageRegressionMockFirestore {'
if mock_marker not in storage_src:
    storage_src = replace_once(
        storage_src,
        'storage regression mock firestore',
        """import type { ServerVideoTaskRecord } from '../types';\n\nfunction createTestTask""",
        """import type { ServerVideoTaskRecord } from '../types';\n\nclass StorageRegressionMockDoc {\n  constructor(private store: Map<string, any>, private id: string) {}\n  async get() {\n    const data = this.store.get(this.id);\n    return { exists: Boolean(data), data: () => data ? JSON.parse(JSON.stringify(data)) : undefined };\n  }\n  async set(data: any) { this.store.set(this.id, JSON.parse(JSON.stringify(data))); }\n  async update(patch: any) {\n    const existing = this.store.get(this.id) || {};\n    this.store.set(this.id, JSON.parse(JSON.stringify({ ...existing, ...patch })));\n  }\n}\n\nclass StorageRegressionMockCollection {\n  constructor(private store: Map<string, any>) {}\n  doc(id: string) { return new StorageRegressionMockDoc(this.store, id); }\n  orderBy() { return this; }\n  limit() { return this; }\n  async get() {\n    const docs = Array.from(this.store.entries()).map(([id, data]) => ({\n      id,\n      data: () => JSON.parse(JSON.stringify(data)),\n    }));\n    return { forEach: (cb: (doc: any) => void) => docs.forEach(cb), docs };\n  }\n}\n\nclass StorageRegressionMockFirestore {\n  public store = new Map<string, any>();\n  collection(_name: string) { return new StorageRegressionMockCollection(this.store); }\n  async runTransaction<T>(updateFn: (transaction: any) => Promise<T>): Promise<T> {\n    const transaction = {\n      get: async (docRef: StorageRegressionMockDoc) => docRef.get(),\n      set: async (docRef: StorageRegressionMockDoc, data: any) => docRef.set(data),\n      update: async (docRef: StorageRegressionMockDoc, patch: any) => docRef.update(patch),\n    };\n    return await updateFn(transaction);\n  }\n}\n\nfunction createTestTask""",
    )

if 'setFirestoreInstanceForTesting(new StorageRegressionMockFirestore() as any);' not in storage_src:
    storage_src = replace_once(
        storage_src,
        'storage regression beforeEach isolation',
        """  beforeEach(() => {\n    gcsArtifactStore.clearMockStore();""",
        """  beforeEach(() => {\n    setFirestoreInstanceForTesting(new StorageRegressionMockFirestore() as any);\n    firestoreTaskRepository.resetDiagnostics();\n    gcsArtifactStore.clearMockStore();""",
    )

if 'setFirestoreInstanceForTesting(null);' not in storage_src:
    storage_src = replace_once(
        storage_src,
        'storage regression afterEach isolation',
        """  afterEach(() => {\n    gcsArtifactStore.setMockUploadFailure(false);\n  });""",
        """  afterEach(() => {\n    gcsArtifactStore.setMockUploadFailure(false);\n    setFirestoreInstanceForTesting(null);\n  });""",
    )
storage_path.write_text(storage_src, encoding='utf-8')

print('[p0-5 test patch] test hardening applied successfully')
