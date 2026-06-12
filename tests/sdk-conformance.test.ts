import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkJsonlSessionStore } from "../src/sessions/sdk-jsonl-store.ts";

// Structural copies of SDK types — kept here to avoid coupling to internal
// type evolution. Must match @anthropic-ai/claude-agent-sdk shape.
type SessionKey = { projectKey: string; sessionId: string; subpath?: string };
type SessionStoreEntry = { type: string; uuid?: string; timestamp?: string; [k: string]: unknown };
type SessionStore = {
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
  listSessions?(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
  delete?(key: SessionKey): Promise<void>;
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
};

function runConformance(factory: () => Promise<SessionStore>) {
  test("1. append + load round-trip preserves entries and order", async () => {
    const s = await factory();
    const key = { projectKey: "p", sessionId: "s1" };
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00Z" },
      { type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:01Z" },
    ];
    await s.append(key, entries);
    const loaded = await s.load(key);
    expect(loaded).toEqual(entries);
  });

  test("2. load returns null for unknown key", async () => {
    const s = await factory();
    expect(await s.load({ projectKey: "p", sessionId: "missing" })).toBeNull();
  });

  test("3. multiple appends preserve call order", async () => {
    const s = await factory();
    const key = { projectKey: "p", sessionId: "s1" };
    await s.append(key, [{ type: "user", uuid: "u1" }]);
    await s.append(key, [{ type: "user", uuid: "u2" }]);
    await s.append(key, [{ type: "user", uuid: "u3" }]);
    const loaded = await s.load(key);
    expect(loaded?.map((e) => e.uuid)).toEqual(["u1", "u2", "u3"]);
  });

  test("4. appending an empty array is a no-op", async () => {
    const s = await factory();
    const key = { projectKey: "p", sessionId: "s1" };
    await s.append(key, []);
    expect(await s.load(key)).toBeNull();
  });

  test("5. subpath keys are isolated from the main key", async () => {
    const s = await factory();
    await s.append({ projectKey: "p", sessionId: "s1" }, [{ type: "user", uuid: "main" }]);
    await s.append({ projectKey: "p", sessionId: "s1", subpath: "subagents/agent-x" }, [{ type: "user", uuid: "sub" }]);
    const main = await s.load({ projectKey: "p", sessionId: "s1" });
    const sub = await s.load({ projectKey: "p", sessionId: "s1", subpath: "subagents/agent-x" });
    expect(main?.map((e) => e.uuid)).toEqual(["main"]);
    expect(sub?.map((e) => e.uuid)).toEqual(["sub"]);
  });

  test("6. claudebot uses a single projectKey; cross-project writes to same sessionId land in the same file (append, not overwrite)", async () => {
    const s = await factory();
    await s.append({ projectKey: "p1", sessionId: "s" }, [{ type: "user", uuid: "p1u" }]);
    await s.append({ projectKey: "p2", sessionId: "s" }, [{ type: "user", uuid: "p2u" }]);
    const a = await s.load({ projectKey: "p1", sessionId: "s" });
    const b = await s.load({ projectKey: "p2", sessionId: "s" });
    // pathFor() ignores projectKey, so both appends write to
    // <sessionsDir>/s/main.jsonl and both loads read it back.
    expect(a?.map((e) => e.uuid)).toEqual(["p1u", "p2u"]);
    expect(b?.map((e) => e.uuid)).toEqual(["p1u", "p2u"]);
  });

  test("7. listSessions returns session IDs per project with valid mtime", async () => {
    const s = await factory();
    if (!s.listSessions) return;
    await s.append({ projectKey: "p", sessionId: "s-a" }, [{ type: "user", uuid: "u" }]);
    await s.append({ projectKey: "p", sessionId: "s-b" }, [{ type: "user", uuid: "u" }]);
    const list = await s.listSessions("p");
    expect(list.map((x) => x.sessionId).sort()).toEqual(["s-a", "s-b"]);
    for (const entry of list) {
      expect(typeof entry.mtime).toBe("number");
      expect(entry.mtime).toBeGreaterThan(0);
    }
  });

  test("8. listSessions excludes subagent subpaths", async () => {
    const s = await factory();
    if (!s.listSessions) return;
    await s.append({ projectKey: "p", sessionId: "s" }, [{ type: "user", uuid: "u" }]);
    await s.append({ projectKey: "p", sessionId: "s", subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    const list = await s.listSessions("p");
    expect(list.map((x) => x.sessionId)).toEqual(["s"]);
  });

  test("9. deleting the main key returns null on subsequent load", async () => {
    const s = await factory();
    if (!s.delete) return;
    const key = { projectKey: "p", sessionId: "s" };
    await s.append(key, [{ type: "user", uuid: "u" }]);
    await s.delete(key);
    expect(await s.load(key)).toBeNull();
  });

  test("10. deleting the main key cascades to subkeys but not other sessions in the same project", async () => {
    const s = await factory();
    if (!s.delete) return;
    // Use distinct projectKeys to verify cross-project isolation is NOT
    // enforced by claudebot (single projectKey assumed).
    await s.append({ projectKey: "p", sessionId: "s1" }, [{ type: "user", uuid: "u" }]);
    await s.append({ projectKey: "p", sessionId: "s1", subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    await s.append({ projectKey: "p", sessionId: "s2" }, [{ type: "user", uuid: "u" }]);
    await s.delete({ projectKey: "p", sessionId: "s1" });
    expect(await s.load({ projectKey: "p", sessionId: "s1" })).toBeNull();
    expect(await s.load({ projectKey: "p", sessionId: "s1", subpath: "subagents/agent-x" })).toBeNull();
    expect(await s.load({ projectKey: "p", sessionId: "s2" })).not.toBeNull();
  });

  test("11. deleting a subpath removes only that subkey", async () => {
    const s = await factory();
    if (!s.delete) return;
    const base = { projectKey: "p", sessionId: "s" };
    await s.append(base, [{ type: "user", uuid: "main" }]);
    await s.append({ ...base, subpath: "subagents/agent-x" }, [{ type: "user", uuid: "x" }]);
    await s.append({ ...base, subpath: "subagents/agent-y" }, [{ type: "user", uuid: "y" }]);
    await s.delete({ ...base, subpath: "subagents/agent-x" });
    expect(await s.load(base)).not.toBeNull();
    expect(await s.load({ ...base, subpath: "subagents/agent-x" })).toBeNull();
    expect(await s.load({ ...base, subpath: "subagents/agent-y" })).not.toBeNull();
  });

  test("12. listSubkeys returns subpaths scoped to the session", async () => {
    const s = await factory();
    if (!s.listSubkeys) return;
    const base = { projectKey: "p", sessionId: "s" };
    await s.append(base, [{ type: "user", uuid: "u" }]);
    await s.append({ ...base, subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    await s.append({ ...base, subpath: "subagents/agent-y" }, [{ type: "user", uuid: "u" }]);
    const subs = (await s.listSubkeys(base)).sort();
    expect(subs).toEqual(["subagents/agent-x", "subagents/agent-y"]);
  });

  test("13. listSubkeys excludes the main transcript and returns [] for unknown sessions", async () => {
    const s = await factory();
    if (!s.listSubkeys) return;
    const base = { projectKey: "p", sessionId: "s" };
    await s.append(base, [{ type: "user", uuid: "u" }]);
    await s.append({ ...base, subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    const subs = await s.listSubkeys(base);
    expect(subs).not.toContain("main");
    expect(subs).toEqual(["subagents/agent-x"]);
    expect(await s.listSubkeys({ projectKey: "p", sessionId: "nope" })).toEqual([]);
  });
}

describe("SdkJsonlSessionStore conformance", () => {
  runConformance(async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudebot-conform-"));
    return createSdkJsonlSessionStore({ sessionsDir: dir });
  });
});
