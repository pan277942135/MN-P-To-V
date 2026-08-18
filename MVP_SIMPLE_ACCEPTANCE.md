# 造境 MVP_SIMPLE 可验证版

## 冻结目标

生产主通道固定为：

`Cloud Run → Runtime ADC → Vertex AI → veo-3.1-fast-generate-001 → GCS`

本版本只验证一件事：

> 给定一张已经人工确认是梅凝的图片和一段用户 Prompt，系统能够生成并返回真实可播放的视频；如果不能，必须明确报告失败阶段和原因。

## 明确不在本版本范围

- 角色库选择
- 梅凝母板上传
- IdentitySpec
- 首帧生成
- First Frame Identity QA
- Video Identity QA
- Human Review
- 自动身份修复
- PromptCompiler / Prompt 自动改写
- 自动重新生成视频
- 多 Provider 路由

这些能力保留在原 M2 工程，不参与 MVP_SIMPLE 成功判定。

## 可验证服务

入口文件：`mvp-server.ts`

容器文件：`Dockerfile.mvp`

Cloud Run UAT 服务：`zaojing-mvp-simple-uat`

固定 UAT 地址：`https://zaojing-mvp-simple-uat-i7lns3auvq-uc.a.run.app/`

任务元数据：Firestore collection `mvp_video_tasks`

幂等映射：Firestore collection `mvp_video_idempotency`

Provider 原始输出前缀：`gs://$VEO_OUTPUT_BUCKET/veo/<taskId>/provider/`

验证后的标准视频：`gs://$VEO_OUTPUT_BUCKET/veo/<taskId>/video.mp4`

## UAT 访问契约（冻结）

人工验收只使用固定 Cloud Run UAT 地址，通过 Cloud Run 原生 IAP / Google 登录直接访问。

- UAT 服务保持非公开匿名访问。
- Cloud Run 服务必须显示 `Iap Enabled: true`。
- 有权限的测试账号在浏览器打开固定 UAT 地址后直接完成 Google 登录并进入应用。
- **不使用 `gcloud run services proxy`。**
- **不使用 Cloud Shell Web Preview。**
- **不把本地代理、Cloud Shell 端口或临时 Preview URL 作为 UAT 验收入口。**

后续所有 MVP 人工验证、回归和视频生成测试均沿用此访问契约。

## API

### `GET /api/mvp/health`

只证明服务进程存活，并返回当前固定 provider/model/project/region。

### `GET /api/mvp/readiness`

必须同时验证：

- Runtime ADC 可取 Access Token
- Firestore 可读取
- GCS 可访问
- Vertex `veo-3.1-fast-generate-001:predictLongRunning` 路由存在

只有全部通过才返回 `ready=true`。

### `POST /api/mvp/videos/start`

`multipart/form-data`：

- `image`: JPG/PNG/WebP，最大 20MB
- `prompt`: 原始用户 Prompt，服务端不改写
- `durationSeconds`: 4 / 6 / 8
- Header `x-idempotency-key`: 推荐 UUID；相同 key 永远返回同一 task，不重复提交 Provider

成功提交后返回 `GENERATING + taskId`。

### `GET /api/mvp/videos/:taskId`

读取 Firestore durable task，并轮询已有 `operationName`。

绝不因为浏览器刷新而重新提交 Veo。

### `POST /api/mvp/videos/:taskId/recover`

仅扫描当前 task 专属 Provider GCS 前缀，尝试找回唯一有效 MP4。

该接口 **不会重新提交 Veo**，用于处理 `SUBMISSION_OUTCOME_UNKNOWN`。

### `GET /api/mvp/videos/:taskId/stream`

只允许读取已经达到 `COMPLETED` 且通过 artifact-only invariant 的 GCS 标准视频。

支持 Range 和下载。

## 状态

主状态只有：

- `PREPARING`
- `SUBMITTING`
- `GENERATING`
- `SAVING`
- `COMPLETED`
- `FAILED`
- `SUBMISSION_OUTCOME_UNKNOWN`

`SUBMISSION_OUTCOME_UNKNOWN` 是特殊保护态，不允许自动重新提交 Provider。

## 成功条件：0 假成功

`COMPLETED` 必须同时满足：

- `artifactPersisted = true`
- `artifactVerified = true`
- `outputBucket` 存在
- `outputObjectPath` 存在
- `videoUri` 存在
- `sizeBytes >= 1000`
- `contentType` 为 video
- 标准 GCS 对象被精确下载回服务端
- 回读字节通过 MP4 `ftyp/moov/mdat` 验证

