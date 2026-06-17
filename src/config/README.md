# Config 模块说明

`src/config/` 负责解析 Claudebot 运行时配置，并把用户输入归一化为内部稳定的 camelCase 对象。该模块只定义配置 schema、加载顺序、路径派生输入，不直接创建服务、读写业务数据或处理平台协议。

## 关键入口

- `schema.ts`: Zod v4 schema、默认值和导出的 `RuntimeConfig` 类型。
- `loader.ts`: 配置加载顺序、环境变量覆盖和 `resolveRuntimeConfig`。
- `paths.ts`: 由已解析配置派生所有运行时目录，是路径布局唯一来源。

## 数据流

配置来源按顺序解析：

1. `CLAUDEBOT_CONFIG` 指向的 JSON 文件；
2. `$CLAUDEBOT_HOME/config.json`；
3. schema 默认值。

`resolveRuntimeConfig` 会先通过 `RuntimeConfigSchema` 解析，再展开 `home`、`workspace.path`，最后应用 `CLAUDEBOT_HOST` 和 `CLAUDEBOT_PORT` 覆盖。新增路径必须放在 `paths.ts`，不要在业务模块里手写运行时目录。

## Channel 配置约定

`channels` 采用共享设置：

- 顶层：`sendProgress`、`sendToolHints`、`showReasoning`、`sendMaxRetries`。
- 单个平台：`enabled`、`allowFrom`、`streaming` 加平台专属字段。

配置只认 camelCase 字段名；adapter 统一读取 `allowFrom`（空数组表示允许全部，`*` 表示显式全放行）。

## 修改注意事项

- Zod v4 的 `.default()` 接收输出类型默认值；带 transform/preprocess 的默认对象要保持精确类型。
- 新增配置项必须同时更新 `tests/config.test.ts` 的默认值、显式值和 alias 覆盖。
- 修改运行时目录布局时必须更新根 `AGENTS.md` 的目录结构说明和 `runtimePaths` 测试。

## 测试

配置变更至少运行：

```bash
bun test tests/config.test.ts --timeout 30000
bun run typecheck
```

如果配置会影响 channel 启动或 adapter 行为，还应运行对应 channel 测试。
