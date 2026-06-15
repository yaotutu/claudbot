# MCP 常驻 Agent Runtime 设计

## 背景

当前 Claudebot 的用户聊天运行方式是 single-turn：每次用户发送消息时创建一次 Claude Agent SDK `query({ prompt: string })`，通过 `resumeSessionId` 接回已有 Claude session。这个选择在早期是合理的，因为当时优先目标是快速打通 WebUI、SDK JSONL 会话、内置工具、scheduler 和冷态恢复。

现在要接入外部 MCP，而且用户明确要求尽量使用 Claude Agent SDK 内部能力，不要自己写 MCP client。外部 MCP 的初始化可能较慢，如果继续每轮重新创建 `query()`，MCP server 很可能随每轮用户消息重复初始化，聊天体验会变差。

因此，外部 MCP 接入不应只做配置透传，还需要把用户聊天 runtime 从 single-turn query 调整为 session-scoped long-lived query。

## 设计目标

- 使用 Claude Agent SDK 原生 MCP 能力，不实现 MCP client、MCP proxy 或 MCP tool registry。
- 外部 MCP 在一个活跃 WebUI session 内尽量只初始化一次。
- 内置工具和外部 MCP 保持清晰分层。
- 用户看到的 WebUI session、历史记录、rename、remove、list 语义保持不变。
- SDK JSONL 继续作为冷态历史来源和服务重启后的恢复基础。
- `chat.cancel` 从空实现升级为真实取消当前 turn。
- scheduler 暂不常驻，继续使用一次性 turn，避免后台任务长期占用资源。

## 官方 SDK 依据

TypeScript SDK 文档和当前安装的 `@anthropic-ai/claude-agent-sdk@0.3.169` 类型定义确认了以下能力：

- `query()` 支持 `prompt: string | AsyncIterable<SDKUserMessage>`。
- `Query` 对象支持 `interrupt()`、`close()`、`streamInput()`、`mcpServerStatus()`、`reconnectMcpServer()`、`toggleMcpServer()` 和 `setMcpServers()`。
- `Options.mcpServers` 可直接传入 MCP server 配置。
- `Options.strictMcpConfig` 可以让 SDK 只使用传入的 MCP servers，忽略项目 `.mcp.json`、用户 settings、插件 MCP 和 claude.ai connectors。
- `startup()` 只返回可用一次的 `WarmQuery`，适合降低首次 query 启动延迟，不适合作为多轮长会话池。

参考文档：

- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview
- https://code.claude.com/docs/en/agent-sdk/python

## 核心结论

用户聊天应改成：每个 WebUI chat session 在热态下持有一个长期 `Query`。

```text
WebUI session
  -> AgentRuntime
    -> long-lived SDK Query
      -> prompt: AsyncIterable<SDKUserMessage>
      -> mcpServers:
           claudebot: in-process native tools MCP server
           ...external MCP servers from config
```

用户每发一条消息时，不再新建 `query(prompt: string)`，而是把一个 `SDKUserMessage` 推入该 session 对应的 input queue。后台 output pump 持续读取 `Query` 输出并转成 gateway events。收到本轮 `result` 后，run 状态变为 completed，但 `Query` 不关闭，继续等待下一条用户消息。

服务重启、runtime 崩溃、idle TTL 到期或用户删除 session 后，`Query` 会关闭。下次用户继续该会话时，通过已保存的 `claudeSessionId` / SDK JSONL 重新 `resume`，再建立新的长期 `Query`。

```text
热态：long-lived Query 持有连续上下文和 MCP 连接
冷态：SDK JSONL + resume 恢复历史，再进入新的 long-lived Query
```

## 外部 MCP 配置

新增 Claudebot 原生配置段：

```json
{
  "mcp": {
    "strict": true,
    "servers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        "env": {},
        "timeout": 30000,
        "alwaysLoad": false
      }
    }
  }
}
```

第一版支持 SDK 已支持的外部配置形态：

- `stdio`: `command`、`args`、`env`、`timeout`、`alwaysLoad`
- `sse`: `url`、`headers`、`timeout`、`alwaysLoad`
- `http`: `url`、`headers`、`timeout`、`alwaysLoad`

SDK 的 in-process `sdk` MCP server 只用于 Claudebot 内置工具，不作为用户配置型外部 MCP 暴露。

配置校验只做结构校验和边界保护：

