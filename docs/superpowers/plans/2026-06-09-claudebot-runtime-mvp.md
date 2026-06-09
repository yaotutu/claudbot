# Claudebot Runtime MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild claudebot as a Bun/TypeScript WebUI-first personal AI assistant runtime with Claude Agent SDK, in-process native tools, scheduler, memory, agent files, sessions, and JSON persistence.

**Architecture:** Build a Bun server around a per-instance `ServiceContainer`. The gateway serves HTTP/WebSocket and delegates to stores, the Claude runner, and a native tool runtime backed by Claude Agent SDK's in-process SDK MCP server.

**Tech Stack:** Bun, TypeScript, Zod, Claude Agent SDK, cron-parser, React/Vite WebUI, `bun test`.

---

## File Structure

Create:

- `package.json`: Bun scripts and dependencies.
- `tsconfig.json`: strict TypeScript configuration for Bun.
- `src/server.ts`: server entrypoint.
- `src/config/schema.ts`: Zod schemas and runtime config types.
- `src/config/loader.ts`: config loading, defaults, home/workspace resolution.
- `src/config/paths.ts`: path helpers for home, sessions, scheduler, agent files, media, logs, audit.
- `src/utils/fs.ts`: atomic writes, directory creation, JSON helpers, path expansion.
- `src/utils/id.ts`: stable ID generation.
- `src/utils/logger.ts`: minimal scoped logger.
- `src/runtime/services.ts`: service container construction.
- `src/runtime/state.ts`: last active session state.
- `src/agent/profile.ts`: `user.md`, `soul.md`, `memory.json` initialization and versioned editing.
- `src/agent/prompt.ts`: system prompt assembly.
- `src/agent/events.ts`: normalized event types.
- `src/agent/runner.ts`: Claude Agent SDK runner.
- `src/tools/types.ts`: native tool abstractions.
- `src/tools/registry.ts`: validate, authorize, audit, execute.
- `src/tools/permissions.ts`: allow/deny/confirm policy evaluation.
- `src/tools/audit.ts`: JSONL audit log.
- `src/tools/sdk-adapter.ts`: convert registered tools to Claude SDK MCP tools.
- `src/tools/builtin/scheduler.ts`: scheduler native tools.
- `src/tools/builtin/memory.ts`: memory native tools.
- `src/tools/builtin/agent-files.ts`: agent file native tools.
- `src/memory/types.ts`: memory JSON types.
- `src/memory/store.ts`: memory CRUD/search.
- `src/sessions/types.ts`: session/message types.
- `src/sessions/store.ts`: session JSON store.
- `src/scheduler/types.ts`: schedule/run types.
- `src/scheduler/store.ts`: schedule and run JSON persistence.
- `src/scheduler/service.ts`: cron scheduling, running lock, execution.
- `src/gateway/protocol.ts`: HTTP/WS envelope types.
- `src/gateway/http.ts`: REST API and static serving.
- `src/gateway/websocket.ts`: WS connection/session/turn handling.
- `tests/**/*.test.ts`: focused Bun tests for each core module.

Copy/adapt later:

- `webui/`: migrate existing React WebUI after backend protocol is stable.

---

## Parallel Execution Strategy

Use subagents only for tasks with disjoint write sets. The controller keeps the critical path local and integrates/reviews returned changes.

### Wave 0: Critical Path, Local Only

- Task 1: Project skeleton.
- Task 2: Claude Agent SDK native tool spike.

Reason: every later task depends on package setup and SDK facts.

### Wave 1: Independent Foundations

These can run in parallel after Task 3 establishes shared utilities and path conventions:

- Agent A: Task 4 sessions/runtime state.
  - Write set: `src/sessions/**`, `src/runtime/state.ts`, `tests/sessions.test.ts`.
- Agent B: Task 5 agent files/memory.
  - Write set: `src/agent/profile.ts`, `src/memory/**`, `tests/agent-profile-memory.test.ts`.
- Agent C: Task 7 scheduler store/service.
  - Write set: `src/scheduler/**`, `tests/scheduler.test.ts`.

Controller responsibility: review public types for consistency before integration.

### Wave 2: Tool Integration

After Wave 1 lands, Task 6 tool runtime and Task 8 built-in tools are partly parallel:

- Controller or one subagent implements Task 6 core tool runtime.
- A separate subagent may implement built-in tool registration only after Task 6 interfaces are stable.

Write sets must stay disjoint:

- Tool core: `src/tools/types.ts`, `src/tools/registry.ts`, `src/tools/permissions.ts`, `src/tools/audit.ts`, `src/tools/sdk-adapter.ts`, `tests/tools.test.ts`.
- Built-ins: `src/tools/builtin/**`, additional tests in `tests/tools-builtin.test.ts`.

### Wave 3: Gateway and WebUI

After runner interfaces are stable:

- Agent A: Gateway HTTP/WS with mocked runner.
  - Write set: `src/gateway/**`, `tests/gateway.test.ts`.
- Agent B: WebUI migration audit and feature hiding.
  - Write set: `webui/**`.

Do not let both agents edit protocol names independently. `src/gateway/protocol.ts` is owned by the gateway task and WebUI must adapt to it.

### Final Integration

Run the full suite locally after all subagent work:

- `bun test`
- `bun run typecheck`
- `cd webui && bun run build`
- Server smoke test against `/health`
- WebUI manual smoke test

---

## Test and Verification Gates

No production behavior should be implemented without a failing test first, except throwaway SDK spike code and generated/bundled WebUI assets.

Each task must follow:

1. Write a behavior test.
2. Run the focused test and verify it fails for the expected reason.
3. Implement minimal code.
4. Run the focused test and verify it passes.
5. Run relevant adjacent tests.

Quality gates before considering the MVP complete:

- `bun test` passes.
- `bun run typecheck` passes.
- WebUI build passes.
- Gateway `/health` responds with JSON.
- Mocked WebSocket chat test proves user message -> assistant message flow.
- Mocked `schedule_run_now` test proves result lands in last active session.
- Mocked failing schedule test proves failure notice lands in last active session.
- SDK spike proves in-process native tool wiring works under Bun.
- SDK spike captures representative event fixtures for text, tool use, tool result, final result, and resume.
- Scheduler unit/integration tests cover lock skip, executor failure persistence, invalid cron rejection, due tick behavior, no automatic retry, next-run advancement, and schedule delivery to last active or inbox session.
- Tool tests cover audit JSONL writes, unknown tool errors, validation errors, `confirm` treated as denied in MVP, built-in tool schemas, and SDK adapter creation.
- Browser smoke test covers bootstrap, session create/switch, mocked streaming render, agent file edit including 409 conflict, hidden deferred features, and schedule result/failure display.
- Manual live Claude smoke test is attempted if credentials are available; if not available, the final report must state that live SDK execution was not verified.

---

