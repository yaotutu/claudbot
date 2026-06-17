# Sessions 模块说明

`src/sessions/` 负责会话转录的读写：业务侧的 session 摘要 / 恢复，以及 SDK 原生 JSONL 镜像。本模块只处理 JSONL 存储与读模型，不驱动 SDK、不编排对话。

## 关键入口

- `session-service.ts`: `createSessionService` 提供 resolve / rename / getSummary / clearStaleActiveSession，依赖 `RuntimeStateStore`。
- `jsonl-store.ts` / `jsonl-parser.ts`: 业务侧 JSONL 追加与解析（run activity、custom title 等）。
- `sdk-jsonl-store.ts`: 实现 SDK `SessionStore`，把 SDK 转录镜像到 `sessions/<id>/`。
- `session-read-model.ts`: 从 JSONL 重建会话读模型（消息列表、activity）。

## 数据流

SDK 写转录 → `sdk-jsonl-store` 落 `sessions/<id>/main.jsonl`；业务侧 `appendSessionJsonlEntry` 追加 `claudebot-run-activity` / `custom-title` 等条目；`session-read-model` 读时合并两者。

## 修改注意

- 消息格式以 SDK JSONL 为准，业务条目用独立 `type` 区分。
- 改解析逻辑同步更新 `src/sessions/*.test.ts` 与 `tests/sessions.test.ts`。

## 测试

```bash
bun test src/sessions/*.test.ts tests/sessions.test.ts --timeout 30000
```
