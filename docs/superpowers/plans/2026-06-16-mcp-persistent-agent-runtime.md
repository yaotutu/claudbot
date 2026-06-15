# MCP Persistent Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入外部 MCP 配置，并把用户聊天运行时改成 per-session long-lived Claude Agent SDK `Query`，让同一 session 内 MCP 初始化可复用，同时支持多个 session 并行运行。

**Architecture:** 内置工具仍通过 `ToolRegistry -> claudebot SDK MCP server` 暴露；外部 MCP 只作为 `config.mcp.servers` 传给 Claude Agent SDK，不实现 MCP client。新增 `AgentRuntimeManager`，按 `sessionId` 维护长期 `Query`、input queue、output pump、run lifecycle 和 cancel；scheduler 继续 one-off query，但复用同一套 SDK options/MCP 组装函数。

**Tech Stack:** Bun, TypeScript ESM, `@anthropic-ai/claude-agent-sdk@0.3.169`, `zod/v4`, `bun:test`。

---

## File Structure

- Modify: `src/config/schema.ts`
  - 增加 `mcp.strict` 和 `mcp.servers` schema。
  - 支持外部 `stdio`、`sse`、`http` MCP server config。
  - 拒绝 `claudebot` server 名。

- Create: `src/agent/sdk-options.ts`
  - 统一构建 Claude SDK env、MCP servers 和 options。
  - 暴露 `buildSdkEnv()`、`buildSdkMcpServers()`、`buildBaseSdkOptions()`。
  - `makeRealQueryFactory()` 和 long-lived runtime 都复用这里。

- Modify: `src/tools/types.ts`
  - 增加 `ToolContextRef` 类型。

- Modify: `src/tools/sdk-mcp-server.ts`
  - 支持固定 `ToolContext` 和动态 `ToolContextRef`。
  - tool handler 执行时读取最新 context。

- Modify: `src/agent/events.ts`
  - 给 `status` event 增加可选 `mcpServers` 字段。
  - 给 `SdkMessage` 增加 `mcp_servers` 字段类型。

- Modify: `src/agent/runner.ts`
  - 保留 `ClaudeRunner` 作为 scheduler/one-off runner。
  - 抽出并导出 `normalizeSdkMessage()`，供 runtime manager output pump 复用。
  - `makeRealQueryFactory()` 改用 `sdk-options.ts`。

- Create: `src/agent/input-queue.ts`
  - 实现一个 typed async queue，用于 feeding `AsyncIterable<SDKUserMessage>`。
  - 支持 `push()`、`close()`、`fail()`。

- Create: `src/agent/runtime-manager.ts`
  - 实现 `AgentRuntimeManager`。
  - 按 `Map<sessionId, AgentRuntime>` 管理 long-lived SDK Query。
  - 支持 run turn、cancel、close session、idle cleanup、close all。

- Modify: `src/runtime/services.ts`
  - 创建并暴露 `agentRuntimeManager`。
  - 继续暴露 `makeRunner()` 给 scheduler。
  - scheduler one-off runner 复用 MCP options。

- Modify: `src/gateway/websocket.ts`
  - `chat.send` 改为调用 `agentRuntimeManager.runTurn()`。
  - `chat.cancel` 调用 `agentRuntimeManager.cancel(sessionId)`。
  - 保留 `session.created` draft remap、rename、last active session、`message.appended` 语义。

- Modify: `src/shared/webui-protocol.ts` and `src/gateway/protocol.ts`
  - 增加 `run.status` 或扩展现有 run frame 以承载 MCP init/status。
  - 第一版可只让后端 forward，不强制 WebUI 展示。

- Test: `tests/config.test.ts`
  - MCP config schema。

- Test: `tests/tools.test.ts`
  - dynamic `ToolContextRef`。

- Test: `tests/agent-runner.test.ts`
  - SDK options/MCP 组装和 `system/init.mcp_servers` 归一化。

- Test: `tests/agent-runtime-manager.test.ts`
  - long-lived runtime、per-session 并行、cancel、idle close。

- Test: `tests/gateway.test.ts`
  - WebSocket run frames、draft remap、cancel 接入 manager。

---

### Task 1: Update Spec Scheduler Boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-06-15-mcp-persistent-agent-runtime-design.md`

- [ ] **Step 1: Verify scheduler text says MCP is not special**

Run:

```bash
rg -n "Scheduler 边界|scheduler 不复用|MCP 对 scheduler" docs/superpowers/specs/2026-06-15-mcp-persistent-agent-runtime-design.md
```

Expected: output includes text explaining scheduler reuses SDK options/MCP composition and only differs by lifecycle.

- [ ] **Step 2: Check formatting**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 3: Commit spec update**

Run:

```bash
git add docs/superpowers/specs/2026-06-15-mcp-persistent-agent-runtime-design.md
git commit -m "docs(agent): clarify scheduler mcp lifecycle"
```

Expected: commit succeeds.

---

### Task 2: Add MCP Config Schema

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Append these tests to `tests/config.test.ts` under `describe("runtime config", ...)`:

```ts
  test("accepts stdio, sse, and http MCP server config", () => {
    const config = resolveRuntimeConfig(
      {
        home: "/tmp/bot",
        mcp: {
          strict: true,
          servers: {
            filesystem: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
              env: { NODE_ENV: "test" },
              timeout: 30000,
              alwaysLoad: false,
            },
            search: {
              type: "sse",
              url: "http://127.0.0.1:3001/sse",
              headers: { Authorization: "Bearer token" },
              timeout: 10000,
              alwaysLoad: true,
            },
            docs: {
              type: "http",
              url: "http://127.0.0.1:3002/mcp",
              headers: {},
              timeout: 10000,
              alwaysLoad: false,
            },
          },
        },
      },
      {},
    );

    expect(config.mcp.strict).toBe(true);
    expect(config.mcp.servers.filesystem.type).toBe("stdio");
    expect(config.mcp.servers.search.type).toBe("sse");
    expect(config.mcp.servers.docs.type).toBe("http");
  });

  test("defaults MCP config to strict with no external servers", () => {
    const config = resolveRuntimeConfig({ home: "/tmp/bot" }, {});
    expect(config.mcp).toEqual({ strict: true, servers: {} });
  });

  test("rejects external MCP server named claudebot", () => {
    expect(() => resolveRuntimeConfig(
      {
        home: "/tmp/bot",
        mcp: {
          servers: {
            claudebot: { type: "stdio", command: "node", args: ["server.js"] },
          },
        },
      },
      {},
    )).toThrow(/claudebot/i);
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test tests/config.test.ts --timeout 30000
```

Expected: FAIL because `config.mcp` does not exist.

- [ ] **Step 3: Implement schema**

In `src/config/schema.ts`, add schemas before `RuntimeConfigSchema`:

```ts
const McpServerNameSchema = z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/).refine((name) => name !== "claudebot", {
  message: "external MCP server name 'claudebot' is reserved for native tools",
});

const McpBaseSchema = z.object({
  timeout: z.number().int().min(1000).optional(),
  alwaysLoad: z.boolean().optional(),
});

const McpStdioServerSchema = McpBaseSchema.extend({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const McpRemoteServerSchema = McpBaseSchema.extend({
  type: z.enum(["sse", "http"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpServerSchema = z.discriminatedUnion("type", [
  McpStdioServerSchema,
  McpRemoteServerSchema,
]);

const McpServersSchema = z.record(McpServerNameSchema, McpServerSchema).default({});

const McpSchema = z.object({
  strict: z.boolean().default(true),
  servers: McpServersSchema,
}).default({ strict: true, servers: {} });
```

Then add this field to `RuntimeConfigSchema`:

```ts
  mcp: McpSchema,
```

- [ ] **Step 4: Run config tests**

Run:

```bash
bun test tests/config.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/config/schema.ts tests/config.test.ts
git commit -m "feat(config): add external mcp config"
```

Expected: commit succeeds.

---

### Task 3: Extract SDK Options And MCP Composition

**Files:**
- Create: `src/agent/sdk-options.ts`
- Modify: `src/agent/runner.ts`
- Modify: `tests/agent-runner.test.ts`

- [ ] **Step 1: Write failing SDK options tests**

In `tests/agent-runner.test.ts`, add a test to `describe("makeRealQueryFactory", ...)`:

```ts
  test("passes native and external MCP servers with strictMcpConfig", async () => {
    const config = resolveRuntimeConfig(
      {
        home: "/tmp/x",
        mcp: {
          strict: true,
          servers: {
            filesystem: { type: "stdio", command: "node", args: ["fs-server.js"] },
          },
        },
      },
      {},
    );
    const opts = await invokeFactoryAndCapture(config);
    const servers = opts.mcpServers as Record<string, unknown>;
    expect(servers.claudebot).toBeDefined();
    expect(servers.filesystem).toEqual({ type: "stdio", command: "node", args: ["fs-server.js"] });
    expect(opts.strictMcpConfig).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
bun test tests/agent-runner.test.ts --timeout 30000
```

Expected: FAIL because external MCP and `strictMcpConfig` are not passed.

- [ ] **Step 3: Create SDK options helpers**

Create `src/agent/sdk-options.ts`:

```ts
import type { RuntimeConfig } from "../config/schema.ts";

export type SdkMcpServerMap = Record<string, unknown>;

export function buildSdkEnv(config: RuntimeConfig, sdkConfigDir: string): Record<string, string | undefined> {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: sdkConfigDir,
    ...(config.claudeCode.baseUrl ? { ANTHROPIC_BASE_URL: config.claudeCode.baseUrl } : {}),
    ...(config.claudeCode.apiKey
      ? {
          ANTHROPIC_API_KEY: config.claudeCode.apiKey,
          ANTHROPIC_AUTH_TOKEN: config.claudeCode.apiKey,
        }
      : {}),
  };
}

export function buildSdkMcpServers(config: RuntimeConfig, nativeServer: unknown): SdkMcpServerMap {
  return {
    claudebot: nativeServer,
    ...config.mcp.servers,
  };
}

export function buildBaseSdkOptions(config: RuntimeConfig, sdkConfigDir: string, nativeServer: unknown) {
  return {
    model: config.claudeCode.model,
    permissionMode: config.claudeCode.permissionMode,
    maxTurns: config.claudeCode.maxTurns,
    env: buildSdkEnv(config, sdkConfigDir),
    mcpServers: buildSdkMcpServers(config, nativeServer),
    strictMcpConfig: config.mcp.strict,
  };
}
```

- [ ] **Step 4: Update `makeRealQueryFactory()`**

In `src/agent/runner.ts`, import:

```ts
import { buildBaseSdkOptions } from "./sdk-options.ts";
```

Replace inline env/options construction in `makeRealQueryFactory()` with:

```ts
    const baseOptions = buildBaseSdkOptions(config, sdkConfigDir, mcpServer);
    const stream = query({
      prompt,
      options: {
        ...baseOptions,
        systemPrompt,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        sessionStore,
      },
    });
```

- [ ] **Step 5: Run tests**

Run:

```bash
bun test tests/agent-runner.test.ts tests/config.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/agent/sdk-options.ts src/agent/runner.ts tests/agent-runner.test.ts
git commit -m "refactor(agent): share sdk mcp options"
```

Expected: commit succeeds.

---

### Task 4: Add Dynamic Tool Context Ref

**Files:**
- Modify: `src/tools/types.ts`
- Modify: `src/tools/sdk-mcp-server.ts`
- Modify: `tests/tools.test.ts`

- [ ] **Step 1: Write failing dynamic context test**

Append to `tests/tools.test.ts`:

```ts
  test("SDK MCP server reads the latest ToolContextRef for each call", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    const seen: string[] = [];
    registry.register({
      name: "ctx_echo",
      description: "echo context",
      inputSchema: z.object({}),
      execute: async (_input, context) => {
        seen.push(context.sessionId || "");
        return { sessionId: context.sessionId };
      },
    });
    const contextRef = { current: makeCtx({ sessionId: "s1" }) };
    const server = createClaudebotSdkMcpServer(registry, contextRef) as { config?: { tools?: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> } };
    const tool = server.config?.tools?.find((item) => item.name === "ctx_echo");
    if (!tool) throw new Error("ctx_echo tool not found");

    await tool.handler({});
    contextRef.current = makeCtx({ sessionId: "s2" });
    await tool.handler({});

    expect(seen).toEqual(["s1", "s2"]);
  });
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
bun test tests/tools.test.ts --timeout 30000
```

Expected: FAIL because `createClaudebotSdkMcpServer` accepts only fixed context.

- [ ] **Step 3: Add type and implementation**

In `src/tools/types.ts`, add:

```ts
export type ToolContextRef = {
  current: ToolContext;
};
```

In `src/tools/sdk-mcp-server.ts`, change signature and resolve helper:

```ts
import type { ToolContext, ToolContextRef } from "./types.ts";

type ToolContextSource = ToolContext | ToolContextRef;

function resolveContext(source: ToolContextSource): ToolContext {
  return "current" in source ? source.current : source;
}

export function createClaudebotSdkMcpServer(registry: ToolRegistry, contextSource: ToolContextSource) {
  return createSdkMcpServer({
    name: "claudebot",
    version: "0.1.0",
    alwaysLoad: true,
    instructions: "Claudebot native tools. Follow the system prompt tool instructions and each tool schema.",
    tools: registry.list().map((nativeTool) =>
      sdkTool(nativeTool.name, nativeTool.description, nativeTool.inputSchema as any, async (args: any) => {
        try {
          const result = await registry.execute(nativeTool.name, args, resolveContext(contextSource));
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `error: ${msg}` }], isError: true };
        }
      }),
    ),
  });
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
bun test tests/tools.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/tools/types.ts src/tools/sdk-mcp-server.ts tests/tools.test.ts
git commit -m "refactor(tools): support dynamic tool context"
```

Expected: commit succeeds.

---

### Task 5: Normalize MCP Status From SDK Init

**Files:**
- Modify: `src/agent/events.ts`
- Modify: `src/agent/runner.ts`
- Modify: `tests/agent-runner.test.ts`

- [ ] **Step 1: Write failing normalization test**

Add to `describe("claude runner normalization", ...)`:

```ts
  test("system init forwards MCP server status", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    const runner = new ClaudeRunner(baseDeps(registry), makeQueryFactory([
      {
        type: "system",
        subtype: "init",
        session_id: "sess_init",
        mcp_servers: [{ name: "filesystem", status: "connected" }],
      },
    ]));
    const events = await collectEvents(runner.run({ prompt: "hi" }));
    expect(events).toContainEqual({
      type: "status",
      status: "session_init",
      sessionId: "sess_init",
      mcpServers: [{ name: "filesystem", status: "connected" }],
    });
  });
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
bun test tests/agent-runner.test.ts --timeout 30000
```

Expected: FAIL because `mcpServers` is not forwarded.

- [ ] **Step 3: Update event types and normalization**

In `src/agent/events.ts`, add:

```ts
export type McpServerStatus = { name: string; status: string; [key: string]: unknown };
```

Change status event to:

```ts
  | { type: "status"; status: string; sessionId?: string; mcpServers?: McpServerStatus[] }
```

Add to `SdkMessage`:

```ts
  mcp_servers?: McpServerStatus[];
```

In `src/agent/runner.ts`, export normalizer:

```ts
export function normalizeSdkMessage(msg: SdkMessage, fallbackSessionId?: string): NormalizedEvent[] {
```

Replace calls to `normalize(...)` with `normalizeSdkMessage(...)`. In `system/init`, return:

```ts
      if (msg.subtype === "init") {
        return [{ type: "status", status: "session_init", sessionId: sid, mcpServers: msg.mcp_servers }];
      }
```

- [ ] **Step 4: Run tests**

Run:

```bash
bun test tests/agent-runner.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/agent/events.ts src/agent/runner.ts tests/agent-runner.test.ts
git commit -m "feat(agent): forward mcp init status"
```

Expected: commit succeeds.

---

### Task 6: Implement Async Input Queue

**Files:**
- Create: `src/agent/input-queue.ts`
- Create: `src/agent/input-queue.test.ts`

- [ ] **Step 1: Write queue tests**

Create `src/agent/input-queue.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createAsyncInputQueue } from "./input-queue.ts";

describe("createAsyncInputQueue", () => {
  test("yields pushed values in order", async () => {
    const queue = createAsyncInputQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();

    const values: number[] = [];
    for await (const value of queue.iterable) values.push(value);

    expect(values).toEqual([1, 2]);
  });

  test("throws queued failure to consumer", async () => {
    const queue = createAsyncInputQueue<number>();
    queue.fail(new Error("boom"));

    await expect(async () => {
      for await (const _value of queue.iterable) {
        // no-op
      }
    }).toThrow("boom");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
bun test src/agent/input-queue.test.ts --timeout 30000
```

Expected: FAIL because file does not exist.

- [ ] **Step 3: Implement queue**

Create `src/agent/input-queue.ts`:

```ts
export type AsyncInputQueue<T> = {
  iterable: AsyncIterable<T>;
  push(value: T): void;
  close(): void;
  fail(error: Error): void;
};

export function createAsyncInputQueue<T>(): AsyncInputQueue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  let closed = false;
  let failure: Error | null = null;

  const next = (): Promise<IteratorResult<T>> => {
    if (values.length > 0) return Promise.resolve({ value: values.shift() as T, done: false });
    if (failure) return Promise.reject(failure);
    if (closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };

  const flush = () => {
    while (waiters.length > 0 && values.length > 0) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value: values.shift() as T, done: false });
    }
    if (failure) {
      while (waiters.length > 0) waiters.shift()?.reject(failure);
      return;
    }
    if (closed) {
      while (waiters.length > 0) waiters.shift()?.resolve({ value: undefined, done: true });
    }
  };

  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return { next };
      },
    },
    push(value) {
      if (closed || failure) throw new Error("input queue is closed");
      values.push(value);
      flush();
    },
    close() {
      closed = true;
      flush();
    },
    fail(error) {
      failure = error;
      flush();
    },
  };
}
```

- [ ] **Step 4: Run queue tests**

Run:

```bash
bun test src/agent/input-queue.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/agent/input-queue.ts src/agent/input-queue.test.ts
git commit -m "feat(agent): add streaming input queue"
```

Expected: commit succeeds.

---

### Task 7: Implement AgentRuntimeManager With Mock Query

**Files:**
- Create: `src/agent/runtime-manager.ts`
- Create: `tests/agent-runtime-manager.test.ts`

- [ ] **Step 1: Write runtime manager tests**

Create `tests/agent-runtime-manager.test.ts` with tests for:

```ts
import { describe, expect, test } from "bun:test";
import { createAgentRuntimeManager, type AgentRuntimeQueryFactory } from "../src/agent/runtime-manager.ts";
import type { RuntimeConfig } from "../src/config/schema.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

function config(): RuntimeConfig {
  return resolveRuntimeConfig({ home: "/tmp/bot" }, {});
}

describe("AgentRuntimeManager", () => {
  test("reuses one Query for multiple turns in the same session", async () => {
    let created = 0;
    const queryFactory: AgentRuntimeQueryFactory = async ({ input }) => {
      created += 1;
      return {
        stream: (async function* () {
          let count = 0;
          for await (const _message of input) {
            count += 1;
            yield { type: "system", subtype: "init", session_id: "s1" };
            yield { type: "assistant", message: { content: [{ type: "text", text: count === 1 ? "ok" : "again" }] }, session_id: "s1" };
            yield { type: "result", session_id: "s1", result: count === 1 ? "ok" : "again", is_error: false };
          }
        })(),
        interrupt: async () => undefined,
        close: () => undefined,
      };
    };
    const manager = createAgentRuntimeManager({
      config: config(),
      registry: new ToolRegistry({ defaultPolicy: "allow", overrides: {} }),
      sdkConfigDir: "/tmp/sdk",
      sessionStore: {} as never,
      queryFactory,
      promptInputs: {
        home: "/tmp/bot",
        workspacePath: "/tmp/bot/workspace",
        timezone: "UTC",
        userFile: "/tmp/user.md",
        soulFile: "/tmp/soul.md",
      },
    });

    const first = await manager.runTurn({ sessionId: "s1", content: "one" });
    const second = await manager.runTurn({ sessionId: "s1", content: "two" });

    expect(created).toBe(1);
    expect(first.events.some((event) => event.type === "turn_done")).toBe(true);
    expect(second.events.some((event) => event.type === "turn_done")).toBe(true);
  });

  test("creates separate runtimes for different sessions", async () => {
    let created = 0;
    const queryFactory: AgentRuntimeQueryFactory = async ({ input }) => {
      created += 1;
      const sessionId = `s${created}`;
      return {
        stream: (async function* () {
          for await (const _message of input) {
            yield { type: "result", session_id: sessionId, result: "ok", is_error: false };
          }
        })(),
        interrupt: async () => undefined,
        close: () => undefined,
      };
    };
    const manager = createAgentRuntimeManager({
      config: config(),
      registry: new ToolRegistry({ defaultPolicy: "allow", overrides: {} }),
      sdkConfigDir: "/tmp/sdk",
      sessionStore: {} as never,
      queryFactory,
      promptInputs: {
        home: "/tmp/bot",
        workspacePath: "/tmp/bot/workspace",
        timezone: "UTC",
        userFile: "/tmp/user.md",
        soulFile: "/tmp/soul.md",
      },
    });

    await Promise.all([
      manager.runTurn({ sessionId: "a", content: "one" }),
      manager.runTurn({ sessionId: "b", content: "two" }),
    ]);

    expect(created).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
bun test tests/agent-runtime-manager.test.ts --timeout 30000
```

Expected: FAIL because `runtime-manager.ts` does not exist.

- [ ] **Step 3: Implement minimal manager**

Create `src/agent/runtime-manager.ts` with these exported types and functions:

```ts
import type { SessionStore, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeConfig } from "../config/schema.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContextRef } from "../tools/types.ts";
import { createClaudebotSdkMcpServer } from "../tools/sdk-mcp-server.ts";
import { buildBaseSdkOptions } from "./sdk-options.ts";
import { createAsyncInputQueue, type AsyncInputQueue } from "./input-queue.ts";
import { buildSystemPrompt, type PromptInputs } from "./prompt.ts";
import { normalizeSdkMessage } from "./runner.ts";
import type { NormalizedEvent, SdkMessage } from "./events.ts";

export type RuntimeStatus = "idle" | "running" | "cancelling" | "failed" | "closed";

export type AgentRuntimeQuery = {
  stream: AsyncIterable<unknown>;
  interrupt(): Promise<void>;
  close(): void;
};

export type AgentRuntimeQueryFactory = (args: {
  input: AsyncIterable<SDKUserMessage>;
  options: Record<string, unknown>;
}) => Promise<AgentRuntimeQuery>;

export type AgentRuntimeManagerDeps = {
  config: RuntimeConfig;
  registry: ToolRegistry;
  sdkConfigDir: string;
  sessionStore: SessionStore;
  promptInputs: Omit<PromptInputs, "now" | "source" | "sessionId" | "scheduleRunId">;
  queryFactory?: AgentRuntimeQueryFactory;
};

type AgentRuntime = {
  sessionId: string;
  claudeSessionId?: string;
  inputQueue: AsyncInputQueue<SDKUserMessage>;
  query: AgentRuntimeQuery;
  contextRef: ToolContextRef;
  status: RuntimeStatus;
  activeRunId?: string;
  events: NormalizedEvent[];
  waiters: Array<(event: NormalizedEvent) => void>;
  lastUsedAt: number;
};

export function createAgentRuntimeManager(deps: AgentRuntimeManagerDeps) {
  const runtimes = new Map<string, AgentRuntime>();
  const queryFactory = deps.queryFactory ?? createRealRuntimeQueryFactory();

  async function getOrCreate(sessionId: string, resumeSessionId?: string): Promise<AgentRuntime> {
    const existing = runtimes.get(sessionId);
    if (existing && existing.status !== "closed") return existing;
    const inputQueue = createAsyncInputQueue<SDKUserMessage>();
    const contextRef: ToolContextRef = { current: makeContext(sessionId) };
    const nativeServer = createClaudebotSdkMcpServer(deps.registry, contextRef);
    const systemPrompt = await buildSystemPrompt({
      ...deps.promptInputs,
      source: "user_turn",
      sessionId,
      toolPrompts: deps.registry.getPromptSections(),
    });
    const options = {
      ...buildBaseSdkOptions(deps.config, deps.sdkConfigDir, nativeServer),
      systemPrompt,
      sessionStore: deps.sessionStore,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    };
    const query = await queryFactory({ input: inputQueue.iterable, options });
    const runtime: AgentRuntime = {
      sessionId,
      inputQueue,
      query,
      contextRef,
      status: "idle",
      events: [],
      waiters: [],
      lastUsedAt: Date.now(),
    };
    runtimes.set(sessionId, runtime);
    void pump(runtime);
    return runtime;
  }

  function makeContext(sessionId: string) {
    return {
      source: "user_turn" as const,
      home: deps.promptInputs.home,
      workspacePath: deps.promptInputs.workspacePath,
      timezone: deps.promptInputs.timezone,
      sessionId,
      services: null,
    };
  }

  async function pump(runtime: AgentRuntime): Promise<void> {
    try {
      let lastSessionId: string | undefined = runtime.sessionId;
      for await (const raw of runtime.query.stream) {
        const msg = raw as SdkMessage;
        if (msg.session_id) lastSessionId = msg.session_id;
        for (const event of normalizeSdkMessage(msg, lastSessionId)) {
          runtime.events.push(event);
          const waiters = runtime.waiters.splice(0);
          for (const waiter of waiters) waiter(event);
        }
      }
      runtime.status = "closed";
    } catch {
      runtime.status = "failed";
    }
  }

  async function runTurn(args: { sessionId: string; content: string; runId?: string; resumeSessionId?: string }): Promise<{ runId: string; events: NormalizedEvent[] }> {
    const runtime = await getOrCreate(args.sessionId, args.resumeSessionId);
    if (runtime.status === "running") throw new Error(`session already running: ${args.sessionId}`);
    const runId = args.runId ?? crypto.randomUUID();
    runtime.status = "running";
    runtime.activeRunId = runId;
    runtime.contextRef.current = makeContext(args.sessionId);
    const startIndex = runtime.events.length;
    runtime.inputQueue.push({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: args.content },
    });
    while (true) {
      const existing = runtime.events.slice(startIndex).find((event) => event.type === "turn_done" || event.type === "error");
      if (existing) break;
      await new Promise<void>((resolve) => runtime.waiters.push(() => resolve()));
    }
    runtime.status = "idle";
    runtime.activeRunId = undefined;
    runtime.lastUsedAt = Date.now();
    return { runId, events: runtime.events.slice(startIndex) };
  }

  async function cancel(sessionId: string): Promise<void> {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return;
    runtime.status = "cancelling";
    await runtime.query.interrupt();
  }

  function closeSession(sessionId: string): void {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return;
    runtime.status = "closed";
    runtime.inputQueue.close();
    runtime.query.close();
    runtimes.delete(sessionId);
  }

  function closeIdle(now = Date.now(), ttlMs = 20 * 60 * 1000): void {
    for (const [sessionId, runtime] of runtimes) {
      if (runtime.status === "idle" && now - runtime.lastUsedAt >= ttlMs) closeSession(sessionId);
    }
  }

  function closeAll(): void {
    for (const sessionId of [...runtimes.keys()]) closeSession(sessionId);
  }

  return { runTurn, cancel, closeSession, closeIdle, closeAll, get activeCount() { return runtimes.size; } };
}

function createRealRuntimeQueryFactory(): AgentRuntimeQueryFactory {
  return async ({ input, options }) => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const sdkQuery = query({ prompt: input, options: options as never });
    return {
      stream: sdkQuery,
      interrupt: () => sdkQuery.interrupt(),
      close: () => sdkQuery.close(),
    };
  };
}
```

