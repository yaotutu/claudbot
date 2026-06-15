import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerSchedulerTools } from "../src/tools/builtin/scheduler.ts";
import { registerMemoryTools } from "../src/tools/builtin/memory.ts";
import { registerAgentFileTools } from "../src/tools/builtin/agent-files.ts";
import { SchedulerStore } from "../src/scheduler/store.ts";
import { createStoreOps } from "../src/scheduler/store-ops.ts";
import { createSchedulerTrigger } from "../src/scheduler/trigger.ts";
import { AgentProfileStore } from "../src/agent/profile.ts";
import { initMemoryMarkdownStore } from "../src/memory/markdown-store.ts";
import { commitMemoryChanges, initMemoryGitStore } from "../src/memory/git-store.ts";
import type { ToolContext } from "../src/tools/types.ts";

function makeMemoryPaths(dir: string) {
  return {
    userFile: join(dir, "profile", "user.md"),
    soulFile: join(dir, "profile", "soul.md"),
    memoryDir: join(dir, "memory"),
    longTermFile: join(dir, "memory", "MEMORY.md"),
    eventsFile: join(dir, "memory", "memory_events.jsonl"),
    stateFile: join(dir, "memory", "memory_state.json"),
    deprecatedMemoryJsonFile: join(dir, "memory", "memory.json"),
    sessionsDir: join(dir, "sessions"),
  };
}

function makeCtx(services: unknown, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    source: "user_turn",
    home: "/tmp",
    workspacePath: "/tmp/ws",
    timezone: "UTC",
    services,
    ...overrides,
  };
}

describe("built-in cron tool", () => {
  test("cron add (kind=cron) validates and creates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bis-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "x");
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerSchedulerTools(registry, { storeOps, getTrigger: () => trigger });
    const ctx = makeCtx({});
    const result = await registry.execute("cron", {
      action: "add", name: "t", kind: "cron", cronExpr: "* * * * *", timezone: "UTC", message: "m",
    }, ctx) as { id: string; kind: string };
    expect(result.id.startsWith("sch_")).toBe(true);
    expect(result.kind).toBe("cron");
  });

  test("cron add (kind=at) creates one-shot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bis-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "x");
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerSchedulerTools(registry, { storeOps, getTrigger: () => trigger });
    const ctx = makeCtx({});
    const at = new Date(Date.now() + 60_000).toISOString();
    const result = await registry.execute("cron", {
      action: "add", name: "reminder", kind: "at", at, message: "drink water",
    }, ctx) as { id: string; kind: string; deleteAfterRun: boolean };
    expect(result.kind).toBe("at");
    expect(result.deleteAfterRun).toBe(true);
  });

  test("cron add rejects bad cron", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bis-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "x");
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerSchedulerTools(registry, { storeOps, getTrigger: () => trigger });
    const ctx = makeCtx({});
    await expect(registry.execute("cron", {
      action: "add", name: "t", kind: "cron", cronExpr: "not a cron", timezone: "UTC", message: "m",
    }, ctx)).rejects.toThrow();
  });

  test("cron run delegates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bis-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "hello");
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerSchedulerTools(registry, { storeOps, getTrigger: () => trigger });
    const ctx = makeCtx({});
    const created = await storeOps.create({ name: "t", cronExpr: "* * * * *", timezone: "UTC", message: "m" });
    const run = await registry.execute("cron", { action: "run", id: created.id }, ctx) as { status: string; result: string };
    expect(run.status).toBe("succeeded");
    expect(run.result).toBe("hello");
  });

  test("cron list returns all schedules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bis-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "x");
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerSchedulerTools(registry, { storeOps, getTrigger: () => trigger });
    const ctx = makeCtx({});
    await storeOps.create({ name: "a", cronExpr: "* * * * *", timezone: "UTC", message: "1" });
    await storeOps.create({ name: "b", everyMs: 60000, message: "2" });
    const list = await registry.execute("cron", { action: "list" }, ctx) as unknown[];
    expect(list).toHaveLength(2);
  });

  test("cron remove deletes a schedule", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bis-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "x");
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerSchedulerTools(registry, { storeOps, getTrigger: () => trigger });
    const ctx = makeCtx({});
    const created = await storeOps.create({ name: "t", cronExpr: "* * * * *", timezone: "UTC", message: "m" });
    const result = await registry.execute("cron", { action: "remove", id: created.id }, ctx) as { deleted: string };
    expect(result.deleted).toBe(created.id);
    const list = await registry.execute("cron", { action: "list" }, ctx) as unknown[];
    expect(list).toHaveLength(0);
  });
});

