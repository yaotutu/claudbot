import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChannelSessionBindingStore } from "../src/channels/session-bindings-store.ts";

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), "claudebot-bindings-"));
  return createChannelSessionBindingStore(join(dir, "channel-bindings.json"));
}

describe("channel session binding store", () => {
  test("upserts and finds a binding by channel and external conversation id", async () => {
    const store = await makeStore();

    await store.upsert({
      channel: "telegram",
      externalConversationId: "chat-1",
      externalUserId: "user-1",
      claudebotSessionId: "sess-1",
    });

    expect(await store.find("telegram", "chat-1")).toMatchObject({
      channel: "telegram",
      externalConversationId: "chat-1",
      externalUserId: "user-1",
      claudebotSessionId: "sess-1",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  test("upsert updates an existing binding without changing other channels", async () => {
    const store = await makeStore();

    await store.upsert({ channel: "telegram", externalConversationId: "shared", claudebotSessionId: "tg-old" });
    await store.upsert({ channel: "feishu", externalConversationId: "shared", claudebotSessionId: "fs-session" });
    await store.upsert({ channel: "telegram", externalConversationId: "shared", externalUserId: "user-2", claudebotSessionId: "tg-new" });

    expect(await store.find("telegram", "shared")).toMatchObject({
      channel: "telegram",
      externalConversationId: "shared",
      externalUserId: "user-2",
      claudebotSessionId: "tg-new",
    });
    expect(await store.find("feishu", "shared")).toMatchObject({
      channel: "feishu",
      externalConversationId: "shared",
      claudebotSessionId: "fs-session",
    });
  });
});
