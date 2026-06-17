# Agent 模块说明

`src/agent/` 封装 `@anthropic-ai/claude-agent-sdk`，把 SDK 流式消息归一化为内部 `NormalizedEvent`，并维护 system prompt、SDK 选项、profile 文本和持久 runtime。本模块只负责与 SDK 的边界，不处理 HTTP/WebSocket、会话持久化策略或工具业务实现。

## 关键入口

- `runner.ts`: `createClaudeRunner`（一次性执行器）、`runOnceTurn`（建好即跑一轮，供定时任务用）、`makeRealQueryFactory`（真实 SDK query）；`normalizeSdkMessage` 把 SDK 消息归一化为 `NormalizedEvent`。
- `runtime-manager.ts`: `createAgentRuntimeManager` 管理按 session 复用的持久 runtime，支持多轮输入队列、interrupt、MCP 状态查询和 session remap。交互式对话走这条路径。
- `events.ts`: `NormalizedEvent` 与 SDK 原始消息类型。
- `prompt.ts`: `buildSystemPrompt` 组装 profile / 记忆 / 工具提示。
- `sdk-options.ts`: `buildBaseSdkOptions` 构造 env、MCP servers、provider model 映射，两套执行路径共用。
- `profile.ts`: `createAgentProfileStore` 读写 `user.md` / `soul.md`。
- `input-queue.ts`: runtime 用的异步输入队列。

## 数据流

SDK `query()` 流式消息 → `normalizeSdkMessage` → `NormalizedEvent`：
- 一次性：`runOnceTurn` 直接 `for await` 消费（定时任务）。
- 持久：`AgentRuntimeManager.pump` 持续消费，按 runId 分发到当前 sink（交互对话）。

provider 模型通过 `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` 映射；`claudeCode.model` 只接受 `haiku`/`sonnet`/`opus` 别名，供应商实际模型写在 `providerModel`。

## 修改注意

- 不要把 `glm-*` 等供应商模型直接写进 `claudeCode.model`，只改 `providerModel` 与 env 映射。
- 优先函数式；runtime manager 用闭包持有 Map，不引入 class。
- 改 SDK 消息归一化时同步更新 `tests/agent-runner.test.ts` 和 `tests/sdk-conformance.test.ts`。

## 测试

```bash
bun test tests/agent-runner.test.ts tests/agent-runtime-manager.test.ts tests/sdk-conformance.test.ts --timeout 30000
bun run typecheck
```