### Task 1: Initialize Bun/TypeScript Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/server.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claudebot",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "bin": {
    "claudebot": "./src/server.ts"
  },
  "scripts": {
    "dev": "bun run --watch src/server.ts",
    "start": "bun run src/server.ts",
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.169",
    "cron-parser": "^5.5.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "module": "ESNext",
    "target": "ESNext",
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Create temporary `src/server.ts`**

```ts
console.log("claudebot runtime starting");
```

- [ ] **Step 4: Create `src/index.ts`**

```ts
export {};
```

- [ ] **Step 5: Install dependencies**

Run: `bun install`

Expected: creates `bun.lock` and installs dependencies without errors.

- [ ] **Step 6: Verify project boots**

Run: `bun run src/server.ts`

Expected output contains `claudebot runtime starting`.

- [ ] **Step 7: Verify typecheck**

Run: `bun run typecheck`

Expected: exits 0.

---

### Task 2: Prove Claude Agent SDK Native Tool Spike

**Files:**
- Create: `src/spikes/sdk-native-tool-spike.ts`

- [ ] **Step 1: Create SDK spike**

```ts
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

const server = createSdkMcpServer({
  name: "claudebot_spike",
  version: "0.0.0",
  alwaysLoad: true,
  tools: [
    tool(
      "claudebot_echo",
      "Echo text back from the claudebot in-process native tool runtime.",
      { text: z.string() },
      async ({ text }) => ({
        content: [{ type: "text", text: `echo:${text}` }],
      }),
    ),
  ],
});

const prompt = "Call the claudebot_echo tool with text 'ok', then summarize the result.";

for await (const message of query({
  prompt,
  options: {
    mcpServers: {
      claudebot_spike: server,
    },
    permissionMode: "bypassPermissions",
    maxTurns: 5,
  },
})) {
  console.log(JSON.stringify(message));
}
```

- [ ] **Step 2: Run spike**

Run: `bun run src/spikes/sdk-native-tool-spike.ts`

Expected: SDK starts and emits messages. If auth is unavailable, failure must be an auth/model error, not a TypeScript/import/runtime error.

- [ ] **Step 3: Capture SDK event shapes**

Save observed message examples in a local note during implementation. Use these examples to implement `src/agent/events.ts`.

- [ ] **Step 4: Verify resume option shape**

Extend the spike or create a second throwaway spike that passes a previous `session_id` back through the SDK resume option supported by the installed SDK. Record the exact option name and message field used for resume in the implementation notes.

- [ ] **Step 5: Save event fixtures**

Create `tests/fixtures/sdk-events/README.md` during implementation with sanitized examples for:

- text delta or assistant text message
- tool start
- tool result
- final result
- error
- resumed session ID

These fixtures drive `tests/agent-runner.test.ts`.

---

### Task 3: Implement Config, Paths, and JSON IO

**Files:**
- Create: `src/utils/fs.ts`
- Create: `src/utils/id.ts`
- Create: `src/config/schema.ts`
- Create: `src/config/loader.ts`
- Create: `src/config/paths.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write config tests**

```ts
import { describe, expect, test } from "bun:test";
import { resolveRuntimeConfig } from "../src/config/loader.ts";

describe("runtime config", () => {
  test("uses default home and workspace", () => {
    const config = resolveRuntimeConfig({}, { homeEnv: "", configDir: "/tmp/cfg" });
    expect(config.home.endsWith("/.claudebot")).toBe(true);
    expect(config.workspace.path.endsWith("/.claudebot/workspace")).toBe(true);
  });

  test("home overrides workspace default", () => {
    const config = resolveRuntimeConfig({ home: "/tmp/bot" }, { homeEnv: "", configDir: "/tmp/cfg" });
    expect(config.home).toBe("/tmp/bot");
    expect(config.workspace.path).toBe("/tmp/bot/workspace");
  });

  test("explicit workspace wins", () => {
    const config = resolveRuntimeConfig(
      { home: "/tmp/bot", workspace: { path: "/tmp/ws" } },
      { homeEnv: "", configDir: "/tmp/cfg" },
    );
    expect(config.workspace.path).toBe("/tmp/ws");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/config.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement `src/utils/fs.ts`**

```ts
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export async function ensureDir(path: string): Promise<void> {
  await Bun.$`mkdir -p ${path}`.quiet();
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) return fallback;
  return (await file.json()) as T;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await Bun.$`mv ${tmp} ${path}`.quiet();
}
```

- [ ] **Step 4: Implement `src/utils/id.ts`**

```ts
import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}
```

- [ ] **Step 5: Implement `src/config/schema.ts`**

```ts
import { z } from "zod/v4";

export const PermissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const RuntimeConfigSchema = z.object({
  home: z.string().optional(),
  workspace: z.object({ path: z.string().optional() }).default({}),
  gateway: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(18790),
  }).default({}),
  claudeCode: z.object({
    baseUrl: z.string().default(""),
    apiKey: z.string().default(""),
    model: z.string().default("glm-cn/glm-5.1"),
    permissionMode: PermissionModeSchema.default("bypassPermissions"),
    maxTurns: z.number().int().min(1).default(200),
  }).default({}),
  tools: z.object({
    permissions: z.object({
      default: z.enum(["allow", "deny", "confirm"]).default("allow"),
      overrides: z.record(z.string(), z.enum(["allow", "deny", "confirm"])).default({}),
    }).default({}),
  }).default({}),
});

export type RuntimeConfigInput = z.input<typeof RuntimeConfigSchema>;
export type RuntimeConfig = z.output<typeof RuntimeConfigSchema> & {
  home: string;
  workspace: { path: string };
};
```

- [ ] **Step 6: Implement `src/config/loader.ts`**

```ts
import { join } from "node:path";
import { homedir } from "node:os";
import { RuntimeConfigSchema, type RuntimeConfig, type RuntimeConfigInput } from "./schema.ts";
import { expandPath, readJson } from "../utils/fs.ts";

type ResolveEnv = {
  homeEnv?: string;
  configDir?: string;
};

export function defaultHome(): string {
  return join(homedir(), ".claudebot");
}

export function resolveRuntimeConfig(input: RuntimeConfigInput, env: ResolveEnv = {}): RuntimeConfig {
  const parsed = RuntimeConfigSchema.parse(input);
  const rawHome = parsed.home || env.homeEnv || defaultHome();
  const home = expandPath(rawHome);
  const workspacePath = expandPath(parsed.workspace.path || join(home, "workspace"));
  return {
    ...parsed,
    home,
    workspace: { path: workspacePath },
  };
}

export async function loadConfig(configPath?: string): Promise<RuntimeConfig> {
  const data = configPath ? await readJson<RuntimeConfigInput>(expandPath(configPath), {}) : {};
  return resolveRuntimeConfig(data, { homeEnv: process.env.CLAUDEBOT_HOME || "" });
}
```

- [ ] **Step 7: Implement `src/config/paths.ts`**

```ts
import { join } from "node:path";
import type { RuntimeConfig } from "./schema.ts";

export type RuntimePaths = {
  home: string;
  workspace: string;
  agentDir: string;
  userFile: string;
  soulFile: string;
  memoryFile: string;
  sessionsDir: string;
  schedulerDir: string;
  schedulesFile: string;
  runsFile: string;
  webuiDir: string;
  runtimeStateFile: string;
  mediaDir: string;
  auditDir: string;
  toolAuditFile: string;
};

export function runtimePaths(config: RuntimeConfig): RuntimePaths {
  const home = config.home;
  return {
    home,
    workspace: config.workspace.path,
    agentDir: join(home, "agent"),
    userFile: join(home, "agent", "user.md"),
    soulFile: join(home, "agent", "soul.md"),
    memoryFile: join(home, "agent", "memory.json"),
    sessionsDir: join(home, "sessions"),
    schedulerDir: join(home, "scheduler"),
    schedulesFile: join(home, "scheduler", "schedules.json"),
    runsFile: join(home, "scheduler", "runs.json"),
    webuiDir: join(home, "webui"),
    runtimeStateFile: join(home, "webui", "runtime_state.json"),
    mediaDir: join(home, "media"),
    auditDir: join(home, "audit"),
    toolAuditFile: join(home, "audit", "tools.jsonl"),
  };
}
```

- [ ] **Step 8: Run config tests**

Run: `bun test tests/config.test.ts`

Expected: PASS.

---

### Task 4: Implement Session Store and Runtime State

**Files:**
- Create: `src/sessions/types.ts`
- Create: `src/sessions/store.ts`
- Create: `src/runtime/state.ts`
- Test: `tests/sessions.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/sessions/store.ts";
import { RuntimeStateStore } from "../src/runtime/state.ts";

describe("sessions and active state", () => {
  test("creates inbox when no active session exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-sessions-"));
    const sessions = new SessionStore(dir);
    const state = new RuntimeStateStore(join(dir, "runtime_state.json"));
    const session = await sessions.getOrCreateInbox();
    await state.setLastActiveSession(session.id, "user_open");
    expect((await state.get()).lastActiveSessionId).toBe("inbox");
  });

  test("assistant append does not change active session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-sessions-"));
    const state = new RuntimeStateStore(join(dir, "runtime_state.json"));
    await state.setLastActiveSession("sess_a", "user_message");
    await state.recordAssistantAppend("sess_b");
    expect((await state.get()).lastActiveSessionId).toBe("sess_a");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/sessions.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement session types**

```ts
export type SessionMessageRole = "user" | "assistant" | "system";

export type SessionMessage = {
  id: string;
  role: SessionMessageRole;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type SessionRecord = {
  id: string;
  title: string;
  preview: string;
  claudeSessionId: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
};
```

- [ ] **Step 4: Implement session store**

```ts
import { join } from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "../utils/fs.ts";
import { newId } from "../utils/id.ts";
import type { SessionMessage, SessionRecord } from "./types.ts";

function now(): string {
  return new Date().toISOString();
}

export class SessionStore {
  constructor(private readonly dir: string) {}

  async create(title = "New chat", id = newId("sess")): Promise<SessionRecord> {
    await ensureDir(this.dir);
    const time = now();
    const record: SessionRecord = {
      id,
      title,
      preview: "",
      claudeSessionId: "",
      createdAt: time,
      updatedAt: time,
      messages: [],
    };
    await this.save(record);
    return record;
  }

  async get(id: string): Promise<SessionRecord | null> {
    return readJson<SessionRecord | null>(this.pathFor(id), null);
  }

  async getOrCreateInbox(): Promise<SessionRecord> {
    return (await this.get("inbox")) || this.create("Inbox", "inbox");
  }

  async save(record: SessionRecord): Promise<void> {
    record.updatedAt = now();
    await writeJsonAtomic(this.pathFor(record.id), record);
  }

  async appendMessage(sessionId: string, message: Omit<SessionMessage, "id" | "createdAt">): Promise<SessionRecord> {
    const record = (await this.get(sessionId)) || (sessionId === "inbox" ? await this.getOrCreateInbox() : await this.create("New chat", sessionId));
    record.messages.push({
      id: newId("msg"),
      createdAt: now(),
      ...message,
    });
    record.preview = message.content.slice(0, 120);
    await this.save(record);
    return record;
  }

  pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
```

- [ ] **Step 5: Implement runtime state**

```ts
import { readJson, writeJsonAtomic } from "../utils/fs.ts";

export type RuntimeState = {
  lastActiveSessionId: string;
  lastActiveAt: string;
  lastActiveReason: string;
};

const emptyState: RuntimeState = {
  lastActiveSessionId: "",
  lastActiveAt: "",
  lastActiveReason: "",
};

export class RuntimeStateStore {
  constructor(private readonly path: string) {}

  async get(): Promise<RuntimeState> {
    return readJson<RuntimeState>(this.path, emptyState);
  }

  async setLastActiveSession(sessionId: string, reason: "user_open" | "user_switch" | "user_message"): Promise<void> {
    await writeJsonAtomic(this.path, {
      lastActiveSessionId: sessionId,
      lastActiveAt: new Date().toISOString(),
      lastActiveReason: reason,
    });
  }

  async recordAssistantAppend(_sessionId: string): Promise<void> {
    return;
  }
}
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/sessions.test.ts`

Expected: PASS.

---

### Task 5: Implement Agent Files and Memory Store

**Files:**
- Create: `src/agent/profile.ts`
- Create: `src/memory/types.ts`
- Create: `src/memory/store.ts`
- Test: `tests/agent-profile-memory.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentProfileStore } from "../src/agent/profile.ts";
import { MemoryStore } from "../src/memory/store.ts";

describe("agent profile and memory", () => {
  test("initializes user soul and memory files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-agent-"));
    const store = new AgentProfileStore({
      userFile: join(dir, "user.md"),
      soulFile: join(dir, "soul.md"),
      memoryFile: join(dir, "memory.json"),
    });
    await store.init();
    expect((await store.readFile("user.md")).content.length).toBeGreaterThan(0);
    expect((await store.readFile("soul.md")).content.length).toBeGreaterThan(0);
    expect(JSON.parse((await store.readFile("memory.json")).content).entries).toEqual([]);
  });

  test("rejects stale file version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-agent-"));
    const store = new AgentProfileStore({
      userFile: join(dir, "user.md"),
      soulFile: join(dir, "soul.md"),
      memoryFile: join(dir, "memory.json"),
    });
    await store.init();
    const first = await store.readFile("user.md");
    await store.updateFile("user.md", "new content", first.version);
    await expect(store.updateFile("user.md", "stale", first.version)).rejects.toThrow("version conflict");
  });

  test("memory create and search", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-memory-"));
    const memory = new MemoryStore(join(dir, "memory.json"));
    const entry = await memory.create({ content: "User prefers Chinese.", tags: ["preference"], source: "test", confidence: 1 });
    expect(entry.id.startsWith("mem_")).toBe(true);
    expect((await memory.search("Chinese")).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/agent-profile-memory.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement memory types**

```ts
export type MemoryEntry = {
  id: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
};

export type MemoryFile = {
  entries: MemoryEntry[];
};
```

- [ ] **Step 4: Implement memory store**

```ts
import { newId } from "../utils/id.ts";
import { readJson, writeJsonAtomic } from "../utils/fs.ts";
import type { MemoryEntry, MemoryFile } from "./types.ts";

function now(): string {
  return new Date().toISOString();
}

export class MemoryStore {
  constructor(private readonly path: string) {}

  async read(): Promise<MemoryFile> {
    return readJson<MemoryFile>(this.path, { entries: [] });
  }

  async write(file: MemoryFile): Promise<void> {
    await writeJsonAtomic(this.path, file);
  }

  async create(input: Pick<MemoryEntry, "content" | "tags" | "source" | "confidence">): Promise<MemoryEntry> {
    const file = await this.read();
    const time = now();
    const entry: MemoryEntry = { id: newId("mem"), createdAt: time, updatedAt: time, ...input };
    file.entries.push(entry);
    await this.write(file);
    return entry;
  }

  async search(query: string): Promise<MemoryEntry[]> {
    const q = query.toLowerCase();
    const file = await this.read();
    return file.entries.filter((entry) =>
      entry.content.toLowerCase().includes(q) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }
}
```

- [ ] **Step 5: Implement agent profile store**

```ts
import { createHash } from "node:crypto";
import { ensureDir, readJson, writeJsonAtomic } from "../utils/fs.ts";

type AgentFiles = {
  userFile: string;
  soulFile: string;
  memoryFile: string;
};

export type AgentFileName = "user.md" | "soul.md" | "memory.json";

const defaults: Record<AgentFileName, string> = {
  "user.md": "# User\n\nDescribe the user this assistant serves.\n",
  "soul.md": "# Soul\n\nDescribe this assistant's enduring identity, values, and behavior.\n",
  "memory.json": "{\n  \"entries\": []\n}\n",
};

export class AgentProfileStore {
  constructor(private readonly files: AgentFiles) {}

  async init(): Promise<void> {
    for (const name of ["user.md", "soul.md", "memory.json"] as const) {
      const path = this.pathFor(name);
      await ensureDir(path.split("/").slice(0, -1).join("/"));
      if (!(await Bun.file(path).exists())) {
        await Bun.write(path, defaults[name]);
      }
    }
  }

  async readFile(name: AgentFileName): Promise<{ content: string; version: string }> {
    const content = await Bun.file(this.pathFor(name)).text();
    return { content, version: this.version(content) };
  }

  async updateFile(name: AgentFileName, content: string, expectedVersion: string): Promise<{ version: string }> {
    const current = await this.readFile(name);
    if (current.version !== expectedVersion) throw new Error("version conflict");
    if (name === "memory.json") JSON.parse(content);
    await writeJsonAtomic(this.pathFor(name), name === "memory.json" ? JSON.parse(content) : content);
    const saved = name === "memory.json" ? `${JSON.stringify(JSON.parse(content), null, 2)}\n` : content;
    return { version: this.version(saved) };
  }

  pathFor(name: AgentFileName): string {
    if (name === "user.md") return this.files.userFile;
    if (name === "soul.md") return this.files.soulFile;
    return this.files.memoryFile;
  }

  private version(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}
```

- [ ] **Step 6: Fix Markdown write bug**

Replace `updateFile()` write block with text-aware atomic writing when implementing. `writeJsonAtomic()` must not be used for Markdown because it JSON-encodes strings. Add a `writeTextAtomic()` helper in `src/utils/fs.ts`:

```ts
export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await Bun.write(tmp, content);
  await Bun.$`mv ${tmp} ${path}`.quiet();
}
```

Then use `writeTextAtomic()` for Markdown and `writeJsonAtomic()` for `memory.json`.

- [ ] **Step 7: Run tests**

Run: `bun test tests/agent-profile-memory.test.ts`

Expected: PASS.

---

### Task 6: Implement Tool Runtime

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/permissions.ts`
- Create: `src/tools/audit.ts`
- Create: `src/tools/registry.ts`
- Create: `src/tools/sdk-adapter.ts`
- Test: `tests/tools.test.ts`

- [ ] **Step 1: Write tool runtime tests**

```ts
import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../src/tools/registry.ts";

describe("tool registry", () => {
  test("validates and executes a tool", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registry.register({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: async (input) => ({ text: input.text }),
    });
    const result = await registry.execute("echo", { text: "ok" }, { source: "user_turn" } as never);
    expect(result).toEqual({ text: "ok" });
  });

  test("denies a denied tool", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "deny", overrides: {} });
    registry.register({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: async () => ({ text: "no" }),
    });
    await expect(registry.execute("echo", { text: "ok" }, { source: "user_turn" } as never)).rejects.toThrow("denied");
  });
});
```

Add these tests before implementation is considered complete:

```ts
test("confirm policy is denied in MVP", async () => {
  // Registry with defaultPolicy confirm rejects execution with a clear confirmation-not-implemented message.
});

