# Tools 模块说明

`src/tools/` 注册 Claudebot 原生工具，并以 SDK MCP server 形式暴露给 Claude。本模块只管工具注册、权限、审计和 MCP 桥接，工具的业务实现分散在 `builtin/` 与对应领域模块。

## 关键入口

- `registry.ts`: `createToolRegistry` 持有工具 Map，提供 register / list / getPromptSections / execute，含权限检查与审计。
- `audit.ts`: `createToolAuditLog` 追加式审计日志（`audit/tools.jsonl`）。
- `permissions.ts`: `resolveToolPolicy` 基于 default + overrides 决策 allow / deny / confirm。
- `sdk-mcp-server.ts`: `createClaudebotSdkMcpServer` 把 registry 包成 SDK MCP server，名为 `claudebot`。
- `types.ts`: `NativeTool`、`ToolContext`、`ToolPrompt`。
- `builtin/`: `scheduler`、`memory`、`agent-files` 三组工具的注册函数。

## 数据流

SDK 调 `claudebot` MCP 工具 → `sdk-mcp-server` 从 `ToolContextRef.current` 取 context → `registry.execute` 校验 schema + 权限 + 审计 → 调领域实现。

## 修改注意

- 工具 `name` 不得为 `claudebot`（保留给原生 MCP server）。
- 优先函数式 closure；registry 内部用 Map，不暴露为 class。
- 新增工具同步更新 `tests/tools.test.ts` / `tests/tools-builtin.test.ts`。

## 测试

```bash
bun test tests/tools.test.ts tests/tools-builtin.test.ts --timeout 30000
```
