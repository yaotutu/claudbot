# Run Activity Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `session_init`、思考状态和工具调用成为每轮 assistant 回复的持久化过程记录，实时可见、完成后保留、刷新/切换会话后仍可见，并且不在对话尾部跨轮叠加。

**Architecture:** 后端 `runUserTurn` 是真实数据边界，必须在运行过程中收集 activity，并在最终 `message.appended.message.metadata.activities` 中发给前端。前端只负责把实时 activity 显示在当前 run 位置，并在收到最终消息后渲染 message metadata；不能只在 React state 中伪造不可持久化的历史。

**Tech Stack:** Bun、TypeScript、React、Vitest、Testing Library、真实 Chromium CDP。

---

## 文件边界

- Modify: `src/shared/webui-protocol.ts`
  - 定义可持久化的 `ThreadActivity` / `ThreadActivityStatus` 类型，作为前后端共享契约。
- Modify: `src/conversation/run-user-turn.ts`
  - 在后端运行过程中收集 `run.status`、`run.thinking`、`run.tool`。
  - 最终 `message.appended` 携带 `metadata.runId` 和 `metadata.activities`。
- Modify: `tests/conversation-run-user-turn.test.ts`
  - 新增后端边界测试，证明最终 message metadata 包含 activity。
- Modify: `webui/src/hooks/useClaudebotThread.ts`
  - 删除只靠前端伪造历史的逻辑。
  - 当前 run 仍实时显示 transient activity。
  - 最终 message 直接使用后端 metadata；只允许在后端 metadata 缺失时，用当前内存快照做本轮兜底显示，但测试不能依赖这个兜底。
- Modify: `webui/src/claudebot-ui/adapter.ts`
  - 从 `message.metadata.activities` 读取共享 `ThreadActivity`。
  - 兼容已有 JSONL metadata 的 `thinking` / `toolCalls`。
- Modify: `webui/src/claudebot-ui/ClaudebotThread.tsx`
  - 每条 assistant/system 消息下面渲染自己的 activity。
  - 当前 run 的 transient activity 只显示在尾部，收到最终 message 后尾部 transient 消失。
- Modify: `webui/src/tests/useClaudebotThread.test.tsx`
  - 测试“后端 final message metadata 驱动历史 activity”。
  - 测试“刷新式 fetch 后仍能渲染 activity”。
- Modify: `webui/src/tests/app-native-layout.test.tsx`
  - 页面层测试多轮 activity 分别挂在各自消息下面。

---

### Task 1: 共享协议类型

**Files:**
- Modify: `src/shared/webui-protocol.ts`
- Test: `webui/src/tests/shared-protocol.test.ts`

- [ ] **Step 1: 写失败测试**

在 `webui/src/tests/shared-protocol.test.ts` 增加导入断言，确保 WebUI 能从共享协议导入 activity 类型：

```ts
import type { ThreadActivity } from "@/lib/claudebot-types";

it("exports run activity metadata shape", () => {
  const activity: ThreadActivity = {
    id: "status-r1",
    kind: "status",
    runId: "r1",
    text: "session_init",
    status: "complete",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    mcpServers: [{ name: "claudebot", status: "connected" }],
  };
  expect(activity.kind).toBe("status");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd webui && bun run test -- src/tests/shared-protocol.test.ts
```

Expected: FAIL，原因是 `ThreadActivity` 没有从共享协议导出。

- [ ] **Step 3: 实现共享类型**

在 `src/shared/webui-protocol.ts` 增加：

```ts
export type ThreadActivityStatus = "running" | "complete" | "error";

export type ThreadActivity =
  | {
      id: string;
      kind: "thinking";
      runId: string;
      text: string;
      status: ThreadActivityStatus;
      createdAt: string;
      updatedAt: string;
    }
  | {
      id: string;
      kind: "tool";
      runId: string;
      toolId: string;
      name: string;
      phase: ToolFrame["phase"];
      input?: unknown;
      output?: unknown;
      isError?: boolean;
      status: ThreadActivityStatus;
      createdAt: string;
      updatedAt: string;
    }
  | {
      id: string;
      kind: "status";
      runId: string;
      text: string;
      status: ThreadActivityStatus;
      mcpServers?: RuntimeMcpServerStatus[];
      createdAt: string;
      updatedAt: string;
    };
```