test("unknown tool returns a structured error", async () => {
  // Executing a missing tool rejects with unknown tool.
});

test("invalid input reports validation failure", async () => {
  // Register z.object({ text: z.string() }), call with number, expect validation error.
});

test("audit log records success and failure", async () => {
  // Execute one succeeding and one failing tool, read tools.jsonl, assert statuses.
});

test("sdk adapter creates in-process mcp server", async () => {
  // Register echo tool, create SDK MCP server, assert server config has type sdk and name claudebot.
});
```

- [ ] **Step 2: Implement types**

```ts
import type { z } from "zod/v4";

export type ToolPolicy = "allow" | "deny" | "confirm";
export type ToolSource = "user_turn" | "schedule_turn";

export type ToolContext = {
  source: ToolSource;
  home: string;
  workspacePath: string;
  timezone: string;
  sessionId?: string;
  scheduleRunId?: string;
  services: unknown;
};

export type NativeTool<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  execute(input: Input, context: ToolContext): Promise<Output>;
};
```

- [ ] **Step 3: Implement permissions**

```ts
import type { ToolPolicy } from "./types.ts";

export type ToolPermissionConfig = {
  defaultPolicy: ToolPolicy;
  overrides: Record<string, ToolPolicy>;
};

export function resolveToolPolicy(config: ToolPermissionConfig, toolName: string): ToolPolicy {
  return config.overrides[toolName] || config.defaultPolicy;
}
```

- [ ] **Step 4: Implement audit**

```ts
export type ToolAuditRecord = {
  toolName: string;
  status: "started" | "succeeded" | "failed" | "denied";
  source: string;
  at: string;
  error?: string;
};