- [ ] **Step 4: Run manager tests**

Run:

```bash
bun test tests/agent-runtime-manager.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/agent/runtime-manager.ts tests/agent-runtime-manager.test.ts
git commit -m "feat(agent): add persistent runtime manager"
```

Expected: commit succeeds.

---

### Task 8: Wire Runtime Manager Into Services And Gateway

**Files:**
- Modify: `src/runtime/services.ts`
- Modify: `src/gateway/websocket.ts`
- Modify: `tests/gateway.test.ts`

- [ ] **Step 1: Add runtime manager remap support**

In `src/agent/runtime-manager.ts`, add this method to the returned manager object:

```ts
  function remapSession(fromSessionId: string, toSessionId: string): void {
    if (fromSessionId === toSessionId) return;
    const runtime = runtimes.get(fromSessionId);
    if (!runtime) return;
    if (runtimes.has(toSessionId)) throw new Error(`runtime already exists for session: ${toSessionId}`);
    runtimes.delete(fromSessionId);
    runtime.sessionId = toSessionId;
    runtime.contextRef.current = makeContext(toSessionId);
    runtimes.set(toSessionId, runtime);
  }
```

Update the returned object to include `remapSession`:

```ts
  return { runTurn, cancel, closeSession, closeIdle, closeAll, remapSession, get activeCount() { return runtimes.size; } };
```

Update `type AgentRuntime` so `sessionId` is mutable:

```ts
type AgentRuntime = {
  sessionId: string;
  // existing fields unchanged
};
```

- [ ] **Step 2: Add gateway tests for cancel and manager route**

Update `tests/gateway.test.ts` so `makeServices()` can access `services.agentRuntimeManager`. Add this test to `describe("runUserTurn", ...)`:

```ts
  test("runUserTurn uses agentRuntimeManager and remaps draft runtime to SDK session", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const sent: unknown[] = [];
    const calls: Array<{ sessionId: string; content: string; runId?: string }> = [];
    const remaps: Array<{ from: string; to: string }> = [];
    services.agentRuntimeManager = {
      ...services.agentRuntimeManager,
      runTurn: async (args: { sessionId: string; content: string; runId?: string }) => {
        calls.push(args);
        return {
          runId: args.runId || "r1",
          events: [
            { type: "status", status: "session_init", sessionId: "sdk-session-1" },
            { type: "text_delta", text: "pong", sessionId: "sdk-session-1" },
            { type: "turn_done", sessionId: "sdk-session-1", isError: false, result: "pong" },
          ],
        };
      },
      remapSession: (from: string, to: string) => { remaps.push({ from, to }); },
    } as never;
    const fakeWs = {
      send: (data: string) => sent.push(JSON.parse(data)),
      data: { sessionId: "", services, send: (m: unknown) => sent.push(m) },
    } as unknown as Parameters<typeof import("../src/gateway/websocket.ts").runUserTurn>[0];

    const { runUserTurn } = await import("../src/gateway/websocket.ts");
    await runUserTurn(fakeWs, services, null, "ping", { draftId: "draft-1" });

    expect(calls[0].sessionId).toBe("draft-1");
    expect(remaps).toEqual([{ from: "draft-1", to: "sdk-session-1" }]);
    expect(sent.map((m) => (m as { type: string }).type)).toContain("session.created");
  });
```

Add this test to a new `describe("cancelUserTurn", ...)` block:

```ts
describe("cancelUserTurn", () => {
  test("delegates to agent runtime manager", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    let cancelled = "";
    services.agentRuntimeManager = {
      ...services.agentRuntimeManager,
      cancel: async (sessionId: string) => { cancelled = sessionId; },
    } as never;

    const { cancelUserTurn } = await import("../src/gateway/websocket.ts");
    await cancelUserTurn(services, "s1");

    expect(cancelled).toBe("s1");
  });
});
```

- [ ] **Step 3: Add `agentRuntimeManager` to services**

In `src/runtime/services.ts`, import:

```ts
import { createAgentRuntimeManager } from "../agent/runtime-manager.ts";
```

Add to `ServiceContainer`:

```ts
  agentRuntimeManager: ReturnType<typeof createAgentRuntimeManager>;
```

After `queryFactory` is created, create:

```ts
  const agentRuntimeManager = createAgentRuntimeManager({
    config,
    registry: toolRegistry,
    sdkConfigDir: paths.sdkConfigDir,
    sessionStore: sdkSessionStore,
    promptInputs: {
      home: paths.home,
      workspacePath: paths.workspace,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userFile: paths.userFile,
      soulFile: paths.soulFile,
    },
  });
```

Return it in the service container.

- [ ] **Step 4: Update `runUserTurn()` to call manager**

