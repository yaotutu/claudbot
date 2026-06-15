# 仓库贡献指南

## 项目结构与模块组织

`src/` 是 Bun/TypeScript 运行时：`gateway/` 处理 HTTP 和 WebSocket 流量，`runtime/` 负责服务装配，`agent/` 封装 Claude SDK，`sessions/` 保存会话转录，`scheduler/` 运行定时任务，`tools/` 注册内置工具。根目录测试位于 `tests/*.test.ts`，测试夹具在 `tests/fixtures/`。React WebUI 独立放在 `webui/`；源码在 `webui/src/`，测试在 `webui/src/tests/`，生产构建输出到 `webui/dist/`。设计说明和计划位于 `docs/superpowers/`。

## 当前架构边界

本项目曾参考 openclaw/nanobot，但当前方向是 Claudebot 原生实现。WebUI 只保留 nanobot 风格的页面视觉、布局密度和基础交互体验；数据接口、WebSocket 协议、session/draft/remap 逻辑都应使用 Claudebot 自己的契约。不要为了兼容旧 nanobot adapter、旧 `ClientProvider`、旧 `useSessions`、旧 `useClaudebotStream` 协议而新增代码。历史消息格式和历史前端测试不要求兼容。

WebUI 原生数据入口集中在 `webui/src/lib/claudebot-api.ts`、`webui/src/lib/claudebot-ws.ts`、`webui/src/hooks/useClaudebotSessions.ts` 和 `webui/src/hooks/useClaudebotThread.ts`。后端 WebUI 契约集中在 `src/gateway/http.ts`、`src/gateway/protocol.ts` 和 `src/gateway/websocket.ts`。新增 WebUI 行为优先扩展这些原生边界。

Settings、Search、Skills 入口需要保留可见反馈。Settings 当前是只读运行状态面板；Search 和 Skills 可以先保持占位反馈，但不能点击无响应。New chat 应先创建本地 draft，会话首条消息发送后由后端 `session.created` remap 到真实 SDK session。

## 运行时目录结构

Claudebot 的运行时目录应区分“实例配置/运行数据”和“Agent 工作区”。默认实例目录是 `~/.claudebot/`，`workspace/` 是 agent 读写项目文件的默认工作区；如果 `config.json` 或环境变量显式覆盖 workspace，则业务运行时数据仍应留在实例目录中。

当前默认布局如下：

```text
~/.claudebot/
├── config.json
├── workspace/
├── profile/
│   ├── user.md
│   └── soul.md
├── memory/
│   └── memory.json
├── sessions/
│   └── <session-id>/
│       ├── main.jsonl
│       └── subagents/
├── schedules/
│   ├── jobs.json
│   └── runs/
│       └── <run-id>.json
├── webui/
│   ├── runtime_state.json
│   └── notifications.json
├── channels/
│   ├── channel-bindings.json
│   └── qq/
├── media/
├── logs/
├── audit/
│   └── tools.jsonl
└── claude/
    └── config/
```

`src/config/paths.ts` 是这些路径的唯一来源。不要重新引入旧的 `agent/user.md`、`agent/soul.md`、`agent/memory.json`、`scheduler/schedules.json`、`scheduler/runs.json` 或 `sdk-config/` 路径；本项目不为旧目录做兼容、alias 或数据迁移。Profile 文本放在 `profile/`，长期记忆放在 `memory/`，SDK JSONL 会话放在 `sessions/`，外部 channel 绑定放在 `channels/channel-bindings.json`，QQ Gateway 会话状态放在 `channels/qq/`，定时任务定义放在 `schedules/jobs.json`，每次定时任务执行记录独立写入 `schedules/runs/<run-id>.json`。

## 构建、测试与开发命令

除非特别说明，命令都从仓库根目录运行。

- `bun install`: 安装根运行时依赖。
- `bun run dev`: 同时启动 gateway 和 WebUI，支持 watch/HMR。
- `bun run dev:server`: 仅以 watch 模式运行 `src/server.ts`。
- `bun run dev:webui`: 仅启动 Vite WebUI。
- `bun run start`: 以非 watch 模式启动运行时。
- `bun run test`: 运行后端测试，脚本会限制在根 `tests/` 和 `src/`，避免误用 Bun 扫描 WebUI Vitest 测试。
- `bun run typecheck`: 对运行时执行严格 TypeScript 检查。
- `cd webui && bun run build`: 类型检查并构建 WebUI 包。
- `cd webui && bun run test`: 运行 Vitest WebUI 测试。
- `cd webui && bun run lint`: 运行 ESLint，且不允许 warning。

## 代码风格与命名约定

运行时使用 TypeScript ESM，并显式导入 `.ts` 文件。保持严格类型检查；除非需要匹配现有边界，否则优先使用小型函数式模块而不是类。使用两个空格缩进、双引号、分号和 camelCase。React 组件使用 PascalCase 的 `.tsx` 文件；hooks 使用 `useName.ts`。不要提交生成产物和本地运行时状态。

## 测试指南

后端测试使用 `bun:test`，命名为 `*.test.ts`。WebUI 测试使用 Vitest、Testing Library 和 `happy-dom`，命名为 `*.test.ts` 或 `*.test.tsx`。行为变更必须新增或更新测试。先运行最相关的小范围测试，再运行受影响区域的更大测试集，例如 `bun test tests/sessions.test.ts` 和 `cd webui && bun run test -- -t "thread"`。

涉及用户可见 WebUI 行为时，除了单元测试和构建，还要用真实 Chromium CDP 做点击验证。至少覆盖页面启动、Settings/Search/Skills 入口反馈、New chat draft 创建、发送一条短消息、会话 remap 或错误状态展示。验证后关闭本轮打开的标签页和启动的 gateway/Vite 进程。

## 文档与沟通

本仓库相关分析、计划、说明文档和面向用户的会话消息默认使用中文。新增到 `docs/` 或根目录的 agent/协作说明也应使用中文，除非是在引用外部 API 名称、代码标识符或已有英文 UI 文案。

## 提交与 Pull Request 规范

Git 历史基本遵循 Conventional Commits，例如 `fix(webui): ...`、`refactor(scheduler): ...` 和 `docs(CLAUDE.md): ...`。PR 应包含简短的问题/解决方案摘要、已运行的测试命令、相关 issue 链接；如果改动影响 WebUI 可见界面，还应附截图或录屏。

## 安全与配置提示

配置加载顺序为 `CLAUDEBOT_CONFIG`、`$CLAUDEBOT_HOME/config.json`，最后使用 schema 默认值。gateway 当前没有认证，且默认使用便于局域网访问的 host；不要把本地开发实例暴露到不可信网络。



# 以下内容为用户手动添加，优先级最高，禁止修改
- 遇见不合理的架构，积极重构，不必担心兼容性问题，旧的数据直接清空
- 优先使用函数式编程范式，避免使用类和复杂的继承体系
- 每次开发新功能，必须在页面上进行完整的测试，必须使用cdp链接浏览器进行测试，禁止使用自动化测试工具模拟用户行为，必须亲自点击验证功能的可用性
