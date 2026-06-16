import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServices } from "../src/runtime/services.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { runtimePaths } from "../src/config/paths.ts";
import { createChannelRegistry } from "../src/channels/registry.ts";
import type { QueryFactory } from "../src/agent/runner.ts";
import type { QqClient, QqMessageEvent } from "../src/channels/qq/types.ts";

const emptyQueryFactory: QueryFactory = async function* () {};

describe("channel registry", () => {
  test("delegates enabled telegram webhook routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-registry-"));
    const config = resolveRuntimeConfig({
      home: dir,
      channels: {
        telegram: {
          enabled: true,
          mode: "webhook",
          botToken: "token",
          webhookPath: "/tg",
          secretToken: "secret",
          allowedChatIds: [],
        },
      },
    }, {});
    const paths = runtimePaths(config);
    const services = await buildServices({ config, paths, queryFactory: emptyQueryFactory });
    const sent: Array<{ chatId: string; text: string }> = [];
    const registry = createChannelRegistry(services, {
      telegram: { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); } },
    });

    const res = await registry.handleHttp(
      new Request("http://x/tg", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" },
        body: "{}",
      }),
      new URL("http://x/tg"),
    );

    expect(res?.status).toBe(401);
    expect(sent).toEqual([]);
  });

  test("starts and stops enabled qq adapter without claiming HTTP routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-registry-qq-"));
    const config = resolveRuntimeConfig({
      home: dir,
      channels: {
        qq: {
          enabled: true,
          appId: "qq-app",
          clientSecret: "qq-secret",
        },
      },
    }, {});
    const paths = runtimePaths(config);
    const services = await buildServices({ config, paths, queryFactory: emptyQueryFactory });
    const calls: string[] = [];
    const qq: QqClient = {
      onMessage: (_handler: (event: QqMessageEvent) => void | Promise<void>) => { calls.push("onMessage"); },
      start: async () => { calls.push("start"); },
      stop: async () => { calls.push("stop"); },
      reply: async () => ({ success: true }),
      sendPrivateMessageProactive: async () => ({ success: true }),
      sendGroupMessageProactive: async () => ({ success: true }),
    };
    const registry = createChannelRegistry(services, { qq });

    await registry.start();
    const res = await registry.handleHttp(new Request("http://x/anything"), new URL("http://x/anything"));
    await registry.stop();

    expect(res).toBeNull();
    expect(calls).toEqual(["onMessage", "start", "stop"]);
  });
});
