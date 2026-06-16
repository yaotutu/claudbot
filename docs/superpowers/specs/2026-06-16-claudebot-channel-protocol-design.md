# Claudebot Channel Protocol v1 设计

## 背景

Claudebot 是新项目，不需要兼容旧运行数据或旧 Nanobot adapter。当前 `src/channels/` 已经有 `runtime.ts`、`registry.ts`、Telegram adapter、QQ adapter 和 channel session binding，但协议边界仍偏薄：平台 adapter 直接调用 `runChannelTurn`，公共生命周期、权限、重试、流式 metadata 和模块文档约束还没有形成稳定 SDK。

Nanobot 的 channel 设计已经验证过一组清晰概念：`InboundMessage`、`OutboundMessage`、`BaseChannel`、`ChannelManager`、`MessageBus`、`allowFrom`、pairing、streaming、progress、reasoning 和 channel plugin discovery。我们不引入 Nanobot Python runtime，但采用它的 channel 语义作为 Claudebot channel 子系统的事实标准，并用 TypeScript 函数式模块重新实现。

## 目标

- 建立 Claudebot 自己的 Channel Protocol v1，字段和语义尽量贴近 Nanobot，方便迁移 Nanobot channel 资源。
- 保留 Claudebot 原生 Agent/SDK/session/WebUI 边界，不兼容 Nanobot WebUI、session、provider 或 tool 协议。
- 将 channel core 和平台 adapter 解耦，避免每个平台重复实现生命周期、权限、session binding、重试和 stream 派发。
- 为每个独立模块维护 README，并在根 `AGENTS.md` 建立模块 README 索引，作为后续 agent 修改前的入口。

## 非目标

- 不直接加载 Nanobot Python channel 插件。
- 不通过 Python 子进程托管 channel runtime。
- 不引入 OpenClaw channel/plugin control plane。
- 不迁移旧 channel bindings；字段重命名后旧数据可以清空。
- 不在第一阶段实现所有平台；第一阶段只迁移现有 Telegram/QQ 验证抽象。

## 协议

核心入站消息改为 Nanobot 风格：

```ts
export type ChannelInboundMessage = {
  channel: string;
  senderId: string;
  chatId: string;
  content: string;
  media: string[];
  metadata: Record<string, unknown>;
  sessionKey?: string;
};
```

核心出站消息：

```ts
export type ChannelOutboundMessage = {
  channel: string;
  chatId: string;
  content: string;
  replyTo?: string;
  media: string[];
  metadata: Record<string, unknown>;
  buttons?: string[][];
};
```

`conversationId` 不再作为核心字段。外部平台的会话标识统一进入 `chatId`；需要线程、话题、群内子会话或跨设备统一会话时，使用 `sessionKey` 覆盖默认 session key。

默认 session key 规则：

```text
sessionKey ?? `${channel}:${chatId}`
```

## Adapter 契约

Channel adapter 使用函数式对象，不使用类继承：

```ts
export type ChannelAdapter = {
  name: string;
  displayName: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  send: (msg: ChannelOutboundMessage) => Promise<void>;
  handleHttp?: (req: Request, url: URL) => Promise<Response | null>;
  login?: (options?: { force?: boolean }) => Promise<boolean>;
  status?: () => Promise<ChannelStatus>;
  sendDelta?: (chatId: string, delta: string, metadata?: Record<string, unknown>) => Promise<void>;
  sendReasoningDelta?: (chatId: string, delta: string, metadata?: Record<string, unknown>) => Promise<void>;
  sendReasoningEnd?: (chatId: string, metadata?: Record<string, unknown>) => Promise<void>;
};
```

公共 helper 提供 adapter context：

- `emitInbound(message)`: 经过 allowlist/pairing 后提交给 manager。
- `isAllowed(senderId)`: 基于 `allowFrom` 和 pairing store。
- `mediaRoot(channel)`: 返回平台媒体目录。
- `log`: channel-scoped logger。

平台目录只处理平台 SDK 和协议细节，例如 Telegram Bot API、QQ Bot SDK、Feishu/Lark event、Weixin iLink 长轮询、媒体上传下载和平台 markdown 渲染。

