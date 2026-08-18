# 造境 MVP Identity Safe v0.2 可验证版

## 冻结目标

生产主通道保持：

`Cloud Run → Runtime ADC → Vertex AI → veo-3.1-fast-generate-001 → GCS`

v0.2 在已经稳定“图片 + Prompt → 视频”的基础上增加一个硬目标：

> 给定一张已经人工确认是梅凝的清晰图片和一段低身份风险 Prompt，系统不仅要稳定生成真实可播放视频，还必须自动检查视频中人物是否持续为同一身份；检测到身份漂移时最多自动进行一次保守重试，重试后仍不通过则明确失败，绝不把换脸视频标记为成功。

## 本版本范围

### P0-01 — Identity Stability Benchmark

固定 `identity-stability-benchmark-v1`，共 24 条真实生成 Case：

- 4 秒：8 条
- 6 秒：8 条
- 8 秒：8 条
- 覆盖 `micro_expression` / `hair_motion` / `upper_body` / `environment_motion`

API：`GET /api/mvp/benchmark/catalog`

### P0-02 — Identity Safe Mode 输入约束

Identity Safe 默认开启。当前硬约束：

- JPG / PNG / WebP
- 短边至少 512px
- 长边至少 768px
- 极端宽高比拒绝
- 暂不接受大幅转头、快速转身、长时间遮脸、360°/大幅环绕镜头等高身份漂移动作

不满足时返回 `IDENTITY_INPUT_UNSAFE`，不得调用 Veo。

### P0-03 — 固定 Identity Safe Prompt

用户 Prompt 不被语义重写，但服务端固定追加身份约束层：

- 上传图是精确身份锚点和首帧外观参考
- 保持同一成年人物的脸型、眼鼻唇、下颌、肤色、发型、发际线和年龄感
- 禁止换人、替脸、身份 morphing、自动正脸化和姿势归一
- 镜头固定或近固定
- 身份保持优先级高于冲突动作

身份漂移后的唯一一次重试会追加更严格的 `CONSERVATIVE IDENTITY RETRY`：无转头、无转身、无手遮脸、无镜头移动，仅保留呼吸/眨眼/极轻表情。

### P0-04 — 真实视频抽帧 + 身份相似度 QA

视频完成后必须经过真实 `ffmpeg` 抽帧，再由 Vertex AI `gemini-2.5-flash` 对上传身份锚点与每个真实视频帧做身份连续性检查。

QA 至少输出：

- 每帧 `faceSimilarityScore`
- `faceVisible`
- `differentPersonDetected`
- 平均相似度
- 最低帧相似度
- temporal consistency
- 可判断脸部帧比例
- 最差帧时间戳
- `pass / review / fail`

当前 full-pass 阈值：

- mean ≥ 90
- minimum frame ≥ 84
- temporal ≥ 88
- visible frame ratio ≥ 0.75
- `differentPersonDetected = false`

QA 失败或抽帧不足均 fail-closed，不允许 `COMPLETED`。

### P0-05 — 身份错误码与报告

新增：

- `IDENTITY_INPUT_UNSAFE`
- `IDENTITY_QA_UNAVAILABLE`
- `IDENTITY_DRIFT`
- `IDENTITY_RETRY_FAILED`

任务持久化：

- `identityReport`
- `firstAttemptIdentityReport`
- `providerAttempt`
- `identityRetryCount`
- `retryReason`

### P0-06 — 一次保守自动重试

只有第一次真实生成已经成功拿到 MP4、但身份 QA 未通过时，允许自动提交一次新的 Veo Operation。

硬限制：

- Provider attempt 最多 2 次
- `identityRetryCount` 最多 1
- 第二次仍漂移 → `FAILED / IDENTITY_DRIFT`
- 第二次提交本身失败 → `IDENTITY_RETRY_FAILED`
- `SUBMISSION_OUTCOME_UNKNOWN` 不得自动重提
- recovery 接口只恢复当前 attempt 的 GCS 产物，永远不得触发新的 Veo 提交

失败 attempt 的 MP4 保存在 task 专属 audit path，便于后续分析。

### P0-07 — 是否进入首帧身份增强

不预设一定需要首帧增强。必须先跑至少 20 条真实 benchmark，再按数据决定。