describe("built-in memory tools", () => {
  test("markdown memory tools read search and append candidates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bim-"));
    const memoryPaths = makeMemoryPaths(dir);
    await Bun.write(memoryPaths.userFile, "# User\n");
    await Bun.write(memoryPaths.soulFile, "# Soul\n");
    await initMemoryMarkdownStore(memoryPaths);
    await Bun.write(memoryPaths.longTermFile, "# Memory\n\nProject uses Bun runtime.\n");
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerMemoryTools(registry, { memoryPaths });
    const ctx = makeCtx({ memoryPaths }, { sessionId: "sess_1" });

    const read = await registry.execute("memory_read", { path: "memory/MEMORY.md" }, ctx) as { content: string };
    expect(read.content).toContain("Bun runtime");
    const found = await registry.execute("memory_search", { query: "bun" }, ctx) as { path: string }[];
    expect(found.some((hit) => hit.path === "memory/MEMORY.md")).toBe(true);
    await registry.execute("memory_append_note", { content: "User prefers compact plans." }, ctx);
    expect(await Bun.file(memoryPaths.eventsFile).text()).toContain("User prefers compact plans.");
    const dream = await registry.execute("memory_dream", { dryRun: true }, ctx) as { dryRun: boolean; summary: string };
    expect(dream.dryRun).toBe(true);
    await expect(registry.execute("memory_create", { content: "x" }, ctx)).rejects.toThrow("unknown tool");
  });

  test("memory git audit tools expose log diff and revert", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bim-git-"));
    const memoryPaths = makeMemoryPaths(dir);
    await initMemoryMarkdownStore(memoryPaths);
    await initMemoryGitStore(memoryPaths);
    await Bun.write(memoryPaths.longTermFile, "# Memory\n\nTool visible fact.\n");
    const commit = await commitMemoryChanges(memoryPaths, "memory: add tool fact");

    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerMemoryTools(registry, { memoryPaths });
    const ctx = makeCtx({ memoryPaths });
    const log = await registry.execute("memory_log", { limit: 5 }, ctx) as { sha: string }[];
    expect(log[0].sha).toBe(commit.sha);
    const diff = await registry.execute("memory_diff", { sha: commit.sha }, ctx) as { diff: string };
    expect(diff.diff).toContain("Tool visible fact");
  });
});

describe("built-in agent file tools", () => {
  test("agent_file_read and agent_file_update delegate with version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-biaf-"));
    const profile = new AgentProfileStore({
      userFile: join(dir, "user.md"),
      soulFile: join(dir, "soul.md"),
    });
    await profile.init();
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerAgentFileTools(registry, { profile });
    const ctx = makeCtx({ profile });
    const read = await registry.execute("agent_file_read", { name: "user.md" }, ctx) as { content: string; version: string };
    expect(read.version.length).toBeGreaterThan(0);
    const upd = await registry.execute("agent_file_update", {
      name: "user.md", content: "new", expectedVersion: read.version,
    }, ctx) as { version: string };
    expect(upd.version).not.toBe(read.version);
  });

  test("agent_file_update rejects names outside the allow-list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-biaf-"));
    const profile = new AgentProfileStore({
      userFile: join(dir, "user.md"),
      soulFile: join(dir, "soul.md"),
    });
    await profile.init();
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerAgentFileTools(registry, { profile });
    const ctx = makeCtx({ profile });
    await expect(registry.execute("agent_file_read", { name: "secret.md" }, ctx)).rejects.toThrow();
    await expect(registry.execute("agent_file_read", { name: "memory.json" }, ctx)).rejects.toThrow();
    await expect(registry.execute("agent_file_update", {
      name: "evil.md", content: "x", expectedVersion: "v",
    }, ctx)).rejects.toThrow();
  });
});
