# MCP 模块说明

`src/mcp/` 提供 MCP 相关的只读状态查询，供 WebUI MCP 面板消费。本模块不启动或管理 MCP server 进程（那由 SDK + `agent/sdk-options.ts` 负责）。

## 关键入口

- `status.ts`: 从 `agentRuntimeManager` 读取会话级 MCP server 状态（`WebuiMcpSessionStatus`），供 HTTP `/mcp/...` 端点调用。

## 修改注意

- 状态查询只读；重连等副作用走 `agentRuntimeManager.reconnectMcpServer`。
- MCP server 配置 schema 在 `config/schema.ts`（`mcp.servers`）。

## 测试

MCP 状态行为由 `tests/agent-runtime-manager.test.ts`、`tests/gateway.test.ts` 间接覆盖。