Provider `done=true` 本身绝不等于成功。

## 提交重试策略

仅对明确的 HTTP 429 / `RESOURCE_EXHAUSTED` 做最多 2 次有限退避重试。

以下情况不自动重复提交：

- 网络中断
- 客户端超时
- HTTP 5xx
- 已进入 Provider 调用但没有拿到 Operation Name

上述情况进入 `SUBMISSION_OUTCOME_UNKNOWN`，防止重复扣费。

## 失败输出

所有终态失败应尽量提供：

- `error.code`
- `error.stage`
- `error.message`
- `error.retryable`
- `error.recommendedAction`
- `error.providerHttpStatus`（如有）
- `error.providerStatus`（如有）

核心错误码：

- `INPUT_IMAGE_INVALID`
- `PROMPT_INVALID`
- `AUTH_FAILED`
- `REQUEST_REJECTED`
- `SAFETY_REJECTED`
- `RATE_LIMITED`
- `GENERATION_FAILED`
- `GENERATION_TIMEOUT`
- `OUTPUT_MISSING`
- `OUTPUT_DOWNLOAD_FAILED`
- `OUTPUT_INVALID`
- `OUTPUT_PERSIST_FAILED`
- `SUBMISSION_OUTCOME_UNKNOWN`
- `STORAGE_CONFIG_INVALID`
- `INTERNAL_ERROR`

## 部署

`MVP Simple UAT Deploy` 在 MVP_SIMPLE 文件合入 `main` 时自动部署，同时保留手动 `workflow_dispatch`。

部署目标固定为独立 Cloud Run 服务 `zaojing-mvp-simple-uat`，不修改原 M2 UAT 服务。

部署流程先用服务账号验证 `/api/mvp/health` 和 `/api/mvp/readiness`，随后启用 Cloud Run 原生 IAP，并验证 `Iap Enabled: true`。

每次部署结束后，GitHub Actions 会把 Source SHA、Cloud Run revision、固定 UAT URL、IAP 状态和 readiness JSON 发布到 Issue #47 `MVP_SIMPLE UAT deployment evidence`，作为可追溯运行态证据。

## 第一轮人工真实验收

建议固定一张已人工确认的梅凝图片，先减少变量，再运行 20 个真实任务。

| Case | 输入 | 预期 |
|---|---|---|
| 01-05 | 同一 JPG + 5 条正常 Prompt，4s | 成功则全部为可播放 MP4；失败必须有明确 code/stage |
| 06-10 | 同一 JPG + 5 条正常 Prompt，6s | 同上 |
| 11-15 | 同一 JPG + 5 条正常 Prompt，8s | 同上 |
| 16 | PNG | 可提交并产出或明确 Provider 失败 |
| 17 | WebP | 可提交并产出或明确 Provider 失败 |
| 18 | 空 Prompt | 本地 400 `PROMPT_INVALID`，不得调用 Veo |
| 19 | 非图片文件 | 本地 400 `INPUT_IMAGE_INVALID`，不得调用 Veo |
| 20 | 同一个 `x-idempotency-key` 连续提交两次 | 必须返回同一个 taskId，不得创建第二次 Provider Operation |

另外主动验证：

1. 生成过程中刷新浏览器：继续轮询同一个 task。
2. 完成后刷新浏览器：视频仍可从 GCS 播放/下载。
3. 人为提供错误 IAM：必须显示 `AUTH_FAILED`。
4. 触发 429：有限退避后显示 `RATE_LIMITED`，不得无限重试。
5. Provider `done=true` 但无视频：必须失败，绝不能 `COMPLETED`。
6. `SUBMISSION_OUTCOME_UNKNOWN`：只允许恢复 GCS，不自动重新提交。

## MVP 通过门槛

工程正确性硬门槛：

- 假成功：0
- 无原因失败：0
- 成功任务有效 MP4：100%
- 成功任务 GCS 可回读：100%
- 同一 idempotency key 重复 Provider 提交：0
- `SUBMISSION_OUTCOME_UNKNOWN` 自动重新提交：0
- 失败任务有 code/stage/message：100%

模型稳定性作为独立指标记录，不与工程正确性混淆。建议首轮目标：20 个正常生成 Case 中至少 18 个获得有效视频；若低于该水平，再基于真实失败分布决定是否调整配额、Prompt 或模型策略。

## CI 状态说明

`MVP Simple CI` 已验证 Typecheck、MVP contract tests、现有完整回归、独立 server build、Docker build 和容器 smoke。只有 CI 全绿后才允许进入独立 UAT 部署，不以“代码已提交”代替“版本已验证”。