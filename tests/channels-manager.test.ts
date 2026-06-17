import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkMessage } from "../src/agent/events.ts";
import type { QueryFactory } from "../src/agent/runner.ts";
import type { ChannelAdapter } from "../src/channels/adapter.ts";
import { createChannelManager } from "../src/channels/manager.ts";
import type { ChannelOutboundMessage } from "../src/channels/types.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { runtimePaths } from "../src/config/paths.ts";
import { buildServices } from "../src/runtime/services.ts";

function fixture(name: string): SdkMessage {
  return JSON.parse(readFileSync(`tests/fixtures/sdk-events/${name}.json`, "utf8")) as SdkMessage;
}

function makeRecordingQueryFactory(events: SdkMessage[]): QueryFactory & { calls: Array<{ prompt: string; resumeSessionId?: string }> } {
  const calls: Array<{ prompt: string; resumeSessionId?: string }> = [];
  const factory: QueryFactory = async function* (args) {
    calls.push({ prompt: args.prompt, resumeSessionId: args.resumeSessionId });
    for (const event of events) yield event;
  };
  return Object.assign(factory, { calls });
}

async function makeServices(queryFactory: QueryFactory) {
  const dir = await mkdtemp(join(tmpdir(), "claudebot-channel-manager-"));
  const config = resolveRuntimeConfig({ home: dir }, {});
  const paths = runtimePaths(config);
  const services = await buildServices({ config, paths, queryFactory });
  return { services };
}

function makeAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter & { sent: ChannelOutboundMessage[]; calls: string[] } {
  const sent: ChannelOutboundMessage[] = [];
  const calls: string[] = [];
  return {
    name: "telegram",
    displayName: "Telegram",
    start: async () => { calls.push("start"); },
    stop: async () => { calls.push("stop"); },
    send: async (msg) => { sent.push(msg); },
    sent,
    calls,
    ...overrides,
  };
}

describe("channel manager", () => {
  test("starts, stops, and delegates HTTP routes to adapters", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const adapter = makeAdapter({
      handleHttp: async () => new Response("handled", { status: 202 }),
    });
    const manager = createChannelManager(services, { adapters: [adapter] });

    await manager.start();
    const res = await manager.handleHttp(new Request("http://x/tg"), new URL("http://x/tg"));
    await manager.stop();

    expect(res?.status).toBe(202);
    expect(adapter.calls).toEqual(["start", "stop"]);
  });

  test("dispatches inbound messages through the channel runtime and sends the outbound reply", async () => {
    const factory = makeRecordingQueryFactory([fixture("01-init"), fixture("05-text-assistant"), fixture("07-result-success")]);
    const { services } = await makeServices(factory);
    const adapter = makeAdapter();
    const manager = createChannelManager(services, { adapters: [adapter] });

    const result = await manager.dispatchInbound({
      channel: "telegram",
      chatId: "chat-a",
      senderId: "user-a",
      content: "hello manager",
      media: [],
      metadata: {},
    });

    expect(factory.calls).toEqual([{ prompt: "hello manager", resumeSessionId: undefined }]);
    expect(result.outbound.chatId).toBe("chat-a");
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]).toMatchObject({ channel: "telegram", chatId: "chat-a", isError: false });
  });

  test("retries failed sends with the default retry policy", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    let attempts = 0;
    const sent: ChannelOutboundMessage[] = [];
    const adapter = makeAdapter({
      send: async (msg) => {
        attempts += 1;
        if (attempts < 2) throw new Error("temporary send failure");
        sent.push(msg);
      },
    });
    const manager = createChannelManager(services, { adapters: [adapter], retryDelaysMs: [0, 0, 0] });

    await manager.dispatchOutbound({
      channel: "telegram",
      chatId: "chat-retry",
      content: "retry me",
      isError: false,
      media: [],
      metadata: {},
    });

    expect(attempts).toBe(2);
    expect(sent).toHaveLength(1);
  });
});
