# Compute Settings Connection Test Fix Report

## 1. 修改文件

- `episode-server.ts`
- `server.ts`
- `src/pages/ComputeSettingsPage.tsx`

未修改 AI Gateway（`/api/ai/*`）、Shot Context、Firestore、Token、IAM 或 `PUBLIC_PREVIEW_READ_ONLY` 配置。

## 2. 修改原因

Preview Read Only（预览只读）中间件原先拦截了所有非安全方法，导致 `POST /api/connections/test` 返回 `423 PREVIEW_READ_ONLY`。

本次修复：

- 将 `POST /api/connections/test` 加入唯一连接测试白名单。
- 连接测试响应增加 `Cache-Control: no-store`。
- Vertex AI 前端在没有 Service Account JSON 时不再报错，改为让后端使用 Cloud Run ADC（应用默认凭证）；本地仍支持显式 JSON。
- 连接测试仍只执行 Vertex AI 路由/模型可用性与凭证权限检查，不调用视频生成、生产任务或 GCS 产出。

## 3. Preview 安全策略

PASS

UAT 实测能力接口：

`GET /api/director/capabilities` → HTTP 200

```json
{
  "readOnlyPreview": true,
  "productionRunEnabled": false
}
```

生产 POST 回归：

`POST /api/episodes/{episodeId}/run` → HTTP 423

```json
{
  "ok": false,
  "error": "PREVIEW_READ_ONLY"
}
```

## 4. CI / 部署结果

- Branch: `main`
- Final deployed commit: `f9ab21abb9a0509419219ddfdcc3ef805a884f79`
- Director Console UAT Deploy Run #44: PASS
- Cloud Run Revision: `zaojing-director-console-uat-00039-jbv`

## 5. UAT 测试结果

| 测试项 | 结果 | 实测证据 |
|---|---|---|
| Cloud Run environment | PASS | HTTP 200; `isCloudRun=true` |
| Compute capabilities | PASS | `readOnlyPreview=true`; `productionRunEnabled=false` |
| `POST /api/connections/test` | PASS | HTTP 200; `success=true` |
| Credential source | PASS | `ADC` |
| Vertex project | PASS | `xp-vertex-project` |
| Vertex location | PASS | `us-central1` |
| Cache control | PASS | `Cache-Control: no-store` |
| Production write protection | PASS | HTTP 423 `PREVIEW_READ_ONLY` |

## 6. Final

COMPUTE_CONNECTION_TEST_FIXED
