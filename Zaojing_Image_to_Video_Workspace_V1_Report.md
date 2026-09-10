# Zaojing Image-to-Video Workspace V1 Report

日期：2026-09-10 UTC  
仓库：pan277942135/MN-P-To-V  
实现分支：codex/image-video-workspace-v1  
Pull Request：#123

## 1. Video generation flow

已完成代码走查，当前生产入口为：

`director-server.ts → episode-server.ts → server.ts`

图片转视频链路为：

`ImageVideoWorkspacePage → POST /api/videos/start → VideoGenerator → Veo → GCS Artifact Store → Firestore Task State Machine`

现有 Veo Service、Task Service、GCS Artifact Store 和视频流接口均被复用；未重构原有项目、Token、AI Gateway、Director Context、Shot Context 或 Firestore 权限模型。

## 2. 修改文件

- `server.ts`
  - 增加 `/api/images` 图片上传、列表和流式读取。
  - 增加按 `sourceImageId` 查询关联视频。
  - 保留 `POST /api/videos/start`，增加图片中心模式与 4/6/8 秒校验。
  - 增加最佳版本人工选择接口。
  - Identity Safe / Scene Safe 通过环境变量控制，默认关闭。
- `src/types/index.ts`
  - `ServerVideoTaskRecord` 增加 `sourceImageId`、安全开关状态、最佳版本字段。
  - 增加 `ImageAssetRecord` 与 `VideoAsset`。
- `src/services/character/identityLockService.ts`
  - 保留原身份质检逻辑，仅将阻断改为显式开启。
- `src/server/services/taskStateMachineService.ts`
  - 允许明确标记 `identityQaDisabled=true` 的任务在已有 GCS 产物后完成。
- `src/App.tsx`
  - 全局 `/assets` 路由接入图片转视频工作台；项目内原有 Assets 页面未改动。
- `src/pages/ImageVideoWorkspacePage.tsx`
  - 新增 Images / Videos 双 Tab、上传、Prompt、时长选择、版本列表和人工选择最佳版本。
- `.env.example`
  - 增加 `ENABLE_IDENTITY_SAFE=false`、`ENABLE_SCENE_SAFE=false`。
- `.github/workflows/director-console-uat-deploy.yml`
  - UAT 显式传入两个安全开关为关闭。
  - 增加 Vertex AI Service Agent 对 Veo 输出 Bucket 的 GCS 创建权限只读检查。

## 3. API 变化

### 图片中心

- `POST /api/images`
  - multipart 字段：`image`
  - Firestore collection：`image_assets`
  - GCS object：`images/{imageId}/original.{ext}`
- `GET /api/images`
- `GET /api/images/:imageId`
- `GET /api/images/:imageId/videos`

### 视频生成

保留：

`POST /api/videos/start`

图片中心模式请求字段：

```json
{
  "imageId": "img_...",
  "rawUserPrompt": "镜头缓慢推进，人物自然眨眼",
  "compiledPrompt": "镜头缓慢推进，人物自然眨眼",
  "durationSeconds": 4,
  "workspaceMode": "simple_image_to_video"
}
```

`durationSeconds` 只允许 `4`、`6`、`8)，其它值返回 HTTP 400。

### 版本选择

- `POST /api/videos/:taskId/select`
- 同一 `sourceImageId` 下只保留一个 `selectedBest=true)。

## 4. 数据库与对象存储变化

### Firestore

新增 collection：

`image_assets`

字段：

- `id`
- `objectPath`
- `bucket`
- `mimeType`
- `sizeBytes`
- `createdAt`
- `updatedAt`

视频任务增加：

- `sourceImageId`
- `identityQaDisabled`
- `sceneSafeDisabled`
- `selectedBest`
- `selectedAt`

### GCS

图片使用：

`gs://ai-studio-bucket-89614354864-asia-south1/images/{imageId}/original.{ext}`

视频仍使用现有：

`gs://ai-studio-bucket-89614354864-asia-south1/veo/{taskKey}/video.mp4`

## 5. GCS 失败修复状态

现有代码已确认使用：

- `VEO_OUTPUT_BUCKET=ai-studio-bucket-89614354864-asia-south1`
- 现有 `gcsArtifactStore.uploadVideoArtifact`
- 现有 `storage.bucket(...).file(...).save(...)`

本次没有修改业务存储逻辑，也没有修改 Firestore 权限模型。

UAT 部署 workflow 新增只读检查：

1. 解析项目的 Vertex AI Service Agent：
   `service-{PROJECT_NUMBER}@gcp-sa-aiplatform.iam.gserviceaccount.com`
2. 读取项目和 Bucket IAM policy。
3. 验证该 Service Agent 绑定的角色包含 `storage.objects.create`。

当前状态：该检查已提交到 workflow，但本次没有执行真实 UAT 部署，因此线上 IAM 是否已满足仍需运行 UAT workflow 后确认。

## 6. 部署版本

- 实现分支：`codex/image-video-workspace-v1`
- 最新实现 commit：`04358fdf1c5e399ee1116e3a01732d80fae36246`
- PR：[#123](https://github.com/pan277942135/MN-P-To-V/pull/123)
- `main` 尚未合并。
- Cloud Run UAT 尚未部署。

## 7. 测试结果

通过：

- Director Console CI
  - TypeScript `bun run lint`
  - Director / Episode regression tests
  - 生产构建 `bun run build`
  - [Workflow run](https://github.com/pan277942135/MN-P-To-V/actions/runs/34433418018)

未执行：

- 真实 Vertex/Veo 付费生成 E2E。
- 使用真实图片、Prompt、GCS 产物的端到端人工验收。
- UAT Cloud Run 部署与线上 Service Agent IAM 探针。

注意：

- PR 同时触发的仓库既有 M2 / Provider 专项 workflow 当前存在 failure；这些检查不属于本次新增 V1 专用验收流程，因此 PR 当前仍需人工确认后再合并。

## 8. 完成项核对

已实现：

- 上传图片
- 输入 Prompt
- 选择 4 / 6 / 8 秒
- 调用现有 Veo 生成链路
- GCS 保存视频
- 一图多个视频版本
- 图片列表
- 视频列表
- 图片详情关联视频
- 人工选择最佳版本
- Identity Safe / Scene Safe 默认关闭且保留原代码
- GCS Service Agent 权限检查 workflow

当前发布状态：代码实现已提交并开 PR，等待 CI 专项检查、UAT IAM 验证、真实 Veo E2E 和合并部署。
