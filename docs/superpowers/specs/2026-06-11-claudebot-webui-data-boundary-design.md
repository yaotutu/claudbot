# Claudebot WebUI 原生数据层重构设计

## 目标

保留 nanobot WebUI 的视觉风格、页面结构和主要交互手感，但彻底移除对 nanobot 后端协议、nanobot 数据 shape、旧 adapter 兼容逻辑和旧历史消息展示行为的依赖。新的 WebUI 应该以 claudebot 自己的运行时能力为中心：SDK session、JSONL transcript、WebSocket streaming、运行状态、工具/调度能力和本地单用户使用场景。

## 明确不兼容项

本次重构允许破坏以下历史兼容：

- 不兼容 nanobot 的 `/api/sessions` 包装格式、`webui-thread` 快照格式、workspace scope payload、settings payload、skills catalog payload。
- 不兼容旧的前端 adapter 行为，例如用 nanobot `ChatSummary`、`InboundEvent`、`UIMessage` 作为真实业务模型。
- 不保证旧历史消息以原来的 UI 形态展示。后端仍可以读取当前 SDK JSONL，但旧 WebUI 展示快照和旧 nanobot transcript 不作为迁移对象。
- 不保留点击无反馈的入口。所有可见入口要么实现真实功能，要么给出明确的当前状态说明。

## 保留项

- 保留 nanobot 的左侧会话栏、聊天主区域、消息气泡、输入框、流式输出、工具活动折叠展示等视觉/交互体验。
- 可以复用现有组件中的纯展示部分，但数据流、hook、client、API 类型和运行状态管理可以重写。
- `New chat` 继续是本地草稿会话，第一条消息后由 SDK 创建真实 session，再由前端完成草稿到真实 session 的替换。
- Settings 先做只读运行状态视图。
- Search 和 Skills 先保留入口并显示当前 MVP 状态反馈，不做完整功能。
- 允许真实浏览器测试阶段发送一条短模型消息。

## 新架构

### 后端 WebUI API

后端提供 claudebot 原生 WebUI API，不再模拟 nanobot：

```ts
type WebuiBootstrap = {
  runtime: RuntimeInfo;
  ws: { path: string };
  sessions: SessionSummary[];
  activeSessionId: string | null;
};

type RuntimeInfo = {
  home: string;
  workspace: string;
  gateway: { host: string; port: number };
  model: string;
  permissionMode: string;
};

type SessionSummary = {
  id: string;
  title: string;
  preview: string;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
};
```

接口：

- `GET /webui/bootstrap`：返回 `WebuiBootstrap`。
- `GET /api/sessions`：返回 `SessionSummary[]`。
- `GET /api/sessions/:id/messages`：返回 `ThreadMessage[]`。
- `PATCH /api/sessions/:id`：修改 title。
- `DELETE /api/sessions/:id`：删除 session。
- `POST /api/sessions/:id/activate`：激活已有 persisted session。
- `GET /api/runtime`：返回 `RuntimeInfo`，Settings 只读面板使用。

### 后端 WebSocket 协议

WebSocket 使用 claudebot 原生 envelope：

```ts
type ClientFrame =
  | { type: "session.activate"; sessionId: string | null }
  | { type: "chat.send"; draftId?: string; sessionId?: string; content: string }
  | { type: "chat.cancel"; sessionId: string };

type ServerFrame =
  | { type: "session.activated"; sessionId: string | null }
  | { type: "session.created"; draftId?: string; session: SessionSummary }
  | { type: "session.updated"; session: SessionSummary }
  | { type: "message.appended"; sessionId: string; message: ThreadMessage }
  | { type: "run.started"; sessionId: string; runId: string }
  | { type: "run.delta"; sessionId: string; runId: string; text: string }
  | { type: "run.thinking"; sessionId: string; runId: string; text: string }
  | { type: "run.tool"; sessionId: string; runId: string; tool: ToolEvent }
  | { type: "run.completed"; sessionId: string; runId: string; isError: boolean }
  | { type: "run.error"; sessionId?: string; runId?: string; message: string };
```

