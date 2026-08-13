from pathlib import Path

path = Path('src/__tests__/p0StorageAuthorityRegression.test.ts')
src = path.read_text(encoding='utf-8')
marker = "const taskId = 'contract_01_task';"
start = src.find(marker)
if start < 0:
    raise RuntimeError('CONTRACT-01 fixture not found')
end = src.find("await firestoreTaskRepository.createTask(record);", start)
if end < 0:
    raise RuntimeError('CONTRACT-01 createTask call not found')
block = src[start:end]
if "status: 'completed'" in block:
    block = block.replace("status: 'completed'", "status: 'polling'", 1)
    src = src[:start] + block + src[end:]
    path.write_text(src, encoding='utf-8')
    print('[p0-5 fixture fix] CONTRACT-01 now tests Firestore authority without invalid completed state')
else:
    print('[p0-5 fixture fix] CONTRACT-01 already hardened')
