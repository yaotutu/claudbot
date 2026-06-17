# Channels 模块说明

`src/channels/` 负责把外部聊天平台消息接入 Claudebot，并把 agent 回复送回对应平台。这个模块只处理 channel 协议、平台 adapter、权限/绑定/派发等边界，不拥有 Claude SDK 会话实现、WebUI 协议或具体工具逻辑。

## 架构方向

Channel 子系统采用 Nanobot channel 语义的 TypeScript 化协议：核心消息以 `channel`、`senderId`、`chatId`、`content`、`media`、`metadata` 和可选 `sessionKey` 为基础。平台 adapter 只负责把平台事件归一化为入站消息，以及把出站消息发送回平台。

后续重构应优先保持以下分层：

- `protocol.ts`: channel 入站/出站消息、metadata 约定、状态类型。
- `adapter.ts`: 函数式 `ChannelAdapter` 契约，包括 `start`、`stop`、`send`、可选 `handleHttp`、`login`、`sendDelta` 等。
- `manager.ts`: 启停 adapter、分发 HTTP、接收入站消息、派发出站消息、重试、stream/reasoning/progress metadata 处理。
- `runtime.ts`: 将归一化 channel turn 接入 `runUserTurn`，并维护外部 chat 到 Claudebot session 的绑定。
- `<platform>/`: 单个平台实现，只保留平台 SDK、事件归一化、发送、登录态和媒体处理。

## 设计约束

- 不引入 Nanobot Python runtime，也不支持直接加载 Nanobot Python channel 插件。
- 不复用 OpenClaw 重型 channel/plugin control plane。
- 不保留旧 channel 数据兼容负担；字段命名应收敛到 `chatId` 和 `sessionKey`。
- Adapter 不读取平台各自的旧 allow-list 字段；统一读取 `allowFrom`，空数组表示允许全部，`*` 表示显式全放行。
- 优先使用函数式模块，不新增类继承体系。
- 平台实现可以参考 Nanobot 对应 channel 文件，但必须落到 Claudebot 自己的 TypeScript 协议。

## 测试要求

Channel 行为变更至少覆盖：

- adapter 归一化测试；
- manager 启停/HTTP 分发/出站派发测试；
- session binding 创建与续接测试；
- 相关平台的真实启动或手动验证路径。

如果改动影响 WebUI 可见行为，仍需按根 `AGENTS.md` 要求使用 Chromium CDP 做页面点击验证。
