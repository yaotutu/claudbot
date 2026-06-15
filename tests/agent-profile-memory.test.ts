import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentProfileStore } from "../src/agent/profile.ts";
import { appendMemoryEvent, initMemoryMarkdownStore, searchMemoryText } from "../src/memory/markdown-store.ts";
import { applyDreamPatchPlan, runMemoryDream } from "../src/memory/dream.ts";
import { commitMemoryChanges, initMemoryGitStore, listMemoryCommits, showMemoryCommitDiff } from "../src/memory/git-store.ts";
import { detectMemoryIntent } from "../src/memory/intent.ts";
import { appendSessionJsonlEntry } from "../src/sessions/jsonl-store.ts";

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

describe("agent profile and memory", () => {
  test("detects explicit memory intent conservatively", () => {
    expect(detectMemoryIntent("记住：我叫 yaotutu")).toEqual({ type: "explicit", content: "我叫 yaotutu" });
    expect(detectMemoryIntent("请记住我更喜欢中文回复")).toEqual({ type: "explicit", content: "我更喜欢中文回复" });
    expect(detectMemoryIntent("remember: I prefer concise answers")).toEqual({ type: "explicit", content: "I prefer concise answers" });
    expect(detectMemoryIntent("我叫 yaotutu")).toEqual({ type: "none" });
    expect(detectMemoryIntent("记住：明天提醒我开会")).toMatchObject({ type: "blocked", reason: "reminder" });
    expect(detectMemoryIntent("记住：我的 token 是 abc")).toMatchObject({ type: "blocked", reason: "secret" });
  });

  test("initializes user and soul files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-agent-"));
    const store = new AgentProfileStore({
      userFile: join(dir, "user.md"),
      soulFile: join(dir, "soul.md"),
    });
    await store.init();
    expect((await store.readFile("user.md")).content.length).toBeGreaterThan(0);
    expect((await store.readFile("soul.md")).content.length).toBeGreaterThan(0);
  });

  test("rejects stale file version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-agent-"));
    const store = new AgentProfileStore({
      userFile: join(dir, "user.md"),
      soulFile: join(dir, "soul.md"),
    });
    await store.init();
    const first = await store.readFile("user.md");
    await store.updateFile("user.md", "new content", first.version);
    await expect(store.updateFile("user.md", "stale", first.version)).rejects.toThrow("version conflict");
  });

  test("initializes markdown memory layout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-memory-md-"));
    const paths = makeMemoryPaths(dir);

    await initMemoryMarkdownStore(paths);

    expect(await Bun.file(paths.longTermFile).exists()).toBe(true);
    expect(await Bun.file(paths.eventsFile).exists()).toBe(true);
    expect(await readFile(paths.longTermFile, "utf8")).toContain("# Memory");
  });

  test("deletes deprecated memory.json without importing old data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-memory-deprecated-"));
    const paths = makeMemoryPaths(dir);
    await Bun.write(paths.deprecatedMemoryJsonFile, JSON.stringify({
      entries: [{
        id: "mem_1",
        content: "User prefers Chinese.",
        tags: ["preference"],
        source: "test",
        confidence: 1,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      }],
    }));

    await initMemoryMarkdownStore(paths);

    expect(await Bun.file(paths.deprecatedMemoryJsonFile).exists()).toBe(false);
    expect(await readFile(paths.longTermFile, "utf8")).not.toContain("User prefers Chinese.");
    expect(await readFile(paths.eventsFile, "utf8")).toContain("deprecated_memory_json_deleted");
  });

  test("searches long-term memory and memory event records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-memory-search-"));
    const paths = makeMemoryPaths(dir);
    await initMemoryMarkdownStore(paths);
    await Bun.write(paths.longTermFile, "# Memory\n\nProject uses Bun runtime.\n");
    await appendMemoryEvent(paths, {
      type: "candidate",
      sessionId: "sess_1",
      content: "User likes concise plans.",
      createdAt: "2026-06-15T00:00:00.000Z",
    });

    const hits = await searchMemoryText(paths, "bun", { maxResults: 10, scope: "all" });
    expect(hits.some((hit) => hit.path === "memory/MEMORY.md" && hit.snippet.includes("Bun"))).toBe(true);
    const eventHits = await searchMemoryText(paths, "concise", { maxResults: 10, scope: "events" });
    expect(eventHits.some((hit) => hit.path === "memory/memory_events.jsonl")).toBe(true);
  });

  test("applies validated dream patch plan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-memory-dream-"));
    const paths = makeMemoryPaths(dir);
    await initMemoryMarkdownStore(paths);

    const result = await applyDreamPatchPlan(paths, {
      summary: "Add project runtime fact",
      updates: [{
        target: "memory/MEMORY.md",
        operation: "append",
        rationale: "Stable project architecture fact",
        content: "\n## Runtime\n\n- Claudebot uses Bun for the runtime.\n",
      }],
      skipped: [],
    }, { dryRun: false });

    expect(result.applied).toBe(1);
    expect(await Bun.file(paths.longTermFile).text()).toContain("Claudebot uses Bun");
    expect(await Bun.file(paths.eventsFile).text()).toContain("dream_apply");
  });

  test("git audit tracks memory changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-memory-git-"));
    const paths = makeMemoryPaths(dir);
    await initMemoryMarkdownStore(paths);
    const init = await initMemoryGitStore(paths);
    expect(init.available).toBe(true);

    await Bun.write(paths.longTermFile, "# Memory\n\nGit tracked fact.\n");
    const commit = await commitMemoryChanges(paths, "memory: update test fact");
    expect(commit.available).toBe(true);
    expect(commit.sha.length).toBeGreaterThan(6);
    const commits = await listMemoryCommits(paths, 5);
    expect(commits[0].message).toContain("memory: update test fact");
    const diff = await showMemoryCommitDiff(paths, commits[0].sha);
    expect(diff).toContain("Git tracked fact");
  });

  test("memory dream consolidates candidate events into MEMORY.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-memory-dream-candidate-"));
    const paths = makeMemoryPaths(dir);
    await initMemoryMarkdownStore(paths);
    await appendMemoryEvent(paths, {
      type: "candidate",
      id: "cand_1",
      sessionId: "sess_1",
      content: "User prefers concise implementation plans.",
      createdAt: "2026-06-15T00:00:00.000Z",
    });

    const dryRun = await runMemoryDream(paths, { dryRun: true });
    expect(dryRun.applied).toBe(1);
    expect(await Bun.file(paths.longTermFile).text()).not.toContain("User prefers concise implementation plans.");

    const applied = await runMemoryDream(paths, { dryRun: false });
    expect(applied.applied).toBe(1);
    expect(await Bun.file(paths.longTermFile).text()).toContain("User prefers concise implementation plans.");
    expect(await Bun.file(paths.eventsFile).text()).toContain("dream_apply");
  });

  test("memory dream scans session transcripts for explicit memory requests once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-memory-dream-sessions-"));
    const paths = makeMemoryPaths(dir);
    await initMemoryMarkdownStore(paths);
    await appendSessionJsonlEntry(paths.sessionsDir, "sess_1", {
      type: "user",
      uuid: "msg_1",
      timestamp: "2026-06-15T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "请记住：用户更喜欢中文技术说明。" }] },
    });

    const dryRun = await runMemoryDream(paths, { dryRun: true });
    expect(dryRun.applied).toBe(1);
    expect(await Bun.file(paths.longTermFile).text()).not.toContain("用户更喜欢中文技术说明");
    expect(await Bun.file(paths.stateFile).exists()).toBe(false);

    const applied = await runMemoryDream(paths, { dryRun: false });
    expect(applied.applied).toBe(1);
    expect(await Bun.file(paths.longTermFile).text()).toContain("用户更喜欢中文技术说明");
    expect(await Bun.file(paths.stateFile).text()).toContain("sess_1");

    const again = await runMemoryDream(paths, { dryRun: false });
    expect(again.applied).toBe(0);
    const memory = await Bun.file(paths.longTermFile).text();
    expect(memory.match(/用户更喜欢中文技术说明/g)?.length).toBe(1);
  });
});
