# Claudebot WebUI 原生数据层重构实施计划

> **给 agentic workers 的要求：** 实施本计划时必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。每个任务按 checkbox（`- [ ]`）推进，先写失败测试，再写实现，再验证。

**目标：** 在保留 nanobot 视觉和交互体验的前提下，把 WebUI 数据层重构为 claudebot 原生模型，不再兼容 nanobot 后端协议、旧 adapter 或旧历史展示快照。

**架构：** 后端暴露 claudebot 原生 `RuntimeInfo`、`SessionSummary`、`ThreadMessage` 和 WebSocket run frames；前端新增原生 API/client/hooks，只在 UI 展示边界复用现有视觉组件或 CSS。`New chat` 是本地 draft session，第一条消息后由 `session.created` 替换为真实 SDK session。

**技术栈：** Bun、TypeScript、React 18、Vite、Vitest、Tailwind、CDP Chromium 自动化。

---

## 文件结构

- 修改：`src/gateway/protocol.ts`，定义 claudebot 原生 WebSocket frame 类型。
- 修改：`src/gateway/http.ts`，新增 canonical summary helper，统一 `/webui/bootstrap`、`/api/sessions`、`/api/runtime`。
- 修改：`src/gateway/websocket.ts`，把旧 `chat.user_message` 流程改为新 `chat.send` / `session.created` / `run.*` frame。
- 修改：`tests/gateway.test.ts`，覆盖 HTTP 和 WS 原生契约。
- 新建：`webui/src/lib/claudebot-types.ts`，定义前端原生数据模型。
- 新建：`webui/src/lib/claudebot-api.ts`，实现 HTTP API client。
- 新建：`webui/src/lib/claudebot-ws.ts`，实现 WebSocket client。
- 新建：`webui/src/hooks/useClaudebotSessions.ts`，管理 session list、draft、active、remap、rename/delete。
- 新建：`webui/src/hooks/useClaudebotThread.ts`，管理 thread history、streaming、send。
- 修改：`webui/src/App.tsx`，改为使用 claudebot 原生 hooks，并实现 Settings/Search/Skills 可见面板。
- 可修改：`webui/src/components/Sidebar.tsx`、`webui/src/components/thread/*`，只做必要的展示适配；不保留旧 nanobot 数据依赖。
- 修改：`webui/src/tests/*`，删除或替换旧 adapter 契约测试，新增原生数据层测试。
- 修改：`package.json`，修正根目录测试命令，避免误跑 WebUI Vitest。

---

## Task 1：后端 HTTP 原生契约

**文件：**
- 修改：`src/gateway/http.ts`
- 修改：`tests/gateway.test.ts`

- [ ] **Step 1：写失败测试：`/api/sessions` 返回完整 summary**

在 `tests/gateway.test.ts` 增加测试，断言 seeded SDK session 返回 `title/preview/createdAt/updatedAt/messageCount/status`。

```ts
test("GET /api/sessions returns canonical WebUI session summaries", async () => {
  const services = await makeTestServices();
  await services.sdkSessions.append("claudebot", "sess_api", [
    JSON.stringify({ type: "user", message: { role: "user", content: "hello world" }, timestamp: "2026-06-10T09:59:40.000Z" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hi" }, timestamp: "2026-06-10T09:59:45.000Z" }),
  ]);
  await services.sdkSessions.rename("sess_api", "hello world");

  const res = await handleHttp(new Request("http://x/api/sessions"), new URL("http://x/api/sessions"), services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body[0]).toMatchObject({
    id: "sess_api",
    title: "hello world",
    preview: "hello world",
    messageCount: 2,
    status: "persisted",
  });
  expect(typeof body[0].updatedAt).toBe("string");
});
```

- [ ] **Step 2：运行失败测试**

运行：`bun test tests/gateway.test.ts -t "canonical WebUI session summaries"`

预期：失败，当前 `/api/sessions` 只有 `{ id, mtime }`。

- [ ] **Step 3：实现 canonical summary helper**

在 `src/gateway/http.ts` 中抽出 `buildSessionSummary()` 和 `listSessionSummaries()`，让 `/webui/bootstrap` 和 `/api/sessions` 共用。