- server 名不能是 `claudebot`。
- server 名必须可作为 SDK `mcpServers` key 使用。
- 不记录完整 `env` 到日志。
- 默认 `mcp.strict = true`。

Claudebot 不做外部 MCP 工具发现、工具权限、工具审计或 prompt 生成。

## SDK MCP 组装

新增一个小型组装函数，供 single-turn 和 long-lived runtime 复用：

```text
buildSdkMcpServers(config, nativeServer)
  -> {
       claudebot: nativeServer,
       ...config.mcp.servers
     }
```

SDK options 中设置：

```text
mcpServers: buildSdkMcpServers(...)
strictMcpConfig: config.mcp.strict
```

`claudebot` 仍然是内置工具 MCP server，由 `ToolRegistry` 暴露。外部 MCP 直接交给 Claude Agent SDK。

## AgentRuntimeManager

新增 `AgentRuntimeManager`，负责用户聊天 session 的热态 runtime：

```text
AgentRuntimeManager
  - getOrCreate(sessionId)
  - runTurn(sessionId, message)
  - cancel(sessionId)
  - closeSession(sessionId)
  - closeIdle(now)
  - closeAll()
```

每个 `AgentRuntime` 维护：

```text
- sessionId: WebUI session id
- claudeSessionId?: SDK session id
- query: Query
- inputQueue: AsyncIterable<SDKUserMessage> 的生产端
- activeRunId?: string
- status: idle | running | cancelling | failed | closed
- lastUsedAt: ISO timestamp
- mcpStatus: 最近一次 SDK MCP server status
- contextRef: 当前工具上下文引用
```

`AgentRuntimeManager` 必须按 `sessionId` 维护 runtime：

```text
Map<sessionId, AgentRuntime>
```

同一个 Claudebot agent 可以同时有多个活跃 WebUI session。不同 session 可以并行运行，各自拥有独立的 SDK `Query`、上下文、active run 和外部 MCP server 实例。这是目标能力，不是异常情况。

```text
agent instance
  -> session A runtime -> SDK Query A -> MCP servers A
  -> session B runtime -> SDK Query B -> MCP servers B
```

隔离原则：

- 不同 session 可以并行执行。
- 不同 session 的 stream event 必须只投递给对应 session。
- 不同 session 的 `contextRef` 不能共享。
- 不同 session 的 cancel 只影响自己的 active run。
- 同一 session 同一时间只允许一个 active turn。

若用户在同一 session 的 running 状态再次发送消息，gateway 应返回明确错误或排队；第一版推荐返回错误，避免隐式排队导致 UI 状态难以解释。

## 动态 ToolContext

当前 `createClaudebotSdkMcpServer(registry, toolContext)` 把 `toolContext` 固定在闭包里。长期 Query 下，同一个 native MCP server 会跨多轮复用，因此必须改成动态上下文引用：

```text
createClaudebotSdkMcpServer(registry, contextRef)
  -> tool handler 执行时读取 contextRef.current
```

每次 `runTurn()` 开始前更新：

```text
contextRef.current = {
  source: "user_turn",
  sessionId,
  scheduleRunId: undefined,
  home,
  workspacePath,
  timezone,
  services: null
}
```

scheduler 仍使用一次性 runner，可以继续传固定 context，或者也使用同一个 contextRef 工具函数。

## 事件与状态

现有归一化事件继续保留：

- `text_delta`
- `thinking_delta`
- `tool_start`
- `tool_result`
- `status`
- `turn_done`
- `error`

需要扩展 `status` 事件，让前端能理解初始化和 MCP 状态：

```text
status: session_init
sessionId
mcpServers?: [{ name, status }]
```

SDK 输出 `system/init` 时，如果包含 `mcp_servers`，后端透传为 `mcpServers`。用户就能看到慢在 MCP 初始化、工具连接失败，还是模型正在生成。

## Cancel 与 Close

`chat.cancel` 调用：

```text
AgentRuntimeManager.cancel(sessionId)
  -> runtime.query.interrupt()
```

`interrupt()` 是 SDK streaming input mode 的控制能力，用于停止当前 query execution 并把控制权还给调用方。它不是释放整个 runtime。

以下场景调用 `query.close()`：

- session 被删除。
- idle TTL 到期。
- gateway/server shutdown。
- runtime 进入不可恢复 failed 状态。
- 用户显式要求重连 MCP 或重启 agent runtime。

第一版 idle TTL 建议为 20 分钟，可在配置中保留后续扩展空间，但不需要第一版暴露复杂策略。