## Manager

新增 `src/channels/manager.ts`，对标 Nanobot `ChannelManager`，但不引入独立 Python 风格 bus。manager 直接接 Claudebot `runChannelTurn`：

```text
platform event
  -> adapter normalize
  -> emitInbound(ChannelInboundMessage)
  -> manager
  -> runChannelTurn
  -> ChannelOutboundMessage
  -> adapter.send / sendDelta / sendReasoningDelta
```

manager 负责：

- 根据 config 创建 enabled adapters；
- 启动/停止 adapters；
- 分发 HTTP route；
- 处理 allowlist、pairing 和未授权 DM 回复；
- 调用 `runChannelTurn`；
- 管理 channel session binding；
- 派发出站消息；
- 统一 send retry；
- 合并 `_stream_delta`；
- 处理 `_progress`、`_tool_hint`、`_reasoning_delta`、`_reasoning_end`、`_file_edit_events` 等 metadata。

## 配置

`channels` 配置采用 Nanobot 语义，内部使用 camelCase，并读取 snake_case alias：

```json
{
  "channels": {
    "sendProgress": true,
    "sendToolHints": false,
    "showReasoning": true,
    "sendMaxRetries": 3,
    "telegram": {
      "enabled": true,
      "allowFrom": ["*"],
      "streaming": true
    }
  }
}
```

已有 `telegram`、`feishu`、`qq` 配置会重排到该公共语义下。旧字段可以直接删除，不做迁移。

## 模块文档规则

每个具备独立职责的模块目录必须有本目录 `README.md`。README 至少说明：

- 模块职责和非职责；
- 关键入口文件；
- 核心数据流；
- 与其他模块的边界；
- 修改时应运行的测试；
- 平台或业务特有注意事项。

根 `AGENTS.md` 的“模块 README 索引”必须引用这些 README。新增模块或大幅重构模块时，同步更新模块 README 和索引。

Channel 模块的第一份 README 为 `src/channels/README.md`。

## 实施顺序

1. 新增/调整 `protocol.ts`、`adapter.ts`、`manager.ts` 和 channel context helper。
2. 将 `types.ts` 的 `conversationId` 改为 `chatId/sessionKey`。
3. 调整 session binding store 的外部会话字段命名。
4. 将 Telegram adapter 迁移到新 `ChannelAdapter` 契约。
5. 将 QQ adapter 迁移到新 `ChannelAdapter` 契约。
6. 删除旧 registry 中隐含的 adapter 约定，改由 manager 统一装配。
7. 更新测试并运行后端相关测试。
8. 如果 WebUI 可见入口受影响，按根 `AGENTS.md` 使用 Chromium CDP 验证。

## 测试策略

- 协议层：字段默认值、session key 解析、metadata 识别。
- manager：启停顺序、HTTP route 分发、send retry、stream delta 合并、reasoning/progress 开关。
- runtime：新 chat binding 创建、已有 binding 续接、错误出站消息。
- Telegram/QQ：平台事件归一化、allowlist、发送回复。
- 配置：camelCase 与 snake_case alias、默认值、禁用平台不加载 SDK。

## 风险和取舍

最大收益是后续迁移 Nanobot channel 资源时概念一致，减少重新设计成本。主要风险是一次性重构会触及现有 Telegram/QQ 测试和配置 schema；由于这是新项目且允许清空旧数据，这个风险可接受。

不直接兼容 Nanobot Python 插件是有意取舍。直接兼容会引入 Python 环境、子进程生命周期、JSON bridge、媒体路径映射和错误恢复，复杂度高于用 TypeScript 重新实现 adapter。

## 自审

- 本设计没有保留旧 `conversationId` 兼容要求，符合新项目可清空旧数据的约束。
- Channel 协议只影响 `src/channels/`、`src/config/` 和相关 tests，不改变 WebUI 原生数据边界。
- 模块 README 规则已写入根 `AGENTS.md`，并新增 `src/channels/README.md` 作为首个索引项。