In `src/gateway/websocket.ts`, keep frame aggregation semantics but replace the runner loop with:

```ts
  const runtimeSessionId = sdkSessionId ?? sessionId ?? options.draftId ?? `pending-${runId}`;
  const { events } = await services.agentRuntimeManager.runTurn({
    sessionId: runtimeSessionId,
    content,
    runId,
    resumeSessionId: sdkSessionId,
  });

  for (const ev of events) {
    if (ev.sessionId && ev.sessionId !== lastSessionId) lastSessionId = ev.sessionId;
    if (!sdkSessionId && !sessionCreated && lastSessionId && lastSessionId !== "pending") {
      sessionCreated = true;
      send({ type: "session.created", draftId: options.draftId, session: draftSessionSummary(lastSessionId, content) });
      if (runtimeSessionId !== lastSessionId) services.agentRuntimeManager.remapSession(runtimeSessionId, lastSessionId);
    }
    forwardNative(send, ev, runId, lastSessionId ?? initialRouteId);
    if (ev.type === "text_delta") collected += ev.text;
    if (ev.type === "turn_done") {
      finalResult = ev.result;
      if (ev.sessionId) lastSessionId = ev.sessionId;
    }
    if (ev.type === "error") {
      turnErrored = true;
      finalResult = `[error] ${ev.message}`;
    }
  }
```

- [ ] **Step 5: Implement cancel helper**

Export this helper from `src/gateway/websocket.ts`:

```ts
export async function cancelUserTurn(services: ServiceContainer, sessionId: string): Promise<void> {
  await services.agentRuntimeManager.cancel(sessionId);
}
```

In `handleClientMessage`, replace cancel case with:

```ts
    case "chat.cancel": {
      await cancelUserTurn(services, msg.sessionId);
      return;
    }
```

- [ ] **Step 6: Run gateway tests**

Run:

```bash
bun test tests/gateway.test.ts tests/agent-runtime-manager.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/runtime/services.ts src/gateway/websocket.ts tests/gateway.test.ts
git commit -m "feat(gateway): use persistent agent runtimes"
```

Expected: commit succeeds.

---

### Task 9: Protocol Status Frame For MCP Init

**Files:**
- Modify: `src/shared/webui-protocol.ts`
- Modify: `src/gateway/websocket.ts`
- Modify: `tests/gateway.test.ts`

- [ ] **Step 1: Add protocol type**

In `src/shared/webui-protocol.ts`, add to `ServerFrame` union:

```ts
  | { type: "run.status"; sessionId?: string; runId?: string; status: string; mcpServers?: Array<{ name: string; status: string; [key: string]: unknown }> }
```

- [ ] **Step 2: Forward status events**

In `src/gateway/websocket.ts`, update `forwardNative()` status case:

```ts
    case "status":
      send({ type: "run.status", sessionId, runId, status: ev.status, mcpServers: ev.mcpServers });
      break;
```

- [ ] **Step 3: Add gateway assertion**

In `tests/gateway.test.ts`, add an init fixture with `mcp_servers` and assert `run.status` is emitted before completion.

- [ ] **Step 4: Run tests**

Run:

```bash
bun test tests/gateway.test.ts tests/agent-runner.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/shared/webui-protocol.ts src/gateway/websocket.ts tests/gateway.test.ts
git commit -m "feat(gateway): emit mcp runtime status"
```

Expected: commit succeeds.

---

### Task 10: Full Verification

**Files:**
- No planned source edits unless verification exposes failures.

- [ ] **Step 1: Run backend typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run backend tests**

Run:

```bash
bun run test
```

Expected: PASS.

- [ ] **Step 3: Run WebUI tests only if protocol type changes affect frontend compile**

Run:

```bash
cd webui && bun run test
```

Expected: PASS.

- [ ] **Step 4: Run WebUI build if shared protocol import affects frontend**

Run:

```bash
cd webui && bun run build
```

Expected: PASS.

- [ ] **Step 5: Check worktree**

Run:

```bash
git status --short --branch
```

Expected: clean except planned commits.

---

## Self-Review Notes

- Spec coverage: config MCP, SDK native/external server composition, dynamic context, per-session long-lived runtime, multi-session parallelism, cancel, status forwarding, scheduler one-off lifecycle, tests are covered by Tasks 2-10.
- No MCP client/proxy/registry for external MCP is introduced.
- The risky area is draft session remap in Task 8. The implementation must either key first-turn runtime by resolved SDK session as soon as `system/init` arrives, or add explicit `remapSession(oldId, newId)` before returning from first turn.
- WebUI visible behavior is not intentionally changed beyond optional `run.status` frames. If frontend starts rendering MCP status in this implementation, run Chromium CDP verification per AGENTS.md.
