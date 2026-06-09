import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { ClaudeRunner, type QueryFactory } from "../src/agent/runner.ts";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { AgentProfileStore } from "../src/agent/profile.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { registerMemoryTools } from "../src/tools/builtin/memory.ts";
import { MemoryStore } from "../src/memory/store.ts";
import type { NormalizedEvent, SdkMessage } from "../src/agent/events.ts";

const fixtureDir = "tests/fixtures/sdk-events";

function loadFixture(name: string): SdkMessage {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as SdkMessage;
}

function makeQueryFactory(messages: unknown[]): QueryFactory {
  return async function* () {
    for (const m of messages) yield m;
  };
}

async function collectEvents(gen: AsyncGenerator<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("prompt builder", () => {
  test("embeds time, timezone, home, workspace, source, user/soul", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-prompt-"));
    const profile = new AgentProfileStore({
      userFile: join(dir, "user.md"),
      soulFile: join(dir, "soul.md"),
      memoryFile: join(dir, "memory.json"),
    });
    await profile.init();
    const profile2 = new AgentProfileStore({
      userFile: join(dir, "user.md"),
      soulFile: join(dir, "soul.md"),
      memoryFile: join(dir, "memory.json"),
    });
    await Bun.write(join(dir, "user.md"), "I am a software engineer.");
    await Bun.write(join(dir, "soul.md"), "I am a helpful assistant.");

    const prompt = await buildSystemPrompt({
      home: dir,
      workspacePath: join(dir, "ws"),
      timezone: "Asia/Shanghai",
      source: "user_turn",
      sessionId: "sess_1",
      userFile: join(dir, "user.md"),
      soulFile: join(dir, "soul.md"),
      now: new Date("2026-06-09T00:00:00.000Z"),
    });
    expect(prompt).toContain("Asia/Shanghai");
    expect(prompt).toContain("user_turn");
    expect(prompt).toContain("sess_1");
    expect(prompt).toContain("I am a software engineer.");
    expect(prompt).toContain("I am a helpful assistant.");
    expect(prompt).toContain("memory_create");
    expect(prompt).toContain("schedule_create");
  });
});

describe("claude runner normalization", () => {
  const baseDeps = (registry: ToolRegistry) => {
    const config = resolveRuntimeConfig({}, { homeEnv: "/tmp/x", configDir: "/tmp/cfg" });
    return {
      config,
      registry,
      promptInputs: {
        home: "/tmp/x", workspacePath: "/tmp/x/ws", timezone: "UTC",
        source: "user_turn" as const, sessionId: "sess_test",
        userFile: "/tmp/none", soulFile: "/tmp/none",
      },
    };
  };

  test("text assistant -> text_delta", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    const runner = new ClaudeRunner(baseDeps(registry), makeQueryFactory([loadFixture("05-text-assistant.json")]));
    const events = await collectEvents(runner.run({ prompt: "hi" }));
    const text = events.find((e) => e.type === "text_delta");
    expect(text).toBeDefined();
    if (text && text.type === "text_delta") expect(text.text.length).toBeGreaterThan(0);
  });

  test("thinking assistant -> thinking_delta", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    const runner = new ClaudeRunner(baseDeps(registry), makeQueryFactory([loadFixture("02-thinking-assistant.json")]));
    const events = await collectEvents(runner.run({ prompt: "hi" }));
    expect(events.some((e) => e.type === "thinking_delta")).toBe(true);
  });

  test("tool_use -> tool_start", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    const runner = new ClaudeRunner(baseDeps(registry), makeQueryFactory([loadFixture("03-tool-use-assistant.json")]));
    const events = await collectEvents(runner.run({ prompt: "hi" }));
    const toolStart = events.find((e) => e.type === "tool_start");
    expect(toolStart).toBeDefined();
    if (toolStart && toolStart.type === "tool_start") {
      expect(toolStart.name).toMatch(/claudebot_echo/);
    }
  });

  test("tool_result user -> tool_result event with isError=false", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    const runner = new ClaudeRunner(baseDeps(registry), makeQueryFactory([loadFixture("04-tool-result-user.json")]));
    const events = await collectEvents(runner.run({ prompt: "hi" }));
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr).toBeDefined();
    if (tr && tr.type === "tool_result") expect(tr.isError).toBe(false);
  });

  test("result success -> turn_done with session_id", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    const runner = new ClaudeRunner(baseDeps(registry), makeQueryFactory([loadFixture("07-result-success.json")]));
    const events = await collectEvents(runner.run({ prompt: "hi" }));
    const done = events.find((e) => e.type === "turn_done");
    expect(done).toBeDefined();
    if (done && done.type === "turn_done") {
      expect(done.isError).toBe(false);
      expect(done.sessionId).toBeTruthy();
      expect(typeof done.result).toBe("string");
    }
  });

  test("error type -> error event", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    const runner = new ClaudeRunner(baseDeps(registry), makeQueryFactory([
      { type: "error", error: "boom", session_id: "sess_err" },
    ]));
    const events = await collectEvents(runner.run({ prompt: "hi" }));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err && err.type === "error") {
      expect(err.message).toBe("boom");
      expect(err.sessionId).toBe("sess_err");
    }
  });

  test("captured session_id from init is propagated to subsequent events", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    const init = loadFixture("01-init.json");
    const text = loadFixture("05-text-assistant.json");
    const runner = new ClaudeRunner(baseDeps(registry), makeQueryFactory([init, text]));
    const events = await collectEvents(runner.run({ prompt: "hi" }));
    const textEv = events.find((e) => e.type === "text_delta");
    expect(textEv).toBeDefined();
    if (textEv && textEv.type === "text_delta") {
      expect(textEv.sessionId).toBeTruthy();
    }
  });
});
