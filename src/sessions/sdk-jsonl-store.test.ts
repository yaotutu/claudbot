import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSdkJsonlSessionStore } from "./sdk-jsonl-store.ts";

describe("SdkJsonlSessionStore append + load", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudebot-store-"));
  });

  test("append + load round-trips entries in order", async () => {
    const store = createSdkJsonlSessionStore({ sessionsDir: dir });
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
    const store = createSdkJsonlSessionStore({ sessionsDir: dir });
    const loaded = await store.load({ projectKey: "claudebot", sessionId: "nope" });
    expect(loaded).toBeNull();
  });
});

describe("SdkJsonlSessionStore listSessions", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudebot-store-"));
  });

  test("listSessions returns session IDs with valid mtime, sorted by recency", async () => {
    const store = createSdkJsonlSessionStore({ sessionsDir: dir });
    await store.append({ projectKey: "claudebot", sessionId: "s-a" }, [{ type: "user", uuid: "u" }]);
    await new Promise((r) => setTimeout(r, 5));
    await store.append({ projectKey: "claudebot", sessionId: "s-b" }, [{ type: "user", uuid: "u" }]);

    const list = await store.listSessions!("claudebot");
    const ids = list.map((s) => s.sessionId);
    expect(ids.sort()).toEqual(["s-a", "s-b"]);
    for (const entry of list) {
      expect(typeof entry.mtime).toBe("number");
      expect(entry.mtime).toBeGreaterThan(0);
    }
  });

  test("listSessions excludes subagent subpaths", async () => {
    const store = createSdkJsonlSessionStore({ sessionsDir: dir });
    await store.append({ projectKey: "p1", sessionId: "s1" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    const list = await store.listSessions!("p1");
    expect(list.map((s) => s.sessionId)).toEqual(["s1"]);
  });
});

describe("SdkJsonlSessionStore delete", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudebot-store-"));
  });

  test("deleting the main key cascades to subkeys but not other sessions", async () => {
    const store = createSdkJsonlSessionStore({ sessionsDir: dir });
    await store.append({ projectKey: "p1", sessionId: "s1" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s2" }, [{ type: "user", uuid: "u" }]);

    await store.delete!({ projectKey: "p1", sessionId: "s1" });

    expect(await store.load({ projectKey: "p1", sessionId: "s1" })).toBeNull();
    expect(await store.load({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" })).toBeNull();
    expect(await store.load({ projectKey: "p1", sessionId: "s2" })).not.toBeNull();
  });

  test("deleting a subpath removes only that subkey", async () => {
    const store = createSdkJsonlSessionStore({ sessionsDir: dir });
    await store.append({ projectKey: "p1", sessionId: "s1" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-y" }, [{ type: "user", uuid: "u" }]);

    await store.delete!({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" });

    expect(await store.load({ projectKey: "p1", sessionId: "s1" })).not.toBeNull();
    expect(await store.load({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" })).toBeNull();
    expect(await store.load({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-y" })).not.toBeNull();
  });
});

describe("SdkJsonlSessionStore listSubkeys", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudebot-store-"));
  });

  test("listSubkeys returns subpaths scoped to the session", async () => {
    const store = createSdkJsonlSessionStore({ sessionsDir: dir });
    await store.append({ projectKey: "p1", sessionId: "s1" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-y" }, [{ type: "user", uuid: "u" }]);

    const subs = (await store.listSubkeys!({ projectKey: "p1", sessionId: "s1" })).sort();
    expect(subs).toEqual(["subagents/agent-x", "subagents/agent-y"]);
  });

  test("listSubkeys returns [] for an unknown session", async () => {
    const store = createSdkJsonlSessionStore({ sessionsDir: dir });
    const subs = await store.listSubkeys!({ projectKey: "p1", sessionId: "nope" });
    expect(subs).toEqual([]);
  });
});
