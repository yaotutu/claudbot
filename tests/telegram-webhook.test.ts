import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { buildServices } from "../src/runtime/services.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { runtimePaths } from "../src/config/paths.ts";
import type { QueryFactory } from "../src/agent/runner.ts";
import type { SdkMessage } from "../src/agent/events.ts";
import { createTelegramAdapter } from "../src/channels/telegram/adapter.ts";

function makeRecordingQueryFactory(events: SdkMessage[]): QueryFactory & { calls: Array<{ prompt: string; resumeSessionId?: string }> } {
  const calls: Array<{ prompt: string; resumeSessionId?: string }> = [];
  const factory: QueryFactory = async function* (args) {
    calls.push({ prompt: args.prompt, resumeSessionId: args.resumeSessionId });
    for (const event of events) yield event;
  };
  return Object.assign(factory, { calls });
}

async function makeServices(queryFactory: QueryFactory) {
  const dir = await mkdtemp(join(tmpdir(), "claudebot-telegram-"));
  const config = resolveRuntimeConfig({ home: dir }, {});
  const paths = runtimePaths(config);
  const services = await buildServices({ config, paths, queryFactory });
  return { services };
}

function telegramTextUpdate(chatId: number, text: string) {
  return {
    update_id: 1000,
    message: {
      message_id: 10,
      date: 1,
      chat: { id: chatId, type: "private" },
      from: { id: 99, is_bot: false, first_name: "Ada" },
      text,
    },
  };
}

describe("telegram webhook adapter", () => {
  test("rejects requests with an invalid secret token", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const adapter = createTelegramAdapter(services, {
      enabled: true,
      mode: "webhook",
      botToken: "token",
      webhookPath: "/channels/telegram/webhook",
      secretToken: "expected",
      allowedChatIds: [],
    }, { sendMessage: async () => {} });

    const res = await adapter.handleHttp?.(
      new Request("http://x/channels/telegram/webhook", { method: "POST", body: JSON.stringify(telegramTextUpdate(1, "hi")) }),
      new URL("http://x/channels/telegram/webhook"),
    );

    expect(res?.status).toBe(401);
  });

  test("ignores messages from chats outside the allow-list", async () => {
    const factory = makeRecordingQueryFactory([]);
    const { services } = await makeServices(factory);
    const sent: Array<{ chatId: string; text: string }> = [];
    const adapter = createTelegramAdapter(services, {
      enabled: true,
      mode: "webhook",
      botToken: "token",
      webhookPath: "/channels/telegram/webhook",
      secretToken: "secret",
      allowedChatIds: ["2"],
    }, { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); } });

    const res = await adapter.handleHttp?.(
      new Request("http://x/channels/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
        body: JSON.stringify(telegramTextUpdate(1, "hi")),
      }),
      new URL("http://x/channels/telegram/webhook"),
    );

    expect(res?.status).toBe(200);
    expect(factory.calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("runs text messages through conversation runtime, stores the binding, and replies", async () => {
    const init = JSON.parse(readFileSync("tests/fixtures/sdk-events/01-init.json", "utf8")) as SdkMessage;
    const text = JSON.parse(readFileSync("tests/fixtures/sdk-events/05-text-assistant.json", "utf8")) as SdkMessage;
    const result = JSON.parse(readFileSync("tests/fixtures/sdk-events/07-result-success.json", "utf8")) as SdkMessage;
    const factory = makeRecordingQueryFactory([init, text, result]);
    const { services } = await makeServices(factory);
    const sent: Array<{ chatId: string; text: string }> = [];
    const adapter = createTelegramAdapter(services, {
      enabled: true,
      mode: "webhook",
      botToken: "token",
      webhookPath: "/channels/telegram/webhook",
      secretToken: "secret",
      allowedChatIds: ["123"],
    }, { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); } });

    const res = await adapter.handleHttp?.(
      new Request("http://x/channels/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
        body: JSON.stringify(telegramTextUpdate(123, "ping from telegram")),
      }),
      new URL("http://x/channels/telegram/webhook"),
    );

    expect(res?.status).toBe(200);
    expect(factory.calls).toEqual([{ prompt: "ping from telegram", resumeSessionId: undefined }]);
    const binding = await services.channelBindings.find("telegram", "123");
    expect(binding?.claudebotSessionId).toBeTruthy();
    expect(sent).toEqual([{ chatId: "123", text: expect.any(String) }]);
    expect(sent[0].text.length).toBeGreaterThan(0);
  });
});