export class ToolAuditLog {
  constructor(private readonly path: string) {}

  async append(record: ToolAuditRecord): Promise<void> {
    await Bun.write(this.path, `${JSON.stringify(record)}\n`, { append: true });
  }
}
```

- [ ] **Step 5: Implement registry**

```ts
import type { NativeTool, ToolContext } from "./types.ts";
import { resolveToolPolicy, type ToolPermissionConfig } from "./permissions.ts";

export class ToolRegistry {
  private readonly tools = new Map<string, NativeTool<any, any>>();

  constructor(private readonly permissions: ToolPermissionConfig) {}

  register(tool: NativeTool<any, any>): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  list(): NativeTool<any, any>[] {
    return [...this.tools.values()];
  }

  async execute(name: string, rawInput: unknown, context: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    const policy = resolveToolPolicy(this.permissions, name);
    if (policy === "deny" || policy === "confirm") throw new Error(`tool denied: ${name}`);
    const input = tool.inputSchema.parse(rawInput);
    return tool.execute(input, context);
  }
}
```

- [ ] **Step 6: Implement SDK adapter**

```ts
import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { ToolContext } from "./types.ts";
import type { ToolRegistry } from "./registry.ts";

export function createClaudebotSdkMcpServer(registry: ToolRegistry, context: ToolContext) {
  return createSdkMcpServer({
    name: "claudebot",
    version: "0.1.0",
    alwaysLoad: true,
    instructions: "Claudebot native tools for this personal assistant instance.",
    tools: registry.list().map((nativeTool) =>
      sdkTool(nativeTool.name, nativeTool.description, nativeTool.inputSchema as never, async (args) => {
        const result = await registry.execute(nativeTool.name, args, context);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      }),
    ),
  });
}
```

- [ ] **Step 7: Run tests**

Run: `bun test tests/tools.test.ts`

Expected: PASS.

---

### Task 7: Implement Scheduler Store and Service

**Files:**
- Create: `src/scheduler/types.ts`
- Create: `src/scheduler/store.ts`
- Create: `src/scheduler/service.ts`
- Test: `tests/scheduler.test.ts`

- [ ] **Step 1: Write scheduler tests**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerStore } from "../src/scheduler/store.ts";
import { SchedulerService } from "../src/scheduler/service.ts";

describe("scheduler", () => {
  test("creates schedule with next run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const service = new SchedulerService(store, async () => "ok");
    const schedule = await service.create({
      name: "test",
      cronExpr: "* * * * *",
      timezone: "UTC",
      message: "run",
    });
    expect(schedule.id.startsWith("sch_")).toBe(true);
    expect(schedule.state.nextRunAt).toBeTruthy();
  });

  test("run now records result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const service = new SchedulerService(store, async () => "done");
    const schedule = await service.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    const run = await service.runNow(schedule.id);
    expect(run.status).toBe("succeeded");
    expect(run.result).toBe("done");
  });
});
```