## Scheduler 边界

scheduler 不复用用户聊天 runtime。

原因：

- scheduler 是后台一次性任务，不应污染用户当前热态聊天。
- scheduler 可能在用户不在线时触发，常驻会浪费资源。
- scheduler 结果通过 notification 投递，和 WebUI session 交互边界不同。

scheduler 继续使用 single-turn runner，并同样注入 `mcpServers`。如果某些定时任务依赖慢 MCP，后续再单独设计 scheduler runtime pool。

## 保留与重构范围

保留：

- SDK JSONL 作为业务历史读取来源。
- session list、rename、remove 的业务模型。
- `ToolRegistry`、权限、校验、审计。
- 内置工具维护自己的 tool prompt。
- `createClaudebotSdkMcpServer` 的内置工具桥接定位。
- scheduler 一次性 turn 设计。

重构：

- WebUI 用户聊天从 `ClaudeRunner.run(prompt)` 迁移到 `AgentRuntimeManager.runTurn()`。
- `makeRealQueryFactory()` 拆出 SDK options/MCP 组装逻辑，避免 single-turn 和 long-lived 重复。
- native tool context 改为动态引用。
- WebSocket `chat.cancel` 接入 runtime manager。
- `status` 事件扩展 MCP 状态字段。

## 明确不做

- 不实现 MCP client。
- 不启动或管理外部 MCP 进程。
- 不代理外部 MCP tool call。
- 不把外部 MCP tool 注册进 `ToolRegistry`。
- 不给外部 MCP 生成中央 prompt。
- 不兼容旧 MCP preset 或 nanobot adapter。
- 第一版不做 WebUI MCP 编辑器。

## 测试策略

后端测试：

- 配置 schema 接受合法 MCP server，拒绝 `claudebot` 重名。
- SDK options 组装包含 native `claudebot` 和外部 MCP，且设置 `strictMcpConfig`。
- `AgentRuntimeManager` 同一 session 多轮复用同一个 `Query` mock。
- `runTurn()` 在 running 状态拒绝并发 turn。
- `cancel()` 调用 `query.interrupt()`，不调用 `close()`。
- idle cleanup 调用 `query.close()`。
- native tool handler 使用最新 `contextRef.current`。
- `system/init` 的 `mcp_servers` 被归一化到 gateway status event。

集成测试：

- 使用一个轻量 stdio MCP server fixture，确认同一个 WebUI session 连续两轮只初始化一次。
- 关闭 idle runtime 后再次发送消息，确认能用 `resume` 建立新的 long-lived Query。

WebUI 可见行为测试：

- 如果本次实现改动展示层，需要按 AGENTS.md 要求使用真实 Chromium CDP 点击验证。
- 若第一版只改后端协议但前端未展示 MCP 状态，则 WebUI CDP 可以等展示层实现时再补。

## 风险与处理

- **Query 长期持有资源**：使用 idle TTL 和 server shutdown `closeAll()` 控制资源。
- **多 session 资源占用**：多个活跃 session 拥有多个 SDK runtime 和多组 MCP servers 是合理设计；第一版只在用户发送消息时创建 runtime，idle 后释放；后续可加最大活跃 runtime 数和 LRU 释放策略。
- **SDK streaming input 使用细节出错**：先用 mock 测 manager，再用最小 MCP fixture 做真实集成测试。
- **上下文串 session**：每个 session 使用独立 `contextRef`；同一 session 每次 turn 开始前更新；同一 session 并发 turn 第一版直接拒绝。
- **MCP 配置错误**：启动时做结构校验，运行时连接错误透传 SDK status/error。

## 迁移策略

不做旧数据迁移。已有 SDK JSONL session 继续作为 cold resume 来源；热态 runtime 是进程内状态，服务重启后自然丢弃并在下一次用户消息时重建。

## 推荐实施顺序

1. 扩展 config schema，加入 `mcp.strict` 和 `mcp.servers`。
2. 抽出 SDK MCP/options 组装函数。
3. 将 native MCP server context 改成 `contextRef`。
4. 实现 `AgentRuntimeManager`、input queue 和 output pump。
5. WebSocket 用户 turn 接入 manager，保留 scheduler single-turn。
6. 接入 `chat.cancel -> query.interrupt()`。
7. 扩展 MCP init/status 事件。
8. 补测试和最小 stdio MCP fixture。
