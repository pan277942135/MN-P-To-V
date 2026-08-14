import fs from 'node:fs';

const filePath = 'src/pages/TaskHistoryPage.tsx';
let source = fs.readFileSync(filePath, 'utf8');
let changed = false;

function replaceOnce(label, before, after) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`[provider-recovery-ui] missing anchor: ${label}`);
  source = source.replace(before, after);
  changed = true;
}

function replaceAll(label, before, after, minimum = 1) {
  if (source.includes(after) && !source.includes(before)) return;
  const count = source.split(before).length - 1;
  if (count < minimum) throw new Error(`[provider-recovery-ui] expected >=${minimum} anchors for ${label}, found ${count}`);
  source = source.split(before).join(after);
  changed = true;
}

function replaceRegex(label, regex, replacement, minimum = 1) {
  const matches = [...source.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g'))];
  if (matches.length < minimum) throw new Error(`[provider-recovery-ui] expected >=${minimum} regex anchors for ${label}, found ${matches.length}`);
  const next = source.replace(regex, replacement);
  if (next !== source) {
    source = next;
    changed = true;
  }
}

replaceOnce(
  'recovery card import',
  "import { GcsLocationCard, parseGcsUri } from '../components/GcsLocationCard';",
  "import { GcsLocationCard, parseGcsUri } from '../components/GcsLocationCard';\nimport { ProviderOperationRecoveryCard } from '../components/ProviderOperationRecoveryCard';"
);

replaceOnce(
  'unknown status badge',
  "    case 'polling_timeout':\n      return { text: '云端渲染较慢 (可继续查询)', cls: 'bg-amber-950 text-amber-300 border border-amber-800/80' };",
  "    case 'submission_outcome_unknown':\n      return { text: '提交结果待核实 · 已锁定', cls: 'bg-amber-950 text-amber-200 border border-amber-700/80' };\n    case 'polling_timeout':\n      return { text: '云端渲染较慢 (可继续查询)', cls: 'bg-amber-950 text-amber-300 border border-amber-800/80' };"
);

replaceOnce(
  'unknown helper',
  "const isTaskInputRewriteRequired = (task?: GenerationTask | null): boolean => {",
  "const isTaskProviderOutcomeUnknown = (task?: GenerationTask | null): boolean => (\n  Boolean(task) && String(task?.status || '') === 'submission_outcome_unknown'\n);\n\nconst isTaskInputRewriteRequired = (task?: GenerationTask | null): boolean => {"
);

replaceOnce(
  'retry fail closed',
  "    if (isTaskInputRewriteRequired(task)) {",
  "    if (isTaskProviderOutcomeUnknown(task)) {\n      alert('该任务的 Veo 提交结果尚未核实，已禁止重新生成。请在任务详情中使用【安全核实并恢复原任务】，避免重复提交或重复扣费。');\n      return;\n    }\n    if (isTaskInputRewriteRequired(task)) {"
);

replaceOnce(
  'delete fail closed',
  "  const handleDeleteTask = async (id: string) => {\n    if (confirm('确认删除此任务及本地产物记录？')) {",
  "  const handleDeleteTask = async (id: string) => {\n    const targetTask = tasks.find((task) => task.id === id) || (selectedTask?.id === id ? selectedTask : null);\n    if (isTaskProviderOutcomeUnknown(targetTask)) {\n      alert('该任务仍受 Provider 安全锁保护，禁止删除。请先核实原 Provider Operation，避免释放算力槽后发生重复提交或重复扣费。');\n      return;\n    }\n    if (confirm('确认删除此任务及本地产物记录？')) {"
);

replaceOnce(
  'safe failed counts',
  "  const failedTaskCount = tasks.filter(isTaskFailedState).length;",
  "  const failedTaskCount = tasks.filter(isTaskFailedState).length;\n  const clearableFailedTaskCount = tasks.filter((t) => isTaskFailedState(t) && !isTaskProviderOutcomeUnknown(t)).length;\n  const protectedUnknownTaskCount = tasks.filter(isTaskProviderOutcomeUnknown).length;"
);

replaceOnce(
  'safe bulk clear handler',
  "  const handleClearFailedTasks = async () => {\n    if (failedTaskCount === 0) return;\n    if (confirm(`确认批量清空所有已失败或卡死的任务 (${failedTaskCount} 个)，并清理云端后台渲染进程？`)) {\n      await taskRepository.clearFailed();\n      if (selectedTask && isTaskFailedState(selectedTask)) {\n        setSelectedTask(null);\n      }\n      await loadTasks();\n    }\n  };",
  "  const handleClearFailedTasks = async () => {\n    if (clearableFailedTaskCount === 0) {\n      if (protectedUnknownTaskCount > 0) {\n        alert(`当前 ${protectedUnknownTaskCount} 个异常任务属于【提交结果待核实】，受 Provider 安全锁保护，不能批量删除。`);\n      }\n      return;\n    }\n    if (confirm(`确认批量清空 ${clearableFailedTaskCount} 个可安全删除的失败任务？提交结果待核实任务不会被删除。`)) {\n      await taskRepository.clearFailed();\n      if (selectedTask && isTaskFailedState(selectedTask) && !isTaskProviderOutcomeUnknown(selectedTask)) {\n        setSelectedTask(null);\n      }\n      await loadTasks();\n    }\n  };"
);

// The bulk-clear control must represent only tasks the server is allowed to delete.
replaceAll('bulk clear disabled count', 'disabled={failedTaskCount === 0}', 'disabled={clearableFailedTaskCount === 0}');
replaceAll('bulk clear class count', 'failedTaskCount > 0\n                ?', 'clearableFailedTaskCount > 0\n                ?');
replaceOnce(
  'bulk clear title',
  "title={failedTaskCount > 0 ? `一键批量清空 ${failedTaskCount} 个失败任务` : '当前暂无失败任务'}",
  "title={clearableFailedTaskCount > 0 ? `一键批量清空 ${clearableFailedTaskCount} 个可安全删除的失败任务` : (protectedUnknownTaskCount > 0 ? '提交结果待核实任务受安全锁保护，不能批量删除' : '当前暂无可清理失败任务')}"
);
replaceOnce(
  'bulk clear label',
  "<span>批量清空失败任务{failedTaskCount > 0 ? ` (${failedTaskCount})` : ''}</span>",
  "<span>批量清空失败任务{clearableFailedTaskCount > 0 ? ` (${clearableFailedTaskCount})` : ''}</span>"
);
replaceOnce(
  'failed banner guidance',
  '点击批量清空可以一键删除所有失败任务并清理云端僵尸渲染进程。',
  '批量清空只删除可安全清理的终态失败任务；提交结果待核实任务会继续保留并锁定 Provider。'
);
replaceOnce(
  'banner clear count',
  '批量清空 ({failedTaskCount})',
  '批量清空 ({clearableFailedTaskCount})'
);

// Disable retry affordances for unknown tasks even before the handler-level safety check.
replaceAll(
  'list retry disabled',
  'disabled={isRetryingTaskId === task.id}',
  'disabled={isRetryingTaskId === task.id || isTaskProviderOutcomeUnknown(task)}',
  1
);
replaceAll(
  'detail retry disabled',
  'disabled={isRetryingTaskId === selectedTask.id}',
  'disabled={isRetryingTaskId === selectedTask.id || isTaskProviderOutcomeUnknown(selectedTask)}',
  1
);

// Disable delete affordances for protected unknown tasks; handler remains a second guard.
replaceRegex(
  'list delete disabled',
  /(handleDeleteTask\(task\.id\);\n\s*\}\}\n)(\s*)(className=)/g,
  '$1$2disabled={isTaskProviderOutcomeUnknown(task)}\n$2$3',
  1
);
replaceRegex(
  'detail delete disabled',
  /(onClick=\{\(\) => handleDeleteTask\(selectedTask\.id\)\}\n)(\s*)(className=)/g,
  '$1$2disabled={isTaskProviderOutcomeUnknown(selectedTask)}\n$2$3',
  1
);

// Put the certified recovery UI at the top of the task drawer so it is impossible to miss.
replaceOnce(
  'recovery card in task drawer',
  "          <div className=\"bg-zinc-900 border-l border-zinc-800 w-full max-w-xl h-full overflow-y-auto p-6 space-y-6 shadow-2xl\">\n            <div className=\"flex items-center justify-between border-b border-zinc-800 pb-4\">",
  "          <div className=\"bg-zinc-900 border-l border-zinc-800 w-full max-w-xl h-full overflow-y-auto p-6 space-y-6 shadow-2xl\">\n            {isTaskProviderOutcomeUnknown(selectedTask) && (\n              <ProviderOperationRecoveryCard\n                taskId={selectedTask.id}\n                onRecovered={async () => {\n                  await loadTasks();\n                  setSelectedTask(null);\n                }}\n              />\n            )}\n            <div className=\"flex items-center justify-between border-b border-zinc-800 pb-4\">"
);

if (changed) fs.writeFileSync(filePath, source);
console.log(`[provider-recovery-ui] ${changed ? 'TaskHistoryPage.tsx updated' : 'already applied'}`);