```ts
async function buildSessionSummary(services: ServiceContainer, sessionId: string, mtime: number) {
  const info = await services.sdkSessions.info(sessionId);
  const mainFile = Bun.file(join(services.paths.sessionsDir, sessionId, "main.jsonl"));
  const text = await mainFile.exists() ? await mainFile.text() : "";
  const lines = text.split("\n").filter((line) => line.length > 0);
  const firstPrompt = info?.firstPrompt ?? extractFirstUserText(lines) ?? "";
  return {
    id: sessionId,
    title: info?.customTitle ?? info?.summary ?? firstPrompt ?? "New chat",
    preview: firstPrompt,
    createdAt: extractFirstTimestamp(lines),
    updatedAt: new Date(mtime).toISOString(),
    messageCount: lines.length,
    status: "persisted" as const,
  };
}
```

- [ ] **Step 4：运行后端测试**

运行：`bun test tests/gateway.test.ts -t "canonical WebUI session summaries"`

预期：通过。

- [ ] **Step 5：增加 `/api/runtime` 测试和实现**

测试断言返回 `home/workspace/gateway/model/permissionMode`。实现时从 `services.config` 和 `services.paths` 读取。

- [ ] **Step 6：提交**

```bash
git add src/gateway/http.ts tests/gateway.test.ts
git commit -m "feat(webui): expose native session summaries"
```

---

## Task 2：后端 WebSocket 原生 run frames

**文件：**
- 修改：`src/gateway/protocol.ts`
- 修改：`src/gateway/websocket.ts`
- 修改：`tests/gateway.test.ts`

- [ ] **Step 1：写失败测试：draft send 创建真实 session**

新增 mocked runner 测试：发送 `{ type: "chat.send", draftId: "draft-1", content: "ping" }` 后，客户端收到 `run.started`、`session.created`、`run.delta`、`run.completed`。

```ts
test("WebSocket chat.send emits native run frames and creates session from draft", async () => {
  const frames = await runMockedWsTurn({
    input: { type: "chat.send", draftId: "draft-1", content: "ping" },
    runnerEvents: [
      { type: "text_delta", text: "pong", sessionId: "sdk-1" },
      { type: "turn_done", sessionId: "sdk-1", isError: false, result: "pong" },
    ],
  });
  expect(frames.map((frame) => frame.type)).toEqual([
    "run.started",
    "session.created",
    "run.delta",
    "run.completed",
    "message.appended",
  ]);
  expect(frames.find((frame) => frame.type === "session.created")).toMatchObject({ draftId: "draft-1" });
});
```

- [ ] **Step 2：运行失败测试**

运行：`bun test tests/gateway.test.ts -t "native run frames"`

预期：失败，因为协议和 handler 还没有新 frame。

- [ ] **Step 3：更新 `src/gateway/protocol.ts` 类型**

新增 `chat.send`、`session.created`、`run.started`、`run.delta`、`run.thinking`、`run.tool`、`run.completed`、`run.error`。

- [ ] **Step 4：实现 WebSocket 新协议**

在 `handleClientMessage()` 支持 `chat.send`，在 `runUserTurn()` 中按事件发送新 frame。第一条新 session 检测到真实 `lastSessionId` 后发送 `session.created`。

- [ ] **Step 5：保留最小旧入口桥**

旧 `{ type: "chat.user_message" }` 可以转成 `chat.send`，只为降低测试和启动风险；前端新代码不再使用旧入口。

- [ ] **Step 6：运行测试**

运行：`bun test tests/gateway.test.ts`

预期：通过。

- [ ] **Step 7：提交**

```bash
git add src/gateway/protocol.ts src/gateway/websocket.ts tests/gateway.test.ts
git commit -m "feat(webui): add native websocket run frames"
```

---

## Task 3：前端原生 API 和类型

**文件：**
- 新建：`webui/src/lib/claudebot-types.ts`
- 新建：`webui/src/lib/claudebot-api.ts`
- 新建：`webui/src/tests/claudebot-api.test.ts`

- [ ] **Step 1：写失败测试**

测试 `fetchBootstrap()`、`listSessions()`、`fetchRuntime()` 解析原生 shape。

- [ ] **Step 2：运行失败测试**

运行：`cd webui && /home/yaotutu/.bun/bin/bun run test -- src/tests/claudebot-api.test.ts`

预期：失败，文件不存在。

- [ ] **Step 3：实现类型和 API client**

`claudebot-types.ts` 定义 `RuntimeInfo`、`SessionSummary`、`ThreadMessage`、`DraftSession`、`ServerFrame`、`ClientFrame`。