在 `webui/src/lib/claudebot-types.ts` 导出 `ThreadActivity` 和 `ThreadActivityStatus`。

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd webui && bun run test -- src/tests/shared-protocol.test.ts
```

Expected: PASS。

---

### Task 2: 后端持久化 activity 到最终消息

**Files:**
- Modify: `src/conversation/run-user-turn.ts`
- Test: `tests/conversation-run-user-turn.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/conversation-run-user-turn.test.ts` 增加测试。测试必须通过真实 `runUserTurn` sink 收集 frames，断言最终 `message.appended` 的 metadata 持有 activity：

```ts
test("runUserTurn persists run activity on the final assistant message metadata", async () => {
  const frames: ConversationEvent[] = [];
  const services = makeConversationServices({
    events: [
      { type: "status", status: "session_init", mcpServers: [{ name: "claudebot", status: "connected" }] },
      { type: "thinking_delta", thinking: "Need to search memory." },
      { type: "tool_start", id: "tool-1", name: "mcp__claudebot__memory_search", input: { query: "activity" } },
      { type: "tool_result", id: "tool-1", output: "[]", isError: false },
      { type: "text_delta", text: "done" },
      { type: "turn_done", result: "done", sessionId: "sdk-1" },
    ],
  });

  await runUserTurn(services, { source: "webui", draftId: "draft-1", content: "test" }, {
    send: async (frame) => { frames.push(frame); },
  });

  const finalMessage = frames.find((frame) => frame.type === "message.appended");
  expect(finalMessage).toMatchObject({
    type: "message.appended",
    message: {
      role: "assistant",
      content: "done",
      metadata: {
        runId: expect.any(String),
        activities: [
          expect.objectContaining({ kind: "status", text: "session_init", status: "complete" }),
          expect.objectContaining({ kind: "thinking", text: "Need to search memory.", status: "complete" }),
          expect.objectContaining({ kind: "tool", name: "mcp__claudebot__memory_search", status: "complete" }),
        ],
      },
    },
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
bun test tests/conversation-run-user-turn.test.ts
```

Expected: FAIL，`metadata.activities` 不存在。

- [ ] **Step 3: 实现 activity collector**

在 `src/conversation/run-user-turn.ts` 增加本地函数式 collector：

```ts
function appendThinkingActivity(activities: ThreadActivity[], runId: string, text: string, timestamp: string): ThreadActivity[] {
  const id = `thinking-${runId}`;
  const index = activities.findIndex((activity) => activity.id === id);
  if (index === -1) {
    return [...activities, { id, kind: "thinking", runId, text, status: "running", createdAt: timestamp, updatedAt: timestamp }];
  }
  return activities.map((activity) => activity.id === id && activity.kind === "thinking"
    ? { ...activity, text: `${activity.text}${text}`, updatedAt: timestamp }
    : activity);
}

function upsertToolActivity(activities: ThreadActivity[], runId: string, tool: ToolFrame, timestamp: string): ThreadActivity[] {
  const id = `tool-${tool.id}`;
  const status = tool.phase === "error" || tool.isError ? "error" : tool.phase === "end" ? "complete" : "running";
  const existing = activities.find((activity) => activity.id === id);
  if (!existing) {
    return [...activities, {
      id,
      kind: "tool",
      runId,
      toolId: tool.id,
      name: tool.name?.trim() || "Tool",
      phase: tool.phase,
      input: tool.input,
      output: tool.output,
      isError: tool.isError,
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  }
  return activities.map((activity) => activity.id === id && activity.kind === "tool"
    ? {
        ...activity,
        name: tool.name?.trim() || activity.name,
        phase: tool.phase,
        input: tool.input ?? activity.input,
        output: tool.output ?? activity.output,
        isError: tool.isError ?? activity.isError,
        status,
        updatedAt: timestamp,
      }
    : activity);
}

function upsertStatusActivity(activities: ThreadActivity[], runId: string, statusText: string, mcpServers: RuntimeMcpServerStatus[] | undefined, timestamp: string): ThreadActivity[] {
  const id = `status-${runId}-${statusText}`;
  const existing = activities.find((activity) => activity.id === id);
  if (!existing) {
    return [...activities, { id, kind: "status", runId, text: statusText, status: "running", mcpServers, createdAt: timestamp, updatedAt: timestamp }];
  }
  return activities.map((activity) => activity.id === id && activity.kind === "status"
    ? { ...activity, mcpServers, updatedAt: timestamp }
    : activity);
}

function finalizeActivities(activities: ThreadActivity[], isError: boolean): ThreadActivity[] {
  const timestamp = new Date().toISOString();
  return activities.map((activity) => activity.status === "running"
    ? { ...activity, status: isError ? "error" : "complete", updatedAt: timestamp }
    : activity);
}
```

在 `handleEvent` 中更新 `activities`：

```ts
let activities: ThreadActivity[] = [];

if (ev.type === "status") {
  activities = upsertStatusActivity(activities, runId, ev.status, ev.mcpServers, new Date().toISOString());
}
if (ev.type === "thinking_delta") {
  activities = appendThinkingActivity(activities, runId, ev.thinking, new Date().toISOString());
}
if (ev.type === "tool_start") {
  activities = upsertToolActivity(activities, runId, { phase: "start", id: ev.id, name: ev.name, input: ev.input }, new Date().toISOString());
}
if (ev.type === "tool_result") {
  activities = upsertToolActivity(activities, runId, { phase: ev.isError ? "error" : "end", id: ev.id, output: ev.output, isError: ev.isError }, new Date().toISOString());
}
```

最终 `message.appended` 改为：

```ts
const finalActivities = finalizeActivities(activities, turnErrored);
metadata: turnErrored
  ? { error: true, runId, activities: finalActivities }
  : { runId, activities: finalActivities },
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
bun test tests/conversation-run-user-turn.test.ts
```

Expected: PASS。

---

### Task 3: 前端只渲染后端 metadata，补齐刷新边界

**Files:**
- Modify: `webui/src/hooks/useClaudebotThread.ts`
- Modify: `webui/src/claudebot-ui/adapter.ts`
- Modify: `webui/src/claudebot-ui/ClaudebotThread.tsx`
- Test: `webui/src/tests/useClaudebotThread.test.tsx`
- Test: `webui/src/tests/app-native-layout.test.tsx`

- [ ] **Step 1: 写失败测试：刷新式 fetch 后仍显示 activity**

在 `webui/src/tests/app-native-layout.test.tsx` 增加 persisted thread fixture，`fetchThreadMessages` 返回：

```ts
[
  { id: "u1", role: "user", content: "test", createdAt: "2026-06-17T00:00:00.000Z", metadata: {} },
  {
    id: "a1",
    role: "assistant",
    content: "done",
    createdAt: "2026-06-17T00:00:01.000Z",
    metadata: {
      runId: "r1",
      activities: [
        { id: "status-r1-session_init", kind: "status", runId: "r1", text: "session_init", status: "complete", createdAt: "2026-06-17T00:00:00.000Z", updatedAt: "2026-06-17T00:00:01.000Z", mcpServers: [{ name: "claudebot", status: "connected" }] },
        { id: "thinking-r1", kind: "thinking", runId: "r1", text: "Need to search memory.", status: "complete", createdAt: "2026-06-17T00:00:00.000Z", updatedAt: "2026-06-17T00:00:01.000Z" },
        { id: "tool-tool-1", kind: "tool", runId: "r1", toolId: "tool-1", name: "mcp__claudebot__memory_search", phase: "end", status: "complete", createdAt: "2026-06-17T00:00:00.000Z", updatedAt: "2026-06-17T00:00:01.000Z" },
      ],
    },
  },
]
```

断言：

```ts
expect(await screen.findByText("done")).toBeInTheDocument();
expect(screen.getByText("session_init")).toBeInTheDocument();
expect(screen.getByText("Thinking")).toBeInTheDocument();
expect(screen.getByText("Need to search memory.")).toBeInTheDocument();
expect(screen.getByText("mcp__claudebot__memory_search")).toBeInTheDocument();
expect(screen.getAllByLabelText("Run activity")).toHaveLength(1);
```

- [ ] **Step 2: 写失败测试：多轮不尾部叠加**

在页面测试中模拟两轮 WebSocket：

```ts
handler({ type: "run.started", sessionId: "s1", runId: "r1" });
handler({ type: "run.status", sessionId: "s1", runId: "r1", status: "session_init", mcpServers: [{ name: "claudebot", status: "connected" }] });
handler({ type: "run.thinking", sessionId: "s1", runId: "r1", text: "first thinking" });
handler({ type: "run.completed", sessionId: "s1", runId: "r1", isError: false });
handler({ type: "message.appended", sessionId: "s1", message: { id: "a1", role: "assistant", content: "first", createdAt: "2026-06-17T00:00:01.000Z", metadata: { runId: "r1", activities: [...] } } });

handler({ type: "run.started", sessionId: "s1", runId: "r2" });
handler({ type: "run.status", sessionId: "s1", runId: "r2", status: "session_init", mcpServers: [{ name: "claudebot", status: "connected" }] });
handler({ type: "run.thinking", sessionId: "s1", runId: "r2", text: "second thinking" });
handler({ type: "run.completed", sessionId: "s1", runId: "r2", isError: false });
handler({ type: "message.appended", sessionId: "s1", message: { id: "a2", role: "assistant", content: "second", createdAt: "2026-06-17T00:00:02.000Z", metadata: { runId: "r2", activities: [...] } } });
```

断言：

```ts
expect(screen.getByText("first thinking")).toBeInTheDocument();
expect(screen.getByText("second thinking")).toBeInTheDocument();
expect(screen.getAllByLabelText("Run activity")).toHaveLength(2);
expect(screen.queryByText("Claudebot is working")).not.toBeInTheDocument();
```

- [ ] **Step 3: 实现前端边界**

`useClaudebotThread.ts`：
- 保留 `activities` 只作为当前 run transient。
- `message.appended` 使用后端传来的 `message.metadata.activities`。
- 如果后端 metadata 缺失，只能用内存 snapshot 临时补当前显示；补丁必须注释为兼容兜底，不能作为测试主路径。

`adapter.ts`：
- `activitiesFromMetadata` 优先读取 `message.metadata.activities`。
- 保留 `thinking` / `toolCalls` 兼容转换。

`ClaudebotThread.tsx`：
- `MessageRow` 内渲染 `message.activities`。
- 尾部只渲染当前 run 的 `activities`，最终 message 到达后尾部清空。

- [ ] **Step 4: 运行 WebUI 测试**

Run:

```bash
cd webui && bun run test -- src/tests/useClaudebotThread.test.tsx src/tests/app-native-layout.test.tsx
cd webui && bun run test
```

Expected: PASS。

---

### Task 4: 真实浏览器 CDP 验证

**Files:**
- No source edits.

- [ ] **Step 1: 启动当前 WebUI**

Run:

```bash
cd webui
CLAUDEBOT_API_URL=http://127.0.0.1:18790 bun run dev -- --host 127.0.0.1 --port 5174 --strictPort false
```

Expected: Vite serves `http://127.0.0.1:5174/`。

- [ ] **Step 2: 用 CDP 点击第一轮**

真实浏览器步骤：
1. 打开 `http://127.0.0.1:5174/`。
2. 点击 `New chat`。
3. 在 composer 输入：

```text
为了测试页面过程记录，请调用 memory_search 搜索 activity-persist-one，然后只回复：activity-persist-one-ok
```

4. 点击 Send。
5. 运行中必须看到至少一个 `Run activity`，包含 `session_init` 或 `Thinking`。
6. 等 `Send message` 恢复。
7. 完成后必须仍能看到第一轮消息下面的 `Run activity`。

- [ ] **Step 3: 用 CDP 点击第二轮**

在同一会话继续输入：

```text
请再次调用 memory_search 搜索 activity-persist-two，然后只回复：activity-persist-two-ok
```

验证：
- 第二轮运行中，页面最多显示“第一轮已归档 activity + 当前轮 transient activity”。
- 第二轮完成后，页面显示两组 `Run activity`，分别在两条 assistant 回复下面。
- 页面底部没有第三组孤立 `Run activity`。
- `Stop generating` 消失。
- `mcp__claudebot__memory_search` 仍可见。

用 CDP DOM 断言：

```js
() => ({
  runActivityCount: document.querySelectorAll('[aria-label="Run activity"]').length,
  hasStopGenerating: document.body.innerText.includes('Stop generating'),
  hasMemorySearchTool: document.body.innerText.includes('mcp__claudebot__memory_search'),
})
```

Expected after second run:

```json
{
  "runActivityCount": 2,
  "hasStopGenerating": false,
  "hasMemorySearchTool": true
}
```

- [ ] **Step 4: CDP 刷新验证持久化**

1. 在同一会话页面执行浏览器 reload。
2. 等会话重新加载。
3. 再次执行 DOM 断言。

Expected:

```json
{
  "runActivityCount": 2,
  "hasStopGenerating": false,
  "hasMemorySearchTool": true
}
```

如果刷新后 `runActivityCount` 变成 0，说明后端没有持久化或 session read model 没读出来，不能验收。

- [ ] **Step 5: CDP 切换会话验证**

1. 点击侧边栏其他会话。
2. 再点击刚才测试会话。
3. 再次执行 DOM 断言。

Expected: 与刷新验证一致。

- [ ] **Step 6: 清理测试会话**

Run:

```bash
curl -sS http://127.0.0.1:18790/api/sessions | jq -r '.[] | select((.preview // "") | test("activity-persist-one|activity-persist-two")) | .id'
curl -sS -X DELETE http://127.0.0.1:18790/api/sessions/<id>
```

Expected: HTTP 200，最近会话列表不再包含测试会话。

---

### Task 5: 最终验证边界

- [ ] **Step 1: 后端验证**

Run:

```bash
bun run typecheck
bun run test
```

Expected: PASS。

- [ ] **Step 2: WebUI 验证**

Run:

```bash
cd webui && bun run test
cd webui && bun run lint
cd webui && bun run build
```

Expected: PASS。

- [ ] **Step 3: diff 校验**

Run:

```bash
git diff --check
git status --short
```

Expected:
- `git diff --check` 无输出。
- `git status --short` 只包含本功能相关文件和已有未提交文件。

---

## 验收标准

必须同时满足：

1. 运行中实时显示 `session_init`、`Thinking`、工具调用。
2. 完成后这些信息不消失。
3. 每轮 activity 挂在对应 assistant/system 消息下面。
4. 多轮对话不会在页面尾部叠加旧 activity。
5. 刷新页面后 activity 仍存在。
6. 切换会话回来后 activity 仍存在。
7. 后端 `message.appended.message.metadata.activities` 有真实数据。
8. 真实浏览器 CDP 验证通过。

## 当前错误实现需要废弃的点

- 不能只在 `useClaudebotThread` 内存里把 activity 塞进 message metadata。
- 不能把 `run.completed` 当成“清空所有历史 activity”。
- 不能只用页面当前生命周期作为通过标准。
- 不能只用 Testing Library 模拟代替真实浏览器验证。