本阶段可以保留旧 frame 到新 frame 的最小兼容桥，只用于降低一次性改动风险；但新前端只消费新协议。

### 前端数据层

新增 claudebot 原生数据层：

- `webui/src/lib/claudebot-types.ts`：原生类型。
- `webui/src/lib/claudebot-api.ts`：HTTP API。
- `webui/src/lib/claudebot-ws.ts`：WebSocket client。
- `webui/src/hooks/useClaudebotSessions.ts`：session list、draft session、active session、rename/delete。
- `webui/src/hooks/useClaudebotThread.ts`：message history、streaming、tool events、send/cancel。

旧的 `webui/src/lib/api.ts`、`webui/src/lib/claudebot-client.ts`、`webui/src/hooks/useSessions.ts` 和 `webui/src/hooks/useClaudebotStream.ts` 可以被替换、瘦身或废弃，不需要保持旧调用形状。

### UI 边界

前端可以继续使用现有 `Sidebar`、`ThreadShell`、`ThreadComposer`、`ThreadMessages`、`MessageBubble` 等展示组件，但推荐先建立新的轻量容器：

- `App` 负责 bootstrap、client 生命周期和顶层布局。
- `Sidebar` 接收 claudebot 原生 session view model。
- `ThreadView` 接收 claudebot 原生 message view model。
- 必要时只保留现有组件的 CSS/视觉结构，重写数据驱动逻辑。

## 行为要求

### 首屏

- 页面加载后显示真实 session title/preview。
- 如果没有 session，显示可直接输入的新聊天界面。
- 连接状态清晰显示。

### New chat

- 点击 `New chat` 创建本地 draft session，active id 为 draft id。
- 草稿 session 可以显示在侧边栏，状态为 `New chat`。
- 发送第一条消息后，服务端返回真实 session summary，前端用真实 id 替换 draft id。
- 替换后流式内容继续显示在同一个线程中。

### Settings/Search/Skills

- Settings 打开只读运行状态面板。
- Search 打开当前 MVP 说明面板，例如“会话搜索将在后续版本实现”。
- Skills 打开当前 MVP 说明面板，例如“技能目录暂未接入，当前工具由运行时内置”。

### 历史消息

- 只要求当前 SDK JSONL 能解析成基础用户/助手消息。
- 不要求旧 nanobot WebUI 快照、旧 media attachment、旧 workspace scope 或旧 trace row 完整复原。

## 测试要求

实现必须先写失败测试：

- 后端 API 契约测试：bootstrap、sessions、runtime。
- 后端 WebSocket 契约测试：draft send 后发出 `session.created`、`run.delta`、`run.completed`。
- 前端 API 测试：解析原生 `SessionSummary` 和 `RuntimeInfo`。
- 前端 hook 测试：draft session、remap、send streaming、sidebar preview 更新。
- App 测试：Settings/Search/Skills 点击后有可见面板。
- 命令测试：根目录测试不误跑 WebUI Vitest；WebUI Vitest 独立通过。

## 真实页面验证

必须使用 CDP 操作真实 Chromium：

1. 启动 gateway 和 WebUI。
2. 打开页面并截图首屏。
3. 确认已有 session title/preview 显示正确。
4. 点击 Settings，确认只读运行状态面板展示 model、workspace、home、gateway、permission mode。
5. 点击 Search，确认显示 MVP 说明。
6. 点击 Skills，确认显示 MVP 说明。
7. 点击 New chat，输入短消息，例如 `请用一句话回复：测试 claudebot webui`。
8. 发送并确认出现流式回复、session 从 draft 变为真实 session、侧边栏 title/preview 更新。
9. 请求 `/api/sessions`，确认返回真实 summary shape。
10. 保存验证截图，关闭浏览器标签，停止本轮启动的后台进程。

## 非目标

本次不实现完整 settings 编辑、完整会话搜索、完整 skills catalog、workspace 切换、file preview、权限确认 UI、完整取消运行、旧历史数据迁移。
