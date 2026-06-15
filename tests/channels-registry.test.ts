import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServices } from "../src/runtime/services.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { runtimePaths } from "../src/config/paths.ts";
import { createChannelRegistry } from "../src/channels/registry.ts";
import type { QueryFactory } from "../src/agent/runner.ts";

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
});
