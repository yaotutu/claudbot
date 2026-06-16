import { describe, expect, test } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAgentRuntimeManager, type AgentRuntimeQueryFactory } from "../src/agent/runtime-manager.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import type { RuntimeConfig } from "../src/config/schema.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

function config(): RuntimeConfig {
  return resolveRuntimeConfig({ home: "/tmp/bot" }, {});
}

function makeManager(queryFactory: AgentRuntimeQueryFactory) {
  return createAgentRuntimeManager({
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
}

async function* respondToInput(input: AsyncIterable<SDKUserMessage>, sessionId: string) {
  let count = 0;
  for await (const _message of input) {
    count += 1;
    const text = count === 1 ? "ok" : "again";
    yield { type: "system", subtype: "init", session_id: sessionId };
    yield { type: "assistant", message: { content: [{ type: "text", text }] }, session_id: sessionId };
    yield { type: "result", session_id: sessionId, result: text, is_error: false };
  }
}

describe("AgentRuntimeManager", () => {
  test("reuses one Query for multiple turns in the same session", async () => {
    let created = 0;
    const queryFactory: AgentRuntimeQueryFactory = async ({ input }) => {
      created += 1;
      return {
        stream: respondToInput(input, "s1"),
        interrupt: async () => undefined,
        close: () => undefined,
      };
    };
    const manager = makeManager(queryFactory);

    const first = await manager.runTurn({ sessionId: "s1", content: "one", resumeSessionId: "s1" });
    const second = await manager.runTurn({ sessionId: "s1", content: "two", resumeSessionId: "s1" });

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
        stream: respondToInput(input, sessionId),
        interrupt: async () => undefined,
        close: () => undefined,
      };
    };
    const manager = makeManager(queryFactory);

    await Promise.all([
      manager.runTurn({ sessionId: "a", content: "one", resumeSessionId: "a" }),
      manager.runTurn({ sessionId: "b", content: "two", resumeSessionId: "b" }),
    ]);

    expect(created).toBe(2);
  });

  test("rejects concurrent turns in the same session", async () => {
    let release: (() => void) | undefined;
    const queryFactory: AgentRuntimeQueryFactory = async ({ input }) => ({
      stream: (async function* () {
        for await (const _message of input) {
          await new Promise<void>((resolve) => { release = resolve; });
          yield { type: "result", session_id: "s1", result: "ok", is_error: false };
        }
      })(),
      interrupt: async () => undefined,
      close: () => undefined,
    });
    const manager = makeManager(queryFactory);

    const first = manager.runTurn({ sessionId: "s1", content: "one", resumeSessionId: "s1" });
    await expect(manager.runTurn({ sessionId: "s1", content: "two", resumeSessionId: "s1" })).rejects.toThrow(/already running/);
    release?.();
    await first;
  });

  test("cancel interrupts only the matching runtime", async () => {
    const interrupted: string[] = [];
    const queryFactory: AgentRuntimeQueryFactory = async ({ input, options }) => {
      const resume = String(options.resume || "draft");
      return {
        stream: respondToInput(input, resume),
        interrupt: async () => { interrupted.push(resume); },
        close: () => undefined,
      };
    };
    const manager = makeManager(queryFactory);
    await manager.runTurn({ sessionId: "a", content: "one", resumeSessionId: "a" });
    await manager.runTurn({ sessionId: "b", content: "two", resumeSessionId: "b" });

    await manager.cancel("b");

    expect(interrupted).toEqual(["b"]);
  });

  test("closeIdle closes idle runtimes", async () => {
    let closed = 0;
    const queryFactory: AgentRuntimeQueryFactory = async ({ input }) => ({
      stream: respondToInput(input, "s1"),
      interrupt: async () => undefined,
      close: () => { closed += 1; },
    });
    const manager = makeManager(queryFactory);
    await manager.runTurn({ sessionId: "s1", content: "one", resumeSessionId: "s1" });

    manager.closeIdle(Date.now() + 21 * 60 * 1000, 20 * 60 * 1000);

    expect(closed).toBe(1);
    expect(manager.activeCount).toBe(0);
  });

  test("remaps a draft runtime to the real SDK session id", async () => {
    const queryFactory: AgentRuntimeQueryFactory = async ({ input }) => ({
      stream: respondToInput(input, "sdk-session-1"),
      interrupt: async () => undefined,
      close: () => undefined,
    });
    const manager = makeManager(queryFactory);
    await manager.runTurn({ sessionId: "draft-1", content: "one" });

    manager.remapSession("draft-1", "sdk-session-1");

    expect(manager.activeCount).toBe(1);
    await manager.runTurn({ sessionId: "sdk-session-1", content: "two", resumeSessionId: "sdk-session-1" });
    expect(manager.activeCount).toBe(1);
  });

  test("streams turn events through onEvent while returning the full turn", async () => {
    const queryFactory: AgentRuntimeQueryFactory = async ({ input }) => ({
      stream: respondToInput(input, "s1"),
      interrupt: async () => undefined,
      close: () => undefined,
    });
    const manager = makeManager(queryFactory);
    const streamed: string[] = [];

    const result = await manager.runTurn({
      sessionId: "s1",
      content: "one",
      resumeSessionId: "s1",
      onEvent: (event) => { streamed.push(event.type); },
    });

    expect(streamed).toContain("text_delta");
    expect(streamed).toContain("turn_done");
    expect(result.events.map((event) => String(event.type))).toEqual(streamed);
  });
});
