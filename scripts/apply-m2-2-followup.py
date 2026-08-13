from pathlib import Path
import re

ORCHESTRATOR = Path('src/services/tasks/taskOrchestrator.ts')
STUDIO = Path('src/pages/StudioPage.tsx')
STATE = Path('src/server/services/taskStateMachineService.ts')
P0_STATE_TEST = Path('src/__tests__/p0DurableStateMachine.test.ts')

orchestrator = ORCHESTRATOR.read_text()
studio = STUDIO.read_text()
state = STATE.read_text()
p0_state_test = P0_STATE_TEST.read_text()

old = "identityGatePassed: identityGate.status !== 'fail',"
if old in orchestrator:
    orchestrator = orchestrator.replace(old, "identityGatePassed: true,", 1)
elif "identityGatePassed: true," not in orchestrator:
    raise SystemExit('orchestrator narrowed gate anchor not found')

studio = studio.replace('身份自动质检：未执行', '视频身份质检：等待服务端 Authority 结果')

# M2-2 upgrades crash recovery semantics: recovering authoritative GCS bytes may
# restore artifact state, but it must never certify video identity.
old_assertion = "expect(recovered?.status).toBe('completed');"
count = p0_state_test.count(old_assertion)
if count == 2:
    p0_state_test = p0_state_test.replace(
        old_assertion,
        "expect(recovered?.status).toBe('qa_pending');",
    )
elif p0_state_test.count("expect(recovered?.status).toBe('qa_pending');") < 2:
    raise SystemExit(f'unexpected recovery status assertion count: {count}')

# Artifact persistence is no longer allowed to jump directly to completed.
state = state.replace(
    "artifact_persisted: ['qa_pending', 'completed', 'failed'],",
    "artifact_persisted: ['qa_pending', 'failed'],",
    1,
)

# Enforce the completed invariant in the generic transition boundary itself, so
# future workers cannot bypass completeAfterQa by calling transitionTask directly.
invariant_anchor = """      const updatedRecord: ServerVideoTaskRecord = {\n        ...currentTask,\n        ...patch,\n        status: toStatus,\n        stateVersion: nextVersion,\n        statusVersion: nextVersion,\n        updatedAt: now,\n        ...(toStatus === 'completed' ? { completedAt: patch.completedAt || now } : {}),\n      };\n\n      return {\n"""
if 'VIDEO_QA_COMPLETION_INVARIANT' not in state:
    invariant_replacement = """      const updatedRecord: ServerVideoTaskRecord = {\n        ...currentTask,\n        ...patch,\n        status: toStatus,\n        stateVersion: nextVersion,\n        statusVersion: nextVersion,\n        updatedAt: now,\n        ...(toStatus === 'completed' ? { completedAt: patch.completedAt || now } : {}),\n      };\n\n      if (toStatus === 'completed') {\n        const qaReport = updatedRecord.qaReport || updatedRecord.identityQaReport;\n        const artifactValid =\n          updatedRecord.artifactPersisted === true &&\n          Boolean(updatedRecord.outputBucket) &&\n          Boolean(updatedRecord.outputObjectPath) &&\n          Boolean(updatedRecord.videoUri);\n        const qaValid =\n          updatedRecord.identityQaStatus === 'pass' &&\n          qaReport?.pass === true &&\n          qaReport?.gateStatus === 'pass';\n        if (!artifactValid || !qaValid) {\n          throw new Error(\n            `[VIDEO_QA_COMPLETION_INVARIANT] Task ${taskId} cannot become completed without persisted artifact authority and PASS video identity QA.`\n          );\n        }\n      }\n\n      return {\n"""
    if invariant_anchor not in state:
        raise SystemExit('state transition invariant anchor not found')
    state = state.replace(invariant_anchor, invariant_replacement, 1)

# Deprecate the old all-in-one helper: it may persist and enter qa_pending, but
# only an explicitly supplied PASS QA report may finish the task.
legacy_pattern = re.compile(
    r"  public async completeWithPersistedArtifact\(params: \{.*?\n  \}\n\n  public async persistArtifactForQa\(",
    re.S,
)
legacy_replacement = r'''  public async completeWithPersistedArtifact(params: {
    taskId: string;
    outputBucket: string;
    outputObjectPath: string;
    videoUri: string;
    sizeBytes?: number;
    contentType?: string;
    artifactPersistedAt?: number;
    patch?: Partial<ServerVideoTaskRecord>;
  }): Promise<ServerVideoTaskRecord> {
    const qaPending = await this.persistArtifactForQa(params);
    const qaReport = params.patch?.qaReport || params.patch?.identityQaReport;
    if (
      params.patch?.identityQaStatus === 'pass' &&
      qaReport?.pass === true &&
      qaReport?.gateStatus === 'pass'
    ) {
      return await this.completeAfterQa({
        taskId: params.taskId,
        qaReport,
        patch: params.patch,
      });
    }
    return qaPending;
  }

  public async persistArtifactForQa('''
state2, legacy_count = legacy_pattern.subn(legacy_replacement, state, count=1)
if legacy_count != 1 and 'const qaPending = await this.persistArtifactForQa(params);' not in state:
    raise SystemExit('legacy completion helper anchor not found')
state = state2 if legacy_count == 1 else state

# P0 lifecycle must use the certified QA completion API, not generic transition.
old_lifecycle = """    // qa_pending -> completed\n    updated = await taskStateMachineService.transitionTask({ taskId, toStatus: 'completed' });\n    expect(updated.status).toBe('completed');\n    expect(updated.completedAt).toBeDefined();\n"""
if old_lifecycle in p0_state_test:
    new_lifecycle = """    // qa_pending -> completed only with explicit PASS video Identity QA\n    updated = await taskStateMachineService.completeAfterQa({\n      taskId,\n      qaReport: {\n        pass: true,\n        gateStatus: 'pass',\n        averageIdentityScore: 98,\n        minimumIdentityScore: 96,\n        temporalConsistencyScore: 97,\n        motionNaturalnessScore: 96,\n        anatomyScore: 97,\n        sceneContinuityScore: 96,\n        promptComplianceScore: 96,\n        frameReports: [],\n        criticalIssues: [],\n        repairInstruction: '',\n        summary: 'certified test QA pass',\n        identityDriftDetected: false,\n        worstFrameTimestamp: null,\n        identityDriftSegments: [],\n      },\n    });\n    expect(updated.status).toBe('completed');\n    expect(updated.identityQaStatus).toBe('pass');\n    expect(updated.completedAt).toBeDefined();\n"""
    p0_state_test = p0_state_test.replace(old_lifecycle, new_lifecycle, 1)
elif "certified test QA pass" not in p0_state_test:
    raise SystemExit('P0 lifecycle completion anchor not found')

ORCHESTRATOR.write_text(orchestrator)
STUDIO.write_text(studio)
STATE.write_text(state)
P0_STATE_TEST.write_text(p0_state_test)
print('Applied M2-2 follow-up patch')