推荐进入首帧增强的任一条件：

- post-retry pass rate < 90%；或
- early identity drift rate ≥ 20%。

不足 20 条真实数据时，结论固定为 `BENCHMARK_INCOMPLETE`。

## 明确仍不在 v0.2 主链路范围

- 将梅凝母板直接作为多图输入送给 Veo
- 首帧自动重绘/换脸
- LoRA / 专用身份保持模型
- Human Review
- 多 Provider 路由
- 自动进行第二次以上的视频重试

这些能力只有在 P0-07 数据触发后才考虑进入下一阶段。

## 可验证服务

- v0.1 回归入口：`mvp-server.ts`
- v0.2 UAT 入口：`mvp-server-v02.ts`
- 容器：`Dockerfile.mvp`
- Cloud Run UAT：`zaojing-mvp-simple-uat`
- 固定 UAT 地址：`https://zaojing-mvp-simple-uat-i7lns3auvq-uc.a.run.app/`
- Firestore task collection：`mvp_video_tasks`
- idempotency collection：`mvp_video_idempotency`

GCS task 结构：

- 身份锚点：`veo/<taskId>/input/reference.<ext>`
- Attempt 1：`veo/<taskId>/provider/attempt-1/`
- Attempt 2：`veo/<taskId>/provider/attempt-2/`
- QA 未通过的审计视频：`veo/<taskId>/attempts/attempt-<n>.mp4`
- 最终通过视频：`veo/<taskId>/video.mp4`

## UAT 访问契约（冻结）

人工验收只使用固定 Cloud Run UAT 地址，通过 Cloud Run IAP / Google 登录直接访问。

- 不公开匿名访问
- 不使用 `gcloud run services proxy`
- 不使用 Cloud Shell Web Preview
- 不使用临时端口/Preview URL

## 状态机

- `PREPARING`
- `SUBMITTING`
- `GENERATING`
- `SAVING`
- `QUALITY_CHECKING`
- `RETRYING`
- `COMPLETED`
- `FAILED`
- `SUBMISSION_OUTCOME_UNKNOWN`

## v0.2 成功条件：0 假成功

Identity Safe 任务只有同时满足以下条件才能 `COMPLETED`：

1. Provider 已有真实视频产物；
2. MP4 有效；
3. 真实视频完成抽帧；
4. 身份 QA `gateStatus = pass` 且 `pass = true`；
5. 最终视频持久化到标准 GCS path；
6. GCS exact-read 成功；
7. `artifactPersisted = true`；
8. `artifactVerified = true`；
9. `sizeBytes >= 1000`；
10. content type 为 video。

`Provider done=true`、`Veo 生成成功`、`有 MP4` 都单独不足以判定成功。

## CI 硬门槛

PR 合并前 `MVP Simple CI` 必须全部通过：

- TypeScript typecheck
- v0.1 artifact-only contract tests
- v0.2 Identity Safe tests
- 24-case benchmark contract tests
- 现有完整 regression suite
- v0.2 standalone server build
- Docker build
- 容器 smoke
- `/api/mvp/health` 返回 `MVP_IDENTITY_SAFE_V02`
- `/api/mvp/benchmark/catalog` 能看到 `IDSAFE-24`

## UAT 部署硬门槛

部署到 `zaojing-mvp-simple-uat` 后必须证明：

- `/api/mvp/health` mode = `MVP_IDENTITY_SAFE_V02`
- `identityQaModel = gemini-2.5-flash`
- `/api/mvp/readiness` = `ready:true`
- 24-case benchmark catalog 可读
- 固定 UAT URL 保持不变
- IAP 访问层保持开启

每次部署证据继续写入 GitHub Issue #47。

## Benchmark 验收指标

真实 24 Case 最终报告至少记录：

- first-attempt identity pass rate
- post-retry identity pass rate
- retry count
- final `IDENTITY_DRIFT` count
- early drift rate
- 4s / 6s / 8s 分组结果
- P0-07 first-frame-enhancement decision

工程正确性硬门槛仍然是：

- 假成功：0
- 无原因失败：0
- 身份 QA 未通过但 `COMPLETED`：0
- 同一 task 身份自动重试 >1：0
- recovery 导致 Provider 重提：0
- 成功任务最终 MP4/GCS exact-read：100%