`claudebot-api.ts` 实现 `fetchBootstrap()`、`fetchRuntime()`、`listSessions()`、`fetchThreadMessages()`、`deleteSession()`、`renameSession()`。

- [ ] **Step 4：运行测试**

运行：`cd webui && /home/yaotutu/.bun/bin/bun run test -- src/tests/claudebot-api.test.ts`

预期：通过。

- [ ] **Step 5：提交**

```bash
git add webui/src/lib/claudebot-types.ts webui/src/lib/claudebot-api.ts webui/src/tests/claudebot-api.test.ts
git commit -m "feat(webui): add native API client"
```

---

## Task 4：前端原生 WebSocket client

**文件：**
- 新建：`webui/src/lib/claudebot-ws.ts`
- 新建：`webui/src/tests/claudebot-ws.test.ts`

- [ ] **Step 1：写失败测试**

覆盖：连接状态、发送 `chat.send`、收到 `session.created` 触发 remap handler、收到 `run.delta` 路由到对应 session/run。

- [ ] **Step 2：运行失败测试**

运行：`cd webui && /home/yaotutu/.bun/bin/bun run test -- src/tests/claudebot-ws.test.ts`

预期：失败。

- [ ] **Step 3：实现 `ClaudebotWsClient`**

提供 `connect()`、`close()`、`sendMessage()`、`activateSession()`、`onFrame()`、`onStatus()`。测试中使用可注入 socket factory。

- [ ] **Step 4：运行测试**

运行：`cd webui && /home/yaotutu/.bun/bin/bun run test -- src/tests/claudebot-ws.test.ts`

预期：通过。

- [ ] **Step 5：提交**

```bash
git add webui/src/lib/claudebot-ws.ts webui/src/tests/claudebot-ws.test.ts
git commit -m "feat(webui): add native websocket client"
```

---

## Task 5：前端 session/thread hooks 重构

**文件：**
- 新建：`webui/src/hooks/useClaudebotSessions.ts`
- 新建：`webui/src/hooks/useClaudebotThread.ts`
- 新建：`webui/src/tests/useClaudebotSessions.test.tsx`
- 新建：`webui/src/tests/useClaudebotThread.test.tsx`

- [ ] **Step 1：写 session hook 失败测试**

覆盖：初始 sessions、创建 draft、`session.created` 替换 draft、preview 更新、delete/rename。

- [ ] **Step 2：写 thread hook 失败测试**

覆盖：加载 messages、发送消息、流式 delta 拼接、run completed 后关闭 streaming。

- [ ] **Step 3：运行失败测试**

运行：`cd webui && /home/yaotutu/.bun/bin/bun run test -- src/tests/useClaudebotSessions.test.tsx src/tests/useClaudebotThread.test.tsx`

预期：失败。

- [ ] **Step 4：实现 hooks**

hooks 只依赖 `claudebot-api.ts` 和 `claudebot-ws.ts`，不依赖旧 `api.ts`、旧 `claudebot-client.ts`、旧 `useSessions.ts`、旧 `useClaudebotStream.ts`。

- [ ] **Step 5：运行测试**

运行：`cd webui && /home/yaotutu/.bun/bin/bun run test -- src/tests/useClaudebotSessions.test.tsx src/tests/useClaudebotThread.test.tsx`

预期：通过。

- [ ] **Step 6：提交**

```bash
git add webui/src/hooks/useClaudebotSessions.ts webui/src/hooks/useClaudebotThread.ts webui/src/tests/useClaudebotSessions.test.tsx webui/src/tests/useClaudebotThread.test.tsx
git commit -m "feat(webui): manage native sessions and threads"
```

---

## Task 6：App 接入原生数据层和可见反馈面板

**文件：**
- 修改：`webui/src/App.tsx`
- 可修改：`webui/src/components/Sidebar.tsx`
- 新建或修改：`webui/src/tests/app-native-layout.test.tsx`

- [ ] **Step 1：写失败测试**

覆盖：首屏显示 session title、点击 Settings 显示 runtime info、点击 Search 显示 MVP 说明、点击 Skills 显示 MVP 说明、点击 New chat 显示 draft。

- [ ] **Step 2：运行失败测试**

运行：`cd webui && /home/yaotutu/.bun/bin/bun run test -- src/tests/app-native-layout.test.tsx`

