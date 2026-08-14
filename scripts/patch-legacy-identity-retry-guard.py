from pathlib import Path

path = Path('src/pages/TaskHistoryPage.tsx')
text = path.read_text()
marker = "const legacyIdentityGate ="
if marker in text:
    print('Legacy identity retry guard already applied')
    raise SystemExit(0)
old = """const isTaskInputRewriteRequired = (task?: GenerationTask | null): boolean => {
  if (!task) return false;
  const failureReason = (task as any).failureReason;
  const retryMode = (task as any).retryMode;
  return (
    failureReason === 'output_rai_filtered' ||
    failureReason === 'identity_qa_failed' ||
    failureReason === 'identity_qa_review_required' ||
    retryMode === 'REWRITE_INPUT_THEN_REGENERATE'
  );
};"""
new = """const isTaskInputRewriteRequired = (task?: GenerationTask | null): boolean => {
  if (!task) return false;
  const failureReason = (task as any).failureReason;
  const retryMode = (task as any).retryMode;
  const err = task.error as any;
  const legacyErrorCode = typeof err === 'object' && err ? String(err.code || '') : '';
  const legacyErrorText = [
    typeof err === 'string' ? err : '',
    typeof err === 'object' && err ? err.messageChinese : '',
    typeof err === 'object' && err ? err.userMessage : '',
    typeof err === 'object' && err ? err.technicalMessageRedacted : '',
    task.progressStage,
  ]
    .filter(Boolean)
    .map(String)
    .join(' ')
    .toLowerCase();
  const legacyIdentityGate =
    legacyErrorCode === 'IDENTITY_QA_FAILED' ||
    legacyErrorCode === 'IDENTITY_QA_REVIEW_REQUIRED' ||
    legacyErrorText.includes('identity_qa_failed') ||
    legacyErrorText.includes('identity qa failed') ||
    legacyErrorText.includes('角色一致性质检未通过') ||
    legacyErrorText.includes('角色一致性处于人工复核区间');
  return (
    failureReason === 'output_rai_filtered' ||
    failureReason === 'identity_qa_failed' ||
    failureReason === 'identity_qa_review_required' ||
    retryMode === 'REWRITE_INPUT_THEN_REGENERATE' ||
    legacyIdentityGate
  );
};"""
if old not in text:
    raise SystemExit('legacy identity guard anchor not found')
path.write_text(text.replace(old, new, 1))
print('Applied legacy identity retry guard')
