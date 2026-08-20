# E2E-04 — ChatGPT `character_reference` 原生视频输入

## 目标

让用户在 ChatGPT 中只指定造境角色，例如“用梅凝生成一个 4 秒测试视频”，ChatGPT 不再要求重新上传角色母板，而是：

1. `listZaojingCharacters` / `getZaojingCharacterPackage` 解析真实角色；
2. `POST /v1/videos` 使用 `inputSource.type=character_reference`；
3. Gateway 从 Firestore `characters` 读取角色元数据，从 GCS 读取指定母板；
4. Gateway 将真实 `identityLockPrompt` 加入 Provider 前 Prompt；
5. 继续复用现有 `/api/mvp/videos/start → Veo → Identity QA → artifact verify` 主链；
6. Gateway 持久化 intent/task → input source 绑定，便于验收时证明实际使用了哪个角色和 reference。

## 新请求

```json
{
  "prompt": "人物保持稳定，仅有自然呼吸与轻微环境动态。",
  "durationSeconds": 4,
  "idempotencyKey": "stable-intent-key-at-least-16-chars",
  "inputSource": {
    "type": "character_reference",
    "characterId": "char_731dace9-bfaf-44e3-b280-be90f3708518",
    "referenceId": "ref_0"
  }
}
```

原有 `openaiFileIdRefs` 会话图片入口继续兼容。

## 关键约束

- `character_reference` 和会话图片不可同时提交；
- 角色必须存在且为 `ready`；
- 成人确认/使用权确认不可明确为 false；
- reference 必须属于该角色；
- GCS 图片必须是真实 JPG/PNG/WebP 且不超过 20 MB；
- 同一个 `idempotencyKey` 不允许换成不同输入源；
- Gateway 只负责解析角色与绑定资产，不复制 Veo/Identity QA 主链。

## 验收证据

成功的 create/status 响应应包含：

```json
{
  "inputSource": {
    "type": "character_reference",
    "characterId": "...",
    "referenceId": "...",
    "characterName": "...",
    "contentSha256": "...",
    "identitySpecSha256": "..."
  }
}
```

最终 E2E PASS 仍必须满足真实 Provider 调用、真实可播放 MP4、artifact persisted/verified、Identity QA PASS。

## 后续 E2E-04B

本阶段不新增角色图生图 API。下一阶段复用现有 `FirstFrameGenerator` 和 `/api/first-frames/generate-and-qa`，新增 ChatGPT-facing `/v1/keyframes`，自动把 `characterId + referenceIds` 解析成真实母板和 `identitySpec`，生成并持久化为 `imageAssetId`，再由 `/v1/videos` 使用 `image_asset` 输入。
