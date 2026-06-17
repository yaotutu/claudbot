import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryFactory } from "../src/agent/runner.ts";
import type { SdkMessage } from "../src/agent/events.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { runtimePaths } from "../src/config/paths.ts";
import { runChannelTurn } from "../src/channels/runtime.ts";
import { buildServices } from "../src/runtime/services.ts";
import { appendSessionJsonlEntry } from "../src/sessions/jsonl-store.ts";

function makeRecordingQueryFactory(events: SdkMessage[]): QueryFactory & { calls: Array<{ prompt: string; resumeSessionId?: string }> } {
  const calls: Array<{ prompt: string; resumeSessionId?: string }> = [];
  const factory: QueryFactory = async function* (args) {
    calls.push({ prompt: args.prompt, resumeSessionId: args.resumeSessionId });
    for (const event of events) yield event;
  };
  return Object.assign(factory, { calls });
}

function makeQueuedQueryFactory(eventRuns: SdkMessage[][]): QueryFactory & { calls: Array<{ prompt: string; resumeSessionId?: string }> } {
  const calls: Array<{ prompt: string; resumeSessionId?: string }> = [];
  const runs = [...eventRuns];
  const factory: QueryFactory = async function* (args) {
    calls.push({ prompt: args.prompt, resumeSessionId: args.resumeSessionId });
    const events = runs.shift() ?? [];
    for (const event of events) yield event;
  };
  return Object.assign(factory, { calls });
}

async function makeServices(queryFactory: QueryFactory) {
  const dir = await mkdtemp(join(tmpdir(), "claudebot-channel-runtime-"));
  const config = resolveRuntimeConfig({ home: dir }, {});
  const paths = runtimePaths(config);
  const services = await buildServices({ config, paths, queryFactory });
  return { services };
}

function fixture(name: string): SdkMessage {
  return JSON.parse(readFileSync(`tests/fixtures/sdk-events/${name}.json`, "utf8")) as SdkMessage;
}

describe("channel runtime", () => {
  test("creates a channel binding and returns a normalized outbound reply", async () => {
    const factory = makeRecordingQueryFactory([
      fixture("01-init"),
      fixture("05-text-assistant"),
      fixture("07-result-success"),
    ]);
    const { services } = await makeServices(factory);

    const result = await runChannelTurn(services, {
      channel: "telegram",
      chatId: "chat-1",
      senderId: "user-1",
      content: "ping channel runtime",
      media: [],
      metadata: {},
    });

    expect(factory.calls).toEqual([{ prompt: "ping channel runtime", resumeSessionId: undefined }]);
    expect(result.outbound.channel).toBe("telegram");
    expect(result.outbound.chatId).toBe("chat-1");
    expect(result.outbound.isError).toBe(false);
    expect(result.isError).toBe(false);
    expect(typeof result.outbound.content).toBe("string");
    expect(result.outbound.content.length).toBeGreaterThan(0);
    const binding = await services.channelBindings.find("telegram", "telegram:chat-1");
    expect(binding).toMatchObject({ channel: "telegram", externalChatId: "telegram:chat-1", externalUserId: "user-1" });
  });

  test("continues through an existing channel binding", async () => {
    const factory = makeQueuedQueryFactory([
      [fixture("01-init"), fixture("05-text-assistant"), fixture("07-result-success")],
      [fixture("05-text-assistant"), fixture("07-result-success")],
    ]);
    const { services } = await makeServices(factory);

    const first = await runChannelTurn(services, {
      channel: "telegram",
      chatId: "chat-2",
      senderId: "user-2",
      content: "first turn",
      media: [],
      metadata: {},
    });
    if (!first.sessionId) throw new Error("first turn did not create a session");
    await appendSessionJsonlEntry(services.paths.sessionsDir, first.sessionId, {
      type: "user",
      uuid: "seed-user",
      message: { role: "user", content: "first turn" },
    });

    const result = await runChannelTurn(services, {
      channel: "telegram",
      chatId: "chat-2",
      senderId: "user-2",
      content: "resume me",
      media: [],
      metadata: {},
    });

    expect(factory.calls).toEqual([
      { prompt: "first turn", resumeSessionId: undefined },
      { prompt: "resume me", resumeSessionId: undefined },
    ]);
    expect(result.sessionId).toBe(first.sessionId);
    expect(result.outbound.chatId).toBe("chat-2");
  });

  test("uses sessionKey as the binding key while replying to the visible chat", async () => {
    const factory = makeQueuedQueryFactory([
      [fixture("01-init"), fixture("05-text-assistant"), fixture("07-result-success")],
      [fixture("05-text-assistant"), fixture("07-result-success")],
    ]);
    const { services } = await makeServices(factory);

    const first = await runChannelTurn(services, {
      channel: "telegram",
      chatId: "topic-visible",
      senderId: "user-3",
      content: "first topic turn",
      media: [],
      metadata: {},
      sessionKey: "telegram:thread:42",
    });
    if (!first.sessionId) throw new Error("first turn did not create a session");
    await appendSessionJsonlEntry(services.paths.sessionsDir, first.sessionId, {
      type: "user",
      uuid: "seed-topic-user",
      message: { role: "user", content: "first topic turn" },
    });

    const result = await runChannelTurn(services, {
      channel: "telegram",
      chatId: "topic-visible",
      senderId: "user-3",
      content: "resume topic",
      media: [],
      metadata: {},
      sessionKey: "telegram:thread:42",
    });

    expect(factory.calls).toEqual([
      { prompt: "first topic turn", resumeSessionId: undefined },
      { prompt: "resume topic", resumeSessionId: undefined },
    ]);
    expect(result.sessionId).toBe(first.sessionId);
    expect(result.outbound.chatId).toBe("topic-visible");
    const binding = await services.channelBindings.find("telegram", "telegram:thread:42");
    expect(binding).toMatchObject({ externalChatId: "telegram:thread:42", externalUserId: "user-3" });
  });
});