Add these tests before production implementation is considered complete:

```ts
test("run now skips when schedule is already running", async () => {
  // Create schedule, persist state.running = true, call runNow, expect status skipped_running.
});

test("executor failure is persisted without retry", async () => {
  // Executor throws once, runNow returns failed, runs.json contains one failed run, schedule.lastError is set.
});

test("invalid cron is rejected", async () => {
  // create({ cronExpr: "not cron" }) rejects with validation error.
});

test("due tick runs due schedules and advances nextRunAt", async () => {
  // Force nextRunAt into the past, call tick(now), expect executor called once and nextRunAt in future.
});
```

- [ ] **Step 2: Implement scheduler types**

```ts
export type ScheduleRecord = {
  id: string;
  name: string;
  enabled: boolean;
  cronExpr: string;
  timezone: string;
  message: string;
  state: {
    nextRunAt: string;
    lastRunAt: string | null;
    lastStatus: string | null;
    lastError: string | null;
    runCount: number;
    running: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

export type ScheduleRunRecord = {
  id: string;
  scheduleId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "succeeded" | "failed" | "skipped_running";
  result: string;
  error: string;
};
```

- [ ] **Step 3: Implement store**

```ts
import { readJson, writeJsonAtomic } from "../utils/fs.ts";
import type { ScheduleRecord, ScheduleRunRecord } from "./types.ts";

type SchedulesFile = { schedules: ScheduleRecord[] };
type RunsFile = { runs: ScheduleRunRecord[] };

export class SchedulerStore {
  constructor(private readonly schedulesPath: string, private readonly runsPath: string) {}

  async listSchedules(): Promise<ScheduleRecord[]> {
    return (await readJson<SchedulesFile>(this.schedulesPath, { schedules: [] })).schedules;
  }

  async saveSchedules(schedules: ScheduleRecord[]): Promise<void> {
    await writeJsonAtomic(this.schedulesPath, { schedules });
  }

  async listRuns(): Promise<ScheduleRunRecord[]> {
    return (await readJson<RunsFile>(this.runsPath, { runs: [] })).runs;
  }

  async appendRun(run: ScheduleRunRecord): Promise<void> {
    const runs = await this.listRuns();
    runs.push(run);
    await writeJsonAtomic(this.runsPath, { runs });
  }

  async updateRun(run: ScheduleRunRecord): Promise<void> {
    const runs = await this.listRuns();
    const index = runs.findIndex((item) => item.id === run.id);
    if (index >= 0) runs[index] = run;
    else runs.push(run);
    await writeJsonAtomic(this.runsPath, { runs });
  }
}
```

- [ ] **Step 4: Implement service**

