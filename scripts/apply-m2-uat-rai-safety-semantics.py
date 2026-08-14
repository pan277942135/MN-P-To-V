from pathlib import Path

server_path = Path('server.ts')
helper_path = Path('src/utils/taskHelper.ts')
test_path = Path('src/__tests__/m2UatRaiSafetySemantics.test.ts')

server = server_path.read_text(encoding='utf-8')
server_old = """      if (pollRes.error) {\n        const failureReason = pollRes.failureReason || (pollRes.isSafetyBlock ? 'output_rai_filtered' : 'unknown');\n        const retryMode = pollRes.retryMode || (failureReason === 'output_rai_filtered' ? 'REWRITE_INPUT_THEN_REGENERATE' : 'SAFE_TO_REGENERATE');\n\n        const errObj = createStructuredError({\n          source: 'vertex_polling',\n          failureStage: 'polling',\n          httpStatus: 500,\n"""
server_new = """      if (pollRes.error) {\n        const failureReason = pollRes.failureReason || (pollRes.isSafetyBlock ? 'output_rai_filtered' : 'unknown');\n        const retryMode = pollRes.retryMode || (failureReason === 'output_rai_filtered' ? 'REWRITE_INPUT_THEN_REGENERATE' : 'SAFE_TO_REGENERATE');\n\n        const errObj = createStructuredError({\n          source: 'vertex_polling',\n          failureStage: 'polling',\n          // RAI output filtering is a provider policy decision returned from a successful poll,\n          // not an HTTP/server failure. Keep transport semantics separate from product outcome.\n          httpStatus: failureReason === 'output_rai_filtered' ? 200 : 500,\n"""
if server_old in server:
    server = server.replace(server_old, server_new, 1)
elif server_new not in server:
    raise SystemExit('server.ts RAI patch anchor not found')
server_path.write_text(server, encoding='utf-8')

helper = helper_path.read_text(encoding='utf-8')
anchor = """  const identityGateKind = detectIdentityGateKind(errorCode, errMessageChinese, technicalMsg, recommendedAction, task.progressStage);\n\n  const hasVideoData = Boolean(\n"""
replacement = """  const identityGateKind = detectIdentityGateKind(errorCode, errMessageChinese, technicalMsg, recommendedAction, task.progressStage);\n  const isRaiFiltered =\n    (task as any).failureReason === 'output_rai_filtered' ||\n    (task as any).retryMode === 'REWRITE_INPUT_THEN_REGENERATE';\n\n  const hasVideoData = Boolean(\n"""
if anchor in helper:
    helper = helper.replace(anchor, replacement, 1)
elif replacement not in helper:
    raise SystemExit('taskHelper.ts RAI identity anchor not found')

old_http = """  const effectiveHttpStatus = identityGateKind === 'review'\n    ? 422\n    : identityGateKind === 'fail'\n      ? 400\n      : effectiveStatus === 'failed'\n        ? (httpStatus ?? 500)\n        : (httpStatus ?? null);\n"""
new_http = """  const effectiveHttpStatus = identityGateKind === 'review'\n    ? 422\n    : identityGateKind === 'fail'\n      ? 400\n      : isRaiFiltered\n        ? null\n        : effectiveStatus === 'failed'\n          ? (httpStatus ?? 500)\n          : (httpStatus ?? null);\n"""
if old_http in helper:
    helper = helper.replace(old_http, new_http, 1)
elif new_http not in helper:
    raise SystemExit('taskHelper.ts effectiveHttpStatus anchor not found')

old_code = """  const effectiveErrorCode = identityGateKind === 'review'\n    ? 'IDENTITY_QA_REVIEW_REQUIRED'\n    : identityGateKind === 'fail'\n      ? 'IDENTITY_QA_FAILED'\n      : effectiveStatus === 'failed'\n        ? (errorCode === 'OK' ? 'SERVER_FAILED' : errorCode)\n        : errorCode;\n"""
new_code = """  const effectiveErrorCode = identityGateKind === 'review'\n    ? 'IDENTITY_QA_REVIEW_REQUIRED'\n    : identityGateKind === 'fail'\n      ? 'IDENTITY_QA_FAILED'\n      : isRaiFiltered\n        ? 'OUTPUT_RAI_FILTERED'\n        : effectiveStatus === 'failed'\n          ? (errorCode === 'OK' ? 'SERVER_FAILED' : errorCode)\n          : errorCode;\n"""
if old_code in helper:
    helper = helper.replace(old_code, new_code, 1)
elif new_code not in helper:
    raise SystemExit('taskHelper.ts effectiveErrorCode anchor not found')
helper_path.write_text(helper, encoding='utf-8')

test_content = r"""import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildExecutionTuningPayload, getExplicitTaskFailureReason } from '../utils/taskHelper';

describe('M2 UAT RAI safety-filter semantics', () => {
  it('does not present output RAI filtering as HTTP 500/server failure', () => {
    const task = {
      id: 'task_rai_filtered',
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now(),
      status: 'failed',
      failureReason: 'output_rai_filtered',
      retryMode: 'REWRITE_INPUT_THEN_REGENERATE',
      error: {
        code: 'VERTEX_POLLING_ERROR',
        httpStatus: 200,
        messageChinese: '视频生成结果被 Google Vertex AI 安全策略过滤，未生成可下载的视频。',
        recommendedAction: '修改输入后重新生成',
      },
      settings: { durationSeconds: 4, aspectRatio: '9:16', resolution: '1080p' },
    } as any;

    const payload = buildExecutionTuningPayload(task);
    expect(payload.outputs.status).toBe('failed');
    expect(payload.outputs.httpStatus).toBeNull();
    expect(payload.outputs.errorCode).toBe('OUTPUT_RAI_FILTERED');

    const reason = getExplicitTaskFailureReason(task);
    expect(reason.errorCode).toBe('OUTPUT_RAI_FILTERED');
    expect(reason.recommendedAction).toContain('不要原样一键重试');
  });

  it('keeps provider transport semantics separate from RAI policy outcome', () => {
    const serverSource = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
    expect(serverSource).toContain("httpStatus: failureReason === 'output_rai_filtered' ? 200 : 500");
  });

  it('forces RAI-filtered tasks back to Studio instead of one-click retry', () => {
    const historySource = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/TaskHistoryPage.tsx'), 'utf8');
    expect(historySource).toContain("failureReason === 'output_rai_filtered'");
    expect(historySource).toContain("retryMode === 'REWRITE_INPUT_THEN_REGENERATE'");
    expect(historySource).toContain('返回工作台调整输入');
    expect(historySource).toContain('原样一键重试已禁用');
  });
});
"""
test_path.write_text(test_content, encoding='utf-8')
print('M2 UAT RAI safety semantics patch applied.')
