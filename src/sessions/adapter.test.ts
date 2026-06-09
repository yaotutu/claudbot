import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudebotSessionStore } from "./adapter.ts";

describe("ClaudebotSessionStore append + load", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudebot-store-"));
  });

  test("append + load round-trips entries in order", async () => {
    const store = createClaudebotSessionStore({ sessionsDir: dir });
    const key = { projectKey: "claudebot", sessionId: "sess-1" };
    const entries = [
      { type: "user", uuid: "u1", timestamp: "2026-06-09T10:00:00Z", message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "a1", timestamp: "2026-06-09T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ];
    await store.append(key, entries);
    const loaded = await store.load(key);
    expect(loaded).toEqual(entries);
  });

  test("load returns null for unknown key", async () => {
    const store = createClaudebotSessionStore({ sessionsDir: dir });
    const loaded = await store.load({ projectKey: "claudebot", sessionId: "nope" });
    expect(loaded).toBeNull();
  });
});
