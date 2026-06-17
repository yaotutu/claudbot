# Nanobot WebUI Transplant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不变更 Claudebot 后端 HTTP/WebSocket 协议的前提下，把 WebUI 主体验迁移到 Nanobot 风格的页面壳、侧边栏、线程视图和 composer。

**Architecture:** 后端协议继续由 `webui/src/lib/claudebot-api.ts`、`webui/src/lib/claudebot-ws.ts`、`webui/src/hooks/useClaudebotSessions.ts`、`webui/src/hooks/useClaudebotThread.ts` 承接。新增前端 UI 适配层把 Claudebot 的 `SessionSummary/DraftSession/ThreadMessage` 映射成 Nanobot 风格组件需要的视图模型；所有对不齐的地方改页面逻辑，不新增 Nanobot 后端兼容协议。

**Tech Stack:** React 18、TypeScript、Vite、Tailwind、Bun、Radix UI primitives、lucide-react。

---

### Task 1: 文档边界

**Files:**
- Create: `webui/src/claudebot-ui/README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: 创建模块 README**

写清楚 `webui/src/claudebot-ui/` 只负责 Nanobot 风格 UI 适配，禁止引入 Nanobot 后端 client、token、旧 session/stream 协议。

- [ ] **Step 2: 更新 AGENTS 模块索引**

在“模块 README 索引”加入 `webui/src/claudebot-ui/README.md`，不修改用户保护区。

### Task 2: 先写 WebUI 行为测试

**Files:**
- Modify: `webui/src/tests/app-native-layout.test.tsx`

- [ ] **Step 1: 测试 Nanobot 风格主壳**

断言页面保留 `New chat`、`Search`、`Skills`、`Tasks`、`Settings`，新增折叠侧边栏按钮、Nanobot 风格空态标题和模型 badge。

- [ ] **Step 2: 测试原生协议仍然发送**

通过现有 mock WebSocket 断言 `chat.send` 入参仍是 `{ draftId | sessionId, content }`，不出现 Nanobot token/client 协议。

- [ ] **Step 3: 运行测试确认失败**

Run: `cd webui && bun run test -- src/tests/app-native-layout.test.tsx`

Expected: FAIL，因为新 UI 控件和文案还不存在。

### Task 3: UI 适配层和 Nanobot 风格组件

**Files:**
- Create: `webui/src/claudebot-ui/types.ts`
- Create: `webui/src/claudebot-ui/adapter.ts`
- Create: `webui/src/claudebot-ui/ClaudebotShell.tsx`
- Create: `webui/src/claudebot-ui/ClaudebotSidebar.tsx`
- Create: `webui/src/claudebot-ui/ClaudebotThread.tsx`
- Create: `webui/src/claudebot-ui/ClaudebotComposer.tsx`
- Create: `webui/src/claudebot-ui/ClaudebotPanels.tsx`
- Create: `webui/src/lib/utils.ts`
- Modify: `webui/src/App.tsx`

- [ ] **Step 1: 定义 UI view model**

`ClaudebotChatSummary` 用 `key/id/title/preview/createdAt/updatedAt/status` 表达列表项；`ClaudebotUIMessage` 用 `role/content/isStreaming/createdAt` 表达线程消息。

- [ ] **Step 2: 实现映射函数**

`toClaudebotChats()` 和 `toClaudebotMessages()` 只做前端映射，不改后端 payload。

- [ ] **Step 3: 搭建 Nanobot 风格 shell**

侧边栏支持折叠、分组、session action 菜单、utility 入口；主线程区支持 header、空态、消息流、底部 composer、streaming 状态。

- [ ] **Step 4: 替换 App 主布局**

`App.tsx` 保留 bootstrap/ws/session/thread hooks，渲染 `ClaudebotShell`。

### Task 4: 依赖与构建

**Files:**
- Modify: `webui/package.json`
- Modify: `webui/tailwind.config.js`

- [ ] **Step 1: 加入 Nanobot UI 必需依赖**

加入 Radix dropdown/tooltip/dialog/slot/separator、`clsx`、`tailwind-merge`、`class-variance-authority`、`tailwindcss-animate`。

- [ ] **Step 2: 同步 Tailwind 插件**

启用 `tailwindcss-animate`，补齐 accordion animation keyframes。

- [ ] **Step 3: 安装依赖**

Run: `cd webui && bun install`

Expected: dependencies resolve and lockfile updates.

### Task 5: 验证

**Files:**
- No direct file changes.

- [ ] **Step 1: WebUI 单测**

Run: `cd webui && bun run test -- src/tests/app-native-layout.test.tsx`

- [ ] **Step 2: WebUI lint/build**

Run: `cd webui && bun run lint`

Run: `cd webui && bun run build`

- [ ] **Step 3: 根测试**

Run: `bun run test`

Run: `bun run typecheck`

- [ ] **Step 4: CDP 真实浏览器验证**

启动本地 dev 服务，用 CDP 点击验证页面启动、Settings/Search/Skills/Tasks、New chat、发送短消息、session remap 或错误状态展示。验证后关闭标签页和服务进程。
