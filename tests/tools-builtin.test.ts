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
import { MemoryStore } from "../src/memory/store.ts";
import { AgentProfileStore } from "../src/agent/profile.ts";
import type { ToolContext } from "../src/tools/types.ts";

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

describe("built-in scheduler tools", () => {
  test("schedule_create validates cron and delegates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bis-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "x");
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerSchedulerTools(registry, { storeOps, getTrigger: () => trigger });
    const ctx = makeCtx({});
    const result = await registry.execute("schedule_create", {
      name: "t", cronExpr: "* * * * *", timezone: "UTC", message: "m",
    }, ctx) as { id: string };
    expect(result.id.startsWith("sch_")).toBe(true);
  });

  test("schedule_create rejects bad cron", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bis-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "x");
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerSchedulerTools(registry, { storeOps, getTrigger: () => trigger });
    const ctx = makeCtx({});
    await expect(registry.execute("schedule_create", {
      name: "t", cronExpr: "not a cron", timezone: "UTC", message: "m",
    }, ctx)).rejects.toThrow();
  });

  test("schedule_run_now delegates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bis-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "hello");
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerSchedulerTools(registry, { storeOps, getTrigger: () => trigger });
    const ctx = makeCtx({});
    const created = await storeOps.create({ name: "t", cronExpr: "* * * * *", timezone: "UTC", message: "m" });
    const run = await registry.execute("schedule_run_now", { id: created.id }, ctx) as { status: string; result: string };
    expect(run.status).toBe("succeeded");
    expect(run.result).toBe("hello");
  });
});

describe("built-in memory tools", () => {
  test("memory_create and memory_search delegate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bim-"));
    const memory = new MemoryStore(join(dir, "memory.json"));
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerMemoryTools(registry, { memory });
    const ctx = makeCtx({ memory });
    const created = await registry.execute("memory_create", {
      content: "User prefers Chinese.", tags: ["preference"], source: "test", confidence: 1,
    }, ctx) as { id: string };
    expect(created.id.startsWith("mem_")).toBe(true);
    const found = await registry.execute("memory_search", { query: "Chinese" }, ctx) as { id: string }[];
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(created.id);
  });
});

describe("built-in agent file tools", () => {
  test("agent_file_read and agent_file_update delegate with version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-biaf-"));
    const profile = new AgentProfileStore({
      userFile: join(dir, "user.md"),
      soulFile: join(dir, "soul.md"),
      memoryFile: join(dir, "memory.json"),
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
      memoryFile: join(dir, "memory.json"),
    });
    await profile.init();
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registerAgentFileTools(registry, { profile });
    const ctx = makeCtx({ profile });
    await expect(registry.execute("agent_file_read", { name: "secret.md" }, ctx)).rejects.toThrow();
    await expect(registry.execute("agent_file_update", {
      name: "evil.md", content: "x", expectedVersion: "v",
    }, ctx)).rejects.toThrow();
  });
});