预期：失败。

- [ ] **Step 3：重写 App 数据流**

`App.tsx` 使用新 API/client/hooks。保留页面布局和视觉风格，但去掉旧 no-op handler。Settings/Search/Skills 打开对话框或侧栏面板。

- [ ] **Step 4：运行测试**

运行：`cd webui && /home/yaotutu/.bun/bin/bun run test -- src/tests/app-native-layout.test.tsx`

预期：通过。

- [ ] **Step 5：提交**

```bash
git add webui/src/App.tsx webui/src/components/Sidebar.tsx webui/src/tests/app-native-layout.test.tsx
git commit -m "feat(webui): wire app to native data layer"
```

---

## Task 7：测试命令、构建和旧测试清理

**文件：**
- 修改：`package.json`
- 修改或删除：旧 WebUI adapter 测试文件

- [ ] **Step 1：修正根目录测试命令**

把根 `test` 脚本改成只跑后端测试，例如：

```json
"test": "bun test tests src --timeout 30000"
```

如果 Bun 仍会误跑 `webui/src/tests`，改为显式列出 `tests/**/*.test.ts` 和 `src/**/*.test.ts` 支持的命令形式。

- [ ] **Step 2：删除或替换旧 WebUI adapter 测试**

旧 `api.test.ts`、`claudebot-client.test.ts`、`useSessions.test.tsx`、`useClaudebotStream.test.tsx`、`sessions-api-shape.test.ts` 如果仍绑定旧协议，改为新协议测试或删除。

- [ ] **Step 3：运行全量自动化验证**

运行：

```bash
bun run typecheck
bun test
cd webui && /home/yaotutu/.bun/bin/bun run test
cd webui && /home/yaotutu/.bun/bin/bun run build
```

预期：全部通过。允许 Vite chunk size warning，但不允许 TypeScript 或测试失败。

- [ ] **Step 4：提交**

```bash
git add package.json webui/src/tests
git commit -m "test(webui): align tests with native data layer"
```

---

## Task 8：真实页面 CDP 验证

**文件：**
- 不要求修改文件，除非验证发现 bug。

- [ ] **Step 1：启动服务**

运行：`bun run dev`

记录 gateway 和 WebUI URL。若端口占用，先清理本项目相关进程，再重试。

- [ ] **Step 2：CDP 打开页面**

运行：

```bash
cd /home/yaotutu/code/skills-edit/skills/browser-cdp
uv run cdp.py new http://127.0.0.1:5173
```

- [ ] **Step 3：首屏截图和断言**

等待 `#root`，截图到 `/tmp/claudebot-native-first.png`。断言侧边栏显示真实 title/preview，不再把 persisted session 显示成错误的 `New chat`。

- [ ] **Step 4：点击 Settings/Search/Skills**

用 CDP eval 找到文本为 Settings/Search/Skills 的按钮并 click。每次点击后断言页面出现对应面板文字。

- [ ] **Step 5：真实模型消息验证**

点击 `New chat`，输入：`请用一句话回复：测试 claudebot webui`，点击发送。等待 streaming 文本出现和完成。断言：

- draft 会话被真实 session id 替换。
- 侧边栏 title/preview 更新。
- `/api/sessions` 返回新 session summary。

- [ ] **Step 6：截图和清理**

保存 `/tmp/claudebot-native-after-send.png`，关闭 CDP 标签，停止本轮启动的 `bun run dev` / gateway / vite 进程。

- [ ] **Step 7：最终提交**

```bash
git status --short
git add docs/superpowers/specs/2026-06-11-claudebot-webui-data-boundary-design.md docs/superpowers/plans/2026-06-11-claudebot-webui-native-refactor.md
git commit -m "docs(webui): plan native data layer refactor"
```

实现提交应按前面任务拆分完成；最终确认工作树只剩用户已有无关改动。

---

## 自检

- 本计划覆盖了 spec 中的 HTTP 原生契约、WebSocket 原生契约、前端原生数据层、Settings/Search/Skills 可见反馈、New chat draft remap、自动化测试和 CDP 真实页面验证。
- 本计划不包含旧 nanobot 协议兼容目标。
- 本计划不实现非目标功能：完整 settings 编辑、完整搜索、完整 skills catalog、workspace 切换、file preview、权限确认 UI、完整取消运行、旧历史迁移。
