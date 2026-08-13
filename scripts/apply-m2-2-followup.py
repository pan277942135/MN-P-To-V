from pathlib import Path

ORCHESTRATOR = Path('src/services/tasks/taskOrchestrator.ts')
STUDIO = Path('src/pages/StudioPage.tsx')
P0_STATE_TEST = Path('src/__tests__/p0DurableStateMachine.test.ts')

orchestrator = ORCHESTRATOR.read_text()
studio = STUDIO.read_text()
p0_state_test = P0_STATE_TEST.read_text()

old = "identityGatePassed: identityGate.status !== 'fail',"
if old in orchestrator:
    orchestrator = orchestrator.replace(old, "identityGatePassed: true,", 1)
elif "identityGatePassed: true," not in orchestrator:
    raise SystemExit('orchestrator narrowed gate anchor not found')

studio = studio.replace('身份自动质检：未执行', '视频身份质检：等待服务端 Authority 结果')

# M2-2 upgrades crash recovery semantics: recovering authoritative GCS bytes may
# restore artifact state, but it must never certify video identity. The two P0
# recovery tests are intentionally changed from completed -> qa_pending.
old_assertion = "expect(recovered?.status).toBe('completed');"
count = p0_state_test.count(old_assertion)
if count == 2:
    p0_state_test = p0_state_test.replace(
        old_assertion,
        "expect(recovered?.status).toBe('qa_pending');",
    )
elif p0_state_test.count("expect(recovered?.status).toBe('qa_pending');") < 2:
    raise SystemExit(f'unexpected recovery status assertion count: {count}')

ORCHESTRATOR.write_text(orchestrator)
STUDIO.write_text(studio)
P0_STATE_TEST.write_text(p0_state_test)
print('Applied M2-2 follow-up patch')