```ts
import { CronExpressionParser } from "cron-parser";
import { newId } from "../utils/id.ts";
import type { ScheduleRecord, ScheduleRunRecord } from "./types.ts";
import type { SchedulerStore } from "./store.ts";

type CreateScheduleInput = {
  name: string;
  cronExpr: string;
  timezone: string;
  message: string;
};

type ScheduleExecutor = (schedule: ScheduleRecord, run: ScheduleRunRecord) => Promise<string>;

function now(): string {
  return new Date().toISOString();
}

export class SchedulerService {
  constructor(
    private readonly store: SchedulerStore,
    private readonly executor: ScheduleExecutor,
  ) {}

  async create(input: CreateScheduleInput): Promise<ScheduleRecord> {
    const time = now();
    const schedule: ScheduleRecord = {
      id: newId("sch"),
      name: input.name,
      enabled: true,
      cronExpr: input.cronExpr,
      timezone: input.timezone,
      message: input.message,
      state: {
        nextRunAt: this.nextRunAt(input.cronExpr, input.timezone),
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        runCount: 0,
        running: false,
      },
      createdAt: time,
      updatedAt: time,
    };
    const schedules = await this.store.listSchedules();
    schedules.push(schedule);
    await this.store.saveSchedules(schedules);
    return schedule;
  }

  async runNow(id: string): Promise<ScheduleRunRecord> {
    const schedules = await this.store.listSchedules();
    const schedule = schedules.find((item) => item.id === id);
    if (!schedule) throw new Error(`schedule not found: ${id}`);
    return this.runSchedule(schedule, schedules);
  }

  private async runSchedule(schedule: ScheduleRecord, schedules: ScheduleRecord[]): Promise<ScheduleRunRecord> {
    const start = now();
    const run: ScheduleRunRecord = {
      id: newId("run"),
      scheduleId: schedule.id,
      startedAt: start,
      finishedAt: null,
      status: "running",
      result: "",
      error: "",
    };
    if (schedule.state.running) {
      run.status = "skipped_running";
      run.finishedAt = now();
      await this.store.appendRun(run);
      return run;
    }
    schedule.state.running = true;
    await this.store.saveSchedules(schedules);
    await this.store.appendRun(run);
    try {
      run.result = await this.executor(schedule, run);
      run.status = "succeeded";
      schedule.state.lastStatus = "succeeded";
      schedule.state.lastError = null;
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error);
      run.status = "failed";
      schedule.state.lastStatus = "failed";
      schedule.state.lastError = run.error;
    } finally {
      run.finishedAt = now();
      schedule.state.running = false;
      schedule.state.lastRunAt = start;
      schedule.state.runCount += 1;
      schedule.state.nextRunAt = this.nextRunAt(schedule.cronExpr, schedule.timezone);
      schedule.updatedAt = now();
      await this.store.saveSchedules(schedules);
      await this.store.updateRun(run);
    }
    return run;
  }

  private nextRunAt(cronExpr: string, timezone: string): string {
    return CronExpressionParser.parse(cronExpr, { tz: timezone }).next().toISOString();
  }
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/scheduler.test.ts`

Expected: PASS.

---

### Task 8: Register Built-In Tools

**Files:**
- Create: `src/tools/builtin/scheduler.ts`
- Create: `src/tools/builtin/memory.ts`
- Create: `src/tools/builtin/agent-files.ts`
- Test: `tests/tools-builtin.test.ts`

- [ ] **Step 1: Write failing built-in tool tests**

Create `tests/tools-builtin.test.ts` with tests for:

- `schedule_create` validates cron expression and delegates to `SchedulerService`.
- `schedule_run_now` delegates to `SchedulerService`.
- `memory_create` and `memory_search` delegate to `MemoryStore`.
- `agent_file_update` rejects names outside `user.md`, `soul.md`, `memory.json`.

Run: `bun test tests/tools-builtin.test.ts`

Expected: FAIL because built-in registration modules do not exist.

- [ ] **Step 2: Implement scheduler tool registration**

Register `schedule_create`, `schedule_list`, `schedule_update`, `schedule_delete`, `schedule_set_enabled`, and `schedule_run_now` with Zod schemas. Each handler delegates to `SchedulerService`.

- [ ] **Step 3: Implement memory tool registration**

Register `memory_read`, `memory_create`, `memory_update`, `memory_delete`, and `memory_search`. Each handler delegates to `MemoryStore`.

- [ ] **Step 4: Implement agent file tool registration**

Register `agent_file_read` and `agent_file_update`. Restrict file names to `user.md`, `soul.md`, and `memory.json`.

- [ ] **Step 5: Run built-in tool tests**

Run: `bun test tests/tools-builtin.test.ts`

Expected: PASS.

---

### Task 9: Implement Claude Runner and Prompt Builder

**Files:**
- Create: `src/agent/events.ts`
- Create: `src/agent/prompt.ts`
- Create: `src/agent/runner.ts`
- Test: `tests/agent-runner.test.ts`

- [ ] **Step 1: Write failing runner tests**

Create `tests/agent-runner.test.ts` using mocked SDK message fixtures from `tests/fixtures/sdk-events/`.

Cover:

- text delta normalization
- thinking delta normalization
- tool start normalization
- tool result normalization
- final result normalization
- error normalization
- SDK resume session ID is saved back to session record

Run: `bun test tests/agent-runner.test.ts`

Expected: FAIL because runner modules do not exist.

- [ ] **Step 2: Define normalized events**

Implement event types listed in the design spec.

- [ ] **Step 3: Implement prompt builder**

Read `user.md`, `soul.md`, current time, timezone, workspace, source, and session metadata. Return a system prompt append string.

- [ ] **Step 4: Implement runner around `query()`**

