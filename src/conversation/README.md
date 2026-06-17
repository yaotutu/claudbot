# Conversation 模块说明

`src/conversation/` 编排一次用户轮次：驱动 agent runtime、收集 activity、处理 session 创建 / remap、转发原生帧、持久化 activity、触发记忆 dream。本模块是「对话主循环」，不直接处理 SDK 或 HTTP。

## 关键入口

- `run-user-turn.ts`: `runUserTurn` 是唯一入口；`collectRunActivity` 把 `NormalizedEvent` 映射成共享 activity reducer 的输入。
- `types.ts`: `RunUserTurnInput`、`ConversationEvent`、`ConversationSink`。

## 数据流

`runUserTurn` → `agentRuntimeManager.runTurn` → 每个 `NormalizedEvent` 同时：转发为 `ServerFrame`（经 `forwardNative`）+ 累积 activity（共享 reducer）→ turn 结束写入 `message.appended`（含 `metadata.activities`）+ JSONL activity 条目 + 可选 dream。

## 修改注意

- activity 累积必须走 `shared/activity-reducer.ts`，不要在本地重新实现。
- draft → 真实 session 的 remap 由 `agentRuntimeManager.remapSession` 完成。
- 改轮次逻辑同步更新 `tests/conversation-run-user-turn.test.ts`。

## 测试

```bash
bun test tests/conversation-run-user-turn.test.ts --timeout 30000
```
