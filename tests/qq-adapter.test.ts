import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkMessage } from "../src/agent/events.ts";
import type { QueryFactory } from "../src/agent/runner.ts";
import { createQqAdapter } from "../src/channels/qq/adapter.ts";
import type { QqClient, QqConfig, QqMessageEvent, QqSendResult } from "../src/channels/qq/types.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { runtimePaths } from "../src/config/paths.ts";
import { buildServices } from "../src/runtime/services.ts";
const qqConfig: QqConfig = {
  enabled: true,
  appId: "app",
  clientSecret: "secret",
  sessionDir: "",
  typingKeepAlive: true,
  parseFaceEmoji: true,
  allowedConversationIds: [],
  allowedUserIds: [],
  allowedGroupOpenids: [],
};

const sdkSuccessEvents = () => [fixture("01-init"), fixture("05-text-assistant"), fixture("07-result-success")];

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
  const dir = await mkdtemp(join(tmpdir(), "claudebot-qq-"));
  const config = resolveRuntimeConfig({ home: dir }, {});
  const paths = runtimePaths(config);
  const services = await buildServices({ config, paths, queryFactory });
  return { services };
}

function makeFakeQqClient(replyResult: QqSendResult = { success: true }): QqClient & {
  emitted: QqMessageEvent[];
  replies: Array<{ event: QqMessageEvent; content: string }>;
  proactive: Array<{ target: string; content: string; kind: "private" | "group" }>;
  handler?: (event: QqMessageEvent) => void | Promise<void>;
} {
  const fake = {
    emitted: [] as QqMessageEvent[],
    replies: [] as Array<{ event: QqMessageEvent; content: string }>,
    proactive: [] as Array<{ target: string; content: string; kind: "private" | "group" }>,
    handler: undefined as ((event: QqMessageEvent) => void | Promise<void>) | undefined,
    onMessage(handler: (event: QqMessageEvent) => void | Promise<void>) { fake.handler = handler; },
    async start() {},
    async stop() {},
    async reply(event: QqMessageEvent, content: string) {
      fake.replies.push({ event, content });
      return replyResult;
    },
    async sendPrivateMessageProactive(openid: string, content: string) {
      fake.proactive.push({ target: openid, content, kind: "private" });
      return { success: true };
    },
    async sendGroupMessageProactive(groupOpenid: string, content: string) {
      fake.proactive.push({ target: groupOpenid, content, kind: "group" });
      return { success: true };
    },
  } satisfies QqClient & {
    emitted: QqMessageEvent[];
    replies: Array<{ event: QqMessageEvent; content: string }>;
    proactive: Array<{ target: string; content: string; kind: "private" | "group" }>;
    handler?: (event: QqMessageEvent) => void | Promise<void>;
  };
  return fake;
}

describe("qq adapter", () => {
  test("runs private text messages through channel runtime and replies", async () => {
    const factory = makeRecordingQueryFactory(sdkSuccessEvents());
    const { services } = await makeServices(factory);
    const client = makeFakeQqClient();
    const adapter = createQqAdapter(services, qqConfig, client);
    await adapter.start();

    await client.handler?.({
      type: "c2c",
      senderId: "user-a",
      content: "hello qq",
      messageId: "msg-1",
      timestamp: "now",
    });

    expect(factory.calls).toEqual([{ prompt: "hello qq", resumeSessionId: undefined }]);
    expect(client.replies.length).toBe(1);
    expect(client.proactive).toEqual([]);
    const binding = await services.channelBindings.find("qq", "c2c:user-a");
    expect(binding?.externalUserId).toBe("user-a");
  });

  test("ignores messages outside allow-lists", async () => {
    const factory = makeRecordingQueryFactory([]);
    const { services } = await makeServices(factory);
    const client = makeFakeQqClient();
    const adapter = createQqAdapter(services, { ...qqConfig, allowedConversationIds: ["c2c:allowed"] }, client);
    await adapter.start();

    await client.handler?.({
      type: "c2c",
      senderId: "blocked",
      content: "nope",
      messageId: "msg-2",
      timestamp: "now",
    });

    expect(factory.calls).toEqual([]);
    expect(client.replies).toEqual([]);
  });

  test("falls back to proactive group send when passive reply fails", async () => {
    const factory = makeRecordingQueryFactory(sdkSuccessEvents());
    const { services } = await makeServices(factory);
    const client = makeFakeQqClient({ success: false, error: "reply window expired" });
    const adapter = createQqAdapter(services, qqConfig, client);
    await adapter.start();

    await client.handler?.({
      type: "group",
      senderId: "member-a",
      groupOpenid: "group-a",
      content: "hello group",
      messageId: "msg-3",
      timestamp: "now",
    });

    expect(client.replies.length).toBe(1);
    expect(client.proactive).toEqual([{ target: "group-a", content: client.replies[0].content, kind: "group" }]);
    const binding = await services.channelBindings.find("qq", "group:group-a");
    expect(binding?.externalUserId).toBe("member-a");
  });
});