Use SDK `query({ prompt, options })` with:

- `cwd`
- `model`
- `permissionMode`
- `maxTurns`
- `mcpServers: { claudebot: createClaudebotSdkMcpServer(...) }`
- auth env derived from config

- [ ] **Step 5: Normalize events**

Use actual SDK spike output to map SDK messages to normalized events.

- [ ] **Step 6: Test with mocked query adapter**

Do not require live Claude auth for unit tests. Inject a fake query source and assert event normalization.

---

### Task 10: Implement Gateway HTTP and WebSocket

**Files:**
- Create: `src/gateway/protocol.ts`
- Create: `src/gateway/http.ts`
- Create: `src/gateway/websocket.ts`
- Modify: `src/server.ts`
- Test: `tests/gateway.test.ts`

- [ ] **Step 1: Write failing gateway tests**

Create `tests/gateway.test.ts` with mocked runner/services.

Cover:

- `GET /health`
- session create/list/get/update/delete
- `GET /api/sessions/:id/messages`
- `POST /api/sessions/:id/activate` updates last active
- `GET /api/agent/files/:name`
- `PUT /api/agent/files/:name` returns 409 on stale version
- `POST /api/schedules/:id/run-now`
- `GET /api/media/:id`
- WebSocket `chat.user_message` appends user and assistant messages with mocked streaming
- failing schedule delivery appends visible failure message

Run: `bun test tests/gateway.test.ts`

Expected: FAIL because gateway modules do not exist.

- [ ] **Step 2: Implement HTTP endpoints from spec**

Start with:

- `GET /health`
- `GET /webui/bootstrap`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- `PATCH /api/sessions/:id`
- `DELETE /api/sessions/:id`
- `GET /api/sessions/:id/messages`
- `POST /api/sessions/:id/activate`
- `GET /api/agent/files`
- `GET /api/agent/files/:name`
- `PUT /api/agent/files/:name`
- `GET /api/schedules`
- `POST /api/schedules/:id/run-now`
- `GET /api/media/:id`

- [ ] **Step 3: Implement WebSocket envelopes**

Support:

- `session.activate`
- `chat.user_message`
- `chat.cancel`

Emit:

- `message.appended`
- `agent.text_delta`
- `agent.thinking_delta`
- `agent.tool_start`
- `agent.tool_result`
- `agent.turn_done`
- `agent.error`

- [ ] **Step 4: Wire user turns**

On `chat.user_message`:

1. Set last active session.
2. Append user message.
3. Run Claude runner.
4. Stream deltas to socket.
5. Append assistant final message.

- [ ] **Step 5: Wire schedule result delivery**

Scheduler executor:

1. Runs one-off Claude turn.
2. Reads last active session, falling back to `inbox`.
3. Appends result or failure message.
4. Broadcasts to connected clients.

- [ ] **Step 6: Test gateway with mocked runner**

Run: `bun test tests/gateway.test.ts`

Expected: PASS without live Claude auth.

---

### Task 11: Migrate WebUI MVP

**Files:**
- Copy/adapt: `/home/yaotutu/code/nanobot/webui` to `webui`
- Modify: `webui/src/**`
- Test: `tests/webui-smoke.test.ts`

- [ ] **Step 1: Write failing browser smoke test**

Create `tests/webui-smoke.test.ts` using a browser automation library available in the implementation environment. If Playwright is added, install it as a dev dependency.

Cover:

- bootstrap loads
- session create and switch
- mocked streaming message renders
- agent file edit succeeds
- stale agent file save shows conflict
- deferred feature labels/routes for MCP presets, pairing, built-in skills, CLI app attachments, and document parsing are not visible
- schedule result and schedule failure messages render in the active session

Run the focused browser smoke test.

Expected: FAIL before WebUI is migrated.

- [ ] **Step 2: Copy existing WebUI**

Copy the existing React WebUI source, excluding `node_modules`.

- [ ] **Step 3: Remove or hide deferred features**

Hide:

- MCP presets
- pairing
- document parsing controls
- built-in skills browser
- CLI app attachment UI
- multi-channel settings

- [ ] **Step 4: Point API calls at new gateway**

Adjust bootstrap, session, messages, WebSocket, and agent file APIs to match Task 10.

- [ ] **Step 5: Add Agent page**

Provide editors for:

- `user.md`
- `soul.md`
- `memory.json`

Use version returned by GET. On 409, show a reload-required error.

- [ ] **Step 6: Run browser smoke test**

Run the browser smoke test added in Step 1.

Expected: PASS.

- [ ] **Step 7: Build WebUI**

Run: `cd webui && bun install && bun run build`

Expected: build succeeds.

---

### Task 12: End-to-End Verification

**Files:**
- Modify as needed based on failures.

- [ ] **Step 1: Run full tests**

Run: `bun test`

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 3: Start server**

Run: `bun run src/server.ts`

Expected:

- Server listens on configured host/port.
- `/health` returns `{"status":"ok"}`.

- [ ] **Step 4: Manual WebUI smoke test**

Verify:

- WebUI loads.
- New session can be created.
- Message can be sent.
- Streaming response renders.
- Agent files can be edited.
- `schedule_run_now` delivers result to last active session.

---

## Self-Review

- The plan covers the Runtime MVP spec.
- The highest-risk SDK integration is first.
- Storage, sessions, tools, scheduler, runner, gateway, and WebUI are separated.
- Unit tests avoid live Claude auth by mocking runner/query behavior.
- Live SDK behavior is isolated to the spike and manual verification.
- Deferred features are explicitly hidden instead of partially implemented.
