from pathlib import Path

ORCHESTRATOR = Path('src/services/tasks/taskOrchestrator.ts')
STUDIO = Path('src/pages/StudioPage.tsx')

orchestrator = ORCHESTRATOR.read_text()
studio = STUDIO.read_text()

old = "identityGatePassed: identityGate.status !== 'fail',"
if old in orchestrator:
    orchestrator = orchestrator.replace(old, "identityGatePassed: true,", 1)
elif "identityGatePassed: true," not in orchestrator:
    raise SystemExit('orchestrator narrowed gate anchor not found')

studio = studio.replace('身份自动质检：未执行', '视频身份质检：等待服务端 Authority 结果')

ORCHESTRATOR.write_text(orchestrator)
STUDIO.write_text(studio)
print('Applied M2-2 follow-up patch')
