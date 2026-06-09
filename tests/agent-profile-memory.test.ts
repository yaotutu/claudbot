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
