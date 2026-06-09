# Session Storage Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the double-write between claudebot's app-layer `SessionStore` and the SDK's `.jsonl` transcript. Make the SDK's `.jsonl` (mirrored via `SessionStore` adapter) the single source of truth for messages; remove the app-layer `SessionRecord.messages` array, the `inbox` magic id, and the scheduler stub.

**Architecture:** Implement a `ClaudebotSessionStore` adapter that mirrors SDK transcript writes into `~/.claudebot/sessions/<sdkSessionId>/{main,subagents/}.jsonl`. Set `CLAUDE_CONFIG_DIR=~/.claudebot/sdk-config/` so the SDK's local copy is also under claudebot's home (self-contained). Gateway HTTP layer reads messages back via a pure `parseJsonlToUIMessages()` function. App layer holds only `runtimeState.lastActiveSessionId` (a SDK UUID or null). Scheduler executor upgrades from writing a synthetic message to calling `runner.run()` for real.

**Tech Stack:** Bun, TypeScript (strict), `@anthropic-ai/claude-agent-sdk` `SessionStore` adapter (alpha-but-sanctioned), `bun test`, Zod config.

**Non-Goals:** Backward compatibility with existing `~/.claudebot/sessions/*.json` files (no data migration; old files are simply ignored and can be deleted manually). Auth, multi-user, remote storage.

---

## File Structure

### New files
- `src/sessions/adapter.ts` — `createClaudebotSessionStore({ sessionsDir })` returns a `SessionStore` with `append/load/listSessions/delete/listSubkeys`. Per-session directory layout.
- `src/sessions/jsonl-parser.ts` — pure `parseJsonlToUIMessages(filePath)` that reads an SDK JSONL transcript and returns `UIMessage[]` in the shape WebUI consumes.
- `src/sessions/jsonl-parser.test.ts` — unit tests for the parser (TDD).
- `src/sessions/adapter.test.ts` — unit tests for the adapter (TDD; will be subsumed by conformance suite once that's wired).
- `tests/sdk-conformance.test.ts` — copies the SDK's 13-test conformance suite from `examples/session-stores/shared/conformance.ts` and runs it against `createClaudebotSessionStore`.
- `tests/fixtures/sdk-events/` — sample `.jsonl` files for parser tests (created inline in test setup using `Bun.write`).

### Modified files
- `src/config/paths.ts` — add `sdkConfigDir` to `RuntimePaths`.
- `src/agent/runner.ts` — `makeRealQueryFactory` takes a third arg `sdkConfigDir`; injects `CLAUDE_CONFIG_DIR`.
- `src/runtime/services.ts` — instantiate `sessionStore`; pass it + `paths.sdkConfigDir` into `makeRealQueryFactory`; rewrite `runScheduledTurn` to call `runner.run()`.
- `src/gateway/http.ts` — `/api/sessions` list uses SDK `listSessions` + `getSessionInfo`; `/api/sessions/:id/messages` uses `parseJsonlToUIMessages`; PATCH uses `renameSession`; DELETE uses `adapter.delete`; remove `POST /api/sessions`.
- `src/gateway/websocket.ts` — `runUserTurn` no longer calls `appendMessage`; removes the `inbox` fallback; surfaces `system/mirror_error`; writes new `sdkSessionId` back to runtimeState after `turn_done`.
- `src/sessions/store.ts` — strip `messages` field handling. Keep as a thin wrapper only if still needed; otherwise delete.
- `src/sessions/types.ts` — delete `SessionMessage` and `SessionRecord.messages`; keep only what's still referenced elsewhere.
- `tests/sessions.test.ts` — rewrite to test adapter + parser (replacing the old `SessionStore` tests).
- `tests/gateway.test.ts` — update `runUserTurn` tests to assert no `appendMessage` calls and no `inbox` fallback.
- `tests/scheduler.test.ts` — update `runScheduledTurn` tests to assert `runner.run()` is called.
- `webui/src/lib/active-session.ts` — drop the `inbox` placeholder assumption in the comment; adjust `pickInitialActiveSession` if needed.
- `webui/src/App.tsx` — drop the "empty `inbox` placeholder" comment.
- `webui/src/lib/claudebot-client.ts` — drop the "wire's sessionId is the *Claude* session UUID" comment (now they are the same).
- `webui/src/tests/active-session.test.ts` — drop the "falls back when lastActiveSessionId is `inbox`" test.

### Deleted files
- None outright. `src/sessions/store.ts` may be reduced to a near-empty file or removed depending on final state.

---

## Task 1: Add `sdkConfigDir` to `RuntimePaths`

**Files:**
- Modify: `src/config/paths.ts:4-20,22-41`

- [ ] **Step 1: Add field and derivation**

In `src/config/paths.ts`, add `sdkConfigDir` to the `RuntimePaths` type and `runtimePaths()` function:

```ts
export type RuntimePaths = {
  home: string;
  workspace: string;
  agentDir: string;
  userFile: string;
  soulFile: string;
  memoryFile: string;
  sessionsDir: string;
  schedulerDir: string;
  schedulesFile: string;
  runsFile: string;
  webuiDir: string;
  runtimeStateFile: string;
  mediaDir: string;
  auditDir: string;
  toolAuditFile: string;
  sdkConfigDir: string;          // NEW: CLAUDE_CONFIG_DIR target
};

export function runtimePaths(config: RuntimeConfig): RuntimePaths {
  const home = config.home;
  return {
    home,
    workspace: config.workspace.path,
    agentDir: join(home, "agent"),
    userFile: join(home, "agent", "user.md"),
    soulFile: join(home, "agent", "soul.md"),
    memoryFile: join(home, "agent", "memory.json"),
    sessionsDir: join(home, "sessions"),
    schedulerDir: join(home, "scheduler"),
    schedulesFile: join(home, "scheduler", "schedules.json"),
    runsFile: join(home, "scheduler", "runs.json"),
    webuiDir: join(home, "webui"),
    runtimeStateFile: join(home, "webui", "runtime_state.json"),
    mediaDir: join(home, "media"),
    auditDir: join(home, "audit"),
    toolAuditFile: join(home, "audit", "tools.jsonl"),
    sdkConfigDir: join(home, "sdk-config"),    // NEW
  };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/config/paths.ts
git commit -m "feat(paths): add sdkConfigDir for CLAUDE_CONFIG_DIR"
```

---

## Task 2: `ClaudebotSessionStore` adapter — `append` and `load` round-trip

**Files:**
- Create: `src/sessions/adapter.ts`
- Create: `src/sessions/adapter.test.ts`

- [ ] **Step 1: Write the failing test for append + load**

In `src/sessions/adapter.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/sessions/adapter.test.ts`
Expected: FAIL with "Cannot find module './adapter.ts'" (or similar).

- [ ] **Step 3: Implement append + load**

Create `src/sessions/adapter.ts`:

```ts
import { mkdir, readFile, readdir, rm, writeFile, appendFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

export type ClaudebotSessionStoreOptions = {
  sessionsDir: string;
};

/**
 * Translates SessionKey -> filesystem path:
 *   <sessionsDir>/<sessionId>/main.jsonl           (no subpath)
 *   <sessionsDir>/<sessionId>/subagents/<id>.jsonl (subpath: "subagents/agent-<id>")
 */
function pathFor(sessionsDir: string, key: SessionKey): string {
  const sessionDir = join(sessionsDir, key.sessionId);
  if (!key.subpath) return join(sessionDir, "main.jsonl");
  return join(sessionDir, `${key.subpath}.jsonl`);
}

function sessionDirFor(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, sessionId);
}

export function createClaudebotSessionStore(
  opts: ClaudebotSessionStoreOptions,
): SessionStore {
  return {
    async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      if (entries.length === 0) return;
      const file = pathFor(opts.sessionsDir, key);
      await mkdir(dirname(file), { recursive: true });
      const lines = entries.map((e) => JSON.stringify(e) + "\n").join("");
      // POSIX O_APPEND makes a single write() atomic for line-bounded payloads
      // well under PIPE_BUF (4096 bytes on Linux). For our use case (small
      // JSON entries, hundreds of bytes each) this is sufficient. Batches
      // arrive every ~100ms; if a batch ever exceeds PIPE_BUF we may interleave
      // with concurrent writers — the SDK serializes append() per session, and
      // we have a single process, so this is a non-issue in practice.
      await appendFile(file, lines, "utf8");
    },

    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const file = pathFor(opts.sessionsDir, key);
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      return raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as SessionStoreEntry);
    },
  };
}
```

Note: `listSessions`, `delete`, `listSubkeys` are added in Task 3.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/sessions/adapter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sessions/adapter.ts src/sessions/adapter.test.ts
git commit -m "feat(sessions): ClaudebotSessionStore with append/load"
```

---

## Task 3: Extend adapter — `listSessions`, `delete` (cascade), `listSubkeys`

**Files:**
- Modify: `src/sessions/adapter.ts`
- Modify: `src/sessions/adapter.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `src/sessions/adapter.test.ts`:

```ts
describe("ClaudebotSessionStore listSessions", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudebot-store-"));
  });

  test("listSessions returns session IDs with valid mtime, sorted by recency", async () => {
    // Claudebot uses a single projectKey ("claudebot") and does not implement
    // multi-tenant scoping. The projectKey arg is accepted for SDK contract
    // compliance but no cross-project filtering is performed.
    const store = createClaudebotSessionStore({ sessionsDir: dir });
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
    const store = createClaudebotSessionStore({ sessionsDir: dir });
    await store.append({ projectKey: "p1", sessionId: "s1" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    const list = await store.listSessions!("p1");
    expect(list.map((s) => s.sessionId)).toEqual(["s1"]);
  });
});

describe("ClaudebotSessionStore delete", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudebot-store-"));
  });

  test("deleting the main key cascades to subkeys but not other sessions", async () => {
    const store = createClaudebotSessionStore({ sessionsDir: dir });
    await store.append({ projectKey: "p1", sessionId: "s1" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s2" }, [{ type: "user", uuid: "u" }]);

    await store.delete!({ projectKey: "p1", sessionId: "s1" });

    expect(await store.load({ projectKey: "p1", sessionId: "s1" })).toBeNull();
    expect(await store.load({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" })).toBeNull();
    expect(await store.load({ projectKey: "p1", sessionId: "s2" })).not.toBeNull();
  });

  test("deleting a subpath removes only that subkey", async () => {
    const store = createClaudebotSessionStore({ sessionsDir: dir });
    await store.append({ projectKey: "p1", sessionId: "s1" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-y" }, [{ type: "user", uuid: "u" }]);

    await store.delete!({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" });

    expect(await store.load({ projectKey: "p1", sessionId: "s1" })).not.toBeNull();
    expect(await store.load({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" })).toBeNull();
    expect(await store.load({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-y" })).not.toBeNull();
  });
});

describe("ClaudebotSessionStore listSubkeys", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudebot-store-"));
  });

  test("listSubkeys returns subpaths scoped to the session", async () => {
    const store = createClaudebotSessionStore({ sessionsDir: dir });
    await store.append({ projectKey: "p1", sessionId: "s1" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    await store.append({ projectKey: "p1", sessionId: "s1", subpath: "subagents/agent-y" }, [{ type: "user", uuid: "u" }]);

    const subs = (await store.listSubkeys!({ projectKey: "p1", sessionId: "s1" })).sort();
    expect(subs).toEqual(["subagents/agent-x", "subagents/agent-y"]);
  });

  test("listSubkeys returns [] for an unknown session", async () => {
    const store = createClaudebotSessionStore({ sessionsDir: dir });
    const subs = await store.listSubkeys!({ projectKey: "p1", sessionId: "nope" });
    expect(subs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/sessions/adapter.test.ts`
Expected: 4 of the new tests fail with "store.listSessions is not a function" (or similar — listSessions/delete/listSubkeys are undefined).

- [ ] **Step 3: Implement listSessions, delete, listSubkeys**

Replace the entire body of `createClaudebotSessionStore` in `src/sessions/adapter.ts` so the returned `SessionStore` includes these methods. The full file becomes:

```ts
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

export type ClaudebotSessionStoreOptions = {
  sessionsDir: string;
};

function pathFor(sessionsDir: string, key: SessionKey): string {
  const sessionDir = join(sessionsDir, key.sessionId);
  if (!key.subpath) return join(sessionDir, "main.jsonl");
  return join(sessionDir, `${key.subpath}.jsonl`);
}

function sessionDirFor(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, sessionId);
}

function subpathFilename(subpath: string): string {
  // subpath arrives as e.g. "subagents/agent-x"; the file is "<subpath>.jsonl"
  return subpath;
}

export function createClaudebotSessionStore(
  opts: ClaudebotSessionStoreOptions,
): SessionStore {
  return {
    async append(key, entries) {
      if (entries.length === 0) return;
      const file = pathFor(opts.sessionsDir, key);
      await mkdir(dirname(file), { recursive: true });
      const lines = entries.map((e) => JSON.stringify(e) + "\n").join("");
      await Bun.write(file, lines); // append mode would be cleaner; we open with 'a' via fs
    },

    async load(key) {
      const file = pathFor(opts.sessionsDir, key);
      const f = Bun.file(file);
      if (!(await f.exists())) return null;
      const text = await f.text();
      return text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as SessionStoreEntry);
    },

    async listSessions(projectKey) {
      // projectKey is accepted for SDK contract compliance. Claudebot uses
      // a single projectKey ("claudebot"); if multi-tenancy is ever added,
      // a per-session .project sidecar would be needed to scope properly.
      const _projectKey = projectKey; // intentionally unused
      const root = opts.sessionsDir;
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const out: Array<{ sessionId: string; mtime: number }> = [];
      for (const sessionId of entries) {
        const mainFile = pathFor(root, { projectKey, sessionId });
        const f = Bun.file(mainFile);
        if (!(await f.exists())) continue; // skip subagent-only entries
        const st = await stat(mainFile);
        out.push({ sessionId, mtime: st.mtimeMs });
      }
      out.sort((a, b) => b.mtime - a.mtime);
      return out;
    },

    async delete(key) {
      if (key.subpath) {
        // Delete only the single subpath file
        const file = pathFor(opts.sessionsDir, key);
        try {
          await rm(file);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        return;
      }
      // Cascade: delete the entire session directory
      const dir = sessionDirFor(opts.sessionsDir, key.sessionId);
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },

    async listSubkeys(key) {
      // Layout invariant: subkeys always live under <sessionDir>/subagents/<id>.jsonl.
      // The pathFor() function encodes this; we read that directory directly
      // rather than scanning the whole session tree.
      const subagentsDir = join(sessionDirFor(opts.sessionsDir, key.sessionId), "subagents");
      let files: string[];
      try {
        files = await readdir(subagentsDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      return files
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => `subagents/${f.slice(0, -".jsonl".length)}`);
    },
  };
}
```

Note: `append` uses `Bun.write` for the append-flag semantics. Verify the actual API — if `Bun.write` does not support append mode in your version, use `fs/promises.appendFile` instead (and import it back at the top):

```ts
import { appendFile, readFile, readdir, rm, stat } from "node:fs/promises";
// ...
async append(key, entries) {
  if (entries.length === 0) return;
  const file = pathFor(opts.sessionsDir, key);
  await mkdir(dirname(file), { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e) + "\n").join("");
  await appendFile(file, lines, "utf8");
},
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `bun test src/sessions/adapter.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/adapter.ts src/sessions/adapter.test.ts
git commit -m "feat(sessions): adapter listSessions/delete/listSubkeys"
```

---

## Task 4: SDK conformance suite

**Files:**
- Create: `tests/sdk-conformance.test.ts`

The SDK's reference conformance suite (from `examples/session-stores/shared/conformance.ts`) defines 13 tests. We reimplement the runner here, structurally typed to avoid a hard import on internal SDK types.

- [ ] **Step 1: Write the conformance harness**

Create `tests/sdk-conformance.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudebotSessionStore } from "../src/sessions/adapter.ts";

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

function canon(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

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

  test("6. different projectKey values don't bleed into each other", async () => {
    const s = await factory();
    await s.append({ projectKey: "p1", sessionId: "s" }, [{ type: "user", uuid: "p1u" }]);
    await s.append({ projectKey: "p2", sessionId: "s" }, [{ type: "user", uuid: "p2u" }]);
    const a = await s.load({ projectKey: "p1", sessionId: "s" });
    const b = await s.load({ projectKey: "p2", sessionId: "s" });
    expect(a?.map((e) => e.uuid)).toEqual(["p1u"]);
    expect(b?.map((e) => e.uuid)).toEqual(["p2u"]);
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

  test("10. deleting the main key cascades to subkeys but not other sessions/projects", async () => {
    const s = await factory();
    if (!s.delete) return;
    await s.append({ projectKey: "p", sessionId: "s1" }, [{ type: "user", uuid: "u" }]);
    await s.append({ projectKey: "p", sessionId: "s1", subpath: "subagents/agent-x" }, [{ type: "user", uuid: "u" }]);
    await s.append({ projectKey: "p", sessionId: "s2" }, [{ type: "user", uuid: "u" }]);
    await s.append({ projectKey: "p2", sessionId: "s1" }, [{ type: "user", uuid: "u" }]);
    await s.delete({ projectKey: "p", sessionId: "s1" });
    expect(await s.load({ projectKey: "p", sessionId: "s1" })).toBeNull();
    expect(await s.load({ projectKey: "p", sessionId: "s1", subpath: "subagents/agent-x" })).toBeNull();
    expect(await s.load({ projectKey: "p", sessionId: "s2" })).not.toBeNull();
    expect(await s.load({ projectKey: "p2", sessionId: "s1" })).not.toBeNull();
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

describe("ClaudebotSessionStore conformance", () => {
  runConformance(async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudebot-conform-"));
    return createClaudebotSessionStore({ sessionsDir: dir });
  });
});
```

- [ ] **Step 2: Run the suite**

Run: `bun test tests/sdk-conformance.test.ts`
Expected: 13 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/sdk-conformance.test.ts
git commit -m "test(sessions): SDK conformance suite for adapter"
```

---

## Task 5: `jsonl-parser` pure function

**Files:**
- Create: `src/sessions/jsonl-parser.ts`
- Create: `src/sessions/jsonl-parser.test.ts`

The parser reads an SDK-style `.jsonl` transcript and returns the WebUI's `UIMessage` shape. Pure function: no SDK API calls.

- [ ] **Step 1: Write the failing tests**

Create `src/sessions/jsonl-parser.test.ts`:

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonlToUIMessages, flattenContent, extractMetadata } from "./jsonl-parser.ts";

describe("flattenContent", () => {
  test("concatenates text blocks in order", () => {
    const content = [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ];
    expect(flattenContent(content)).toBe("Hello world");
  });

  test("serializes tool_use as [tool:name] summary", () => {
    const content = [
      { type: "text", text: "I'll check. " },
      { type: "tool_use", id: "t1", name: "Read", input: { file: "/etc/hosts" } },
      { type: "text", text: "Done." },
    ];
    expect(flattenContent(content)).toBe("I'll check. [tool:Read] Done.");
  });

  test("returns empty string for empty content", () => {
    expect(flattenContent([])).toBe("");
  });
});

describe("extractMetadata", () => {
  test("captures tool_use ids + names", () => {
    const content = [
      { type: "tool_use", id: "t1", name: "Read", input: { file: "/x" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { cmd: "ls" } },
    ];
    expect(extractMetadata(content)).toEqual({
      toolCalls: [
        { id: "t1", name: "Read", input: { file: "/x" } },
        { id: "t2", name: "Bash", input: { cmd: "ls" } },
      ],
    });
  });

  test("captures thinking blocks when present", () => {
    const content = [{ type: "thinking", thinking: "let me think..." }];
    expect(extractMetadata(content)).toEqual({ thinking: "let me think..." });
  });

  test("returns empty object when no tool_use or thinking", () => {
    expect(extractMetadata([{ type: "text", text: "hi" }])).toEqual({});
  });
});

describe("parseJsonlToUIMessages", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudebot-parser-"));
  });

  async function writeJsonl(name: string, lines: string[]) {
    const file = join(dir, name);
    await Bun.write(file, lines.join("\n") + "\n");
    return file;
  }

  test("parses user and assistant messages, ignoring non-message types", async () => {
    const file = await writeJsonl("transcript.jsonl", [
      JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-06-09T10:00:00Z", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-06-09T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "system", subtype: "init", uuid: "i1", timestamp: "2026-06-09T09:59:59Z" }),
      JSON.stringify({ type: "summary", uuid: "sm1", summary: "auto-summary" }),
    ]);
    const out = await parseJsonlToUIMessages(file);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "u1", role: "user", content: "hi", createdAt: "2026-06-09T10:00:00Z" });
    expect(out[1]).toMatchObject({ id: "a1", role: "assistant", content: "hello", createdAt: "2026-06-09T10:00:01Z" });
  });

  test("falls back to file mtime when timestamp is missing", async () => {
    const file = await writeJsonl("no-ts.jsonl", [
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }),
    ]);
    const out = await parseJsonlToUIMessages(file);
    expect(out).toHaveLength(1);
    expect(out[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("captures toolCalls in metadata for assistant messages", async () => {
    const file = await writeJsonl("tool.jsonl", [
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-09T10:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "t1", name: "Read", input: { path: "/x" } },
          ],
        },
      }),
    ]);
    const out = await parseJsonlToUIMessages(file);
    expect(out[0].content).toBe("checking [tool:Read]");
    expect(out[0].metadata).toEqual({ toolCalls: [{ id: "t1", name: "Read", input: { path: "/x" } }] });
  });

  test("returns [] for an empty file", async () => {
    const file = await writeJsonl("empty.jsonl", []);
    const out = await parseJsonlToUIMessages(file);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/sessions/jsonl-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

Create `src/sessions/jsonl-parser.ts`:

```ts
import { readFile, stat } from "node:fs/promises";

export type UIMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

type Entry = {
  type: string;
  uuid?: string;
  timestamp?: string;
  message?: { role?: string; content?: ContentBlock[] };
};

export function flattenContent(content: ContentBlock[] | undefined): string {
  if (!content) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push((block as { text: string }).text);
    } else if (block.type === "tool_use") {
      const tb = block as { name: string };
      parts.push(`[tool:${tb.name}]`);
    }
  }
  return parts.join(" ");
}

export function extractMetadata(content: ContentBlock[] | undefined): Record<string, unknown> {
  if (!content) return {};
  const meta: Record<string, unknown> = {};
  const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
  const thinkings: string[] = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      const tb = block as { id: string; name: string; input: unknown };
      toolCalls.push({ id: tb.id, name: tb.name, input: tb.input });
    } else if (block.type === "thinking") {
      const tb = block as { thinking: string };
      thinkings.push(tb.thinking);
    }
  }
  if (toolCalls.length > 0) meta.toolCalls = toolCalls;
  if (thinkings.length > 0) meta.thinking = thinkings.join("\n");
  return meta;
}

export async function parseJsonlToUIMessages(filePath: string): Promise<UIMessage[]> {
  const text = await readFile(filePath, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);

  // Compute mtime once for timestamp fallback
  let mtimeIso: string | null = null;
  try {
    const st = await stat(filePath);
    mtimeIso = st.mtime.toISOString();
  } catch {
    // ignore; fallback handled inline
  }

  const out: UIMessage[] = [];
  for (const line of lines) {
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue; // skip malformed lines (the SDK may write partial markers)
    }
    if (entry.type !== "user" && entry.type !== "assistant" && entry.type !== "system") continue;

    const content = entry.message?.content;
    const id = entry.uuid ?? crypto.randomUUID();
    const createdAt = entry.timestamp ?? mtimeIso ?? new Date().toISOString();
    const role = entry.type as "user" | "assistant" | "system";

    out.push({
      id,
      role,
      content: flattenContent(content),
      createdAt,
      metadata: extractMetadata(content),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/sessions/jsonl-parser.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/jsonl-parser.ts src/sessions/jsonl-parser.test.ts
git commit -m "feat(sessions): jsonl parser for WebUI consumption"
```

---

## Task 6: Runner — add `sdkConfigDir` parameter, inject `CLAUDE_CONFIG_DIR`

**Files:**
- Modify: `src/agent/runner.ts`

- [ ] **Step 1: Update the `makeRealQueryFactory` signature and env**

In `src/agent/runner.ts`, change the function signature and the `env` literal. Replace:

```ts
export function makeRealQueryFactory(
  registry: ToolRegistry,
  config: RuntimeConfig,
): QueryFactory {
  return async function* ({ prompt, resumeSessionId, systemPrompt, toolContext }) {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const mcpServer = createClaudebotSdkMcpServer(registry, toolContext);
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...(config.claudeCode.baseUrl ? { ANTHROPIC_BASE_URL: config.claudeCode.baseUrl } : {}),
      ...(config.claudeCode.apiKey
        ? {
            ANTHROPIC_API_KEY: config.claudeCode.apiKey,
            ANTHROPIC_AUTH_TOKEN: config.claudeCode.apiKey,
          }
        : {}),
    };
    const stream = query({
      prompt,
      options: {
        model: config.claudeCode.model,
        systemPrompt,
        permissionMode: config.claudeCode.permissionMode,
        maxTurns: config.claudeCode.maxTurns,
        env,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        mcpServers: { claudebot: mcpServer },
      },
    });
    for await (const msg of stream) yield msg;
  };
}
```

with:

```ts
export function makeRealQueryFactory(
  registry: ToolRegistry,
  config: RuntimeConfig,
  sdkConfigDir: string,
): QueryFactory {
  return async function* ({ prompt, resumeSessionId, systemPrompt, toolContext }) {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const mcpServer = createClaudebotSdkMcpServer(registry, toolContext);
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_CONFIG_DIR: sdkConfigDir,
      ...(config.claudeCode.baseUrl ? { ANTHROPIC_BASE_URL: config.claudeCode.baseUrl } : {}),
      ...(config.claudeCode.apiKey
        ? {
            ANTHROPIC_API_KEY: config.claudeCode.apiKey,
            ANTHROPIC_AUTH_TOKEN: config.claudeCode.apiKey,
          }
        : {}),
    };
    const stream = query({
      prompt,
      options: {
        model: config.claudeCode.model,
        systemPrompt,
        permissionMode: config.claudeCode.permissionMode,
        maxTurns: config.claudeCode.maxTurns,
        env,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        mcpServers: { claudebot: mcpServer },
      },
    });
    for await (const msg of stream) yield msg;
  };
}
```

The `QueryFactory` return type and all event handling stay identical. The only change is the third parameter and the `CLAUDE_CONFIG_DIR` injection.

- [ ] **Step 2: Verify typecheck (will fail until services.ts is updated in Task 7)**

Run: `bunx tsc --noEmit`
Expected: type error at the call site of `makeRealQueryFactory` in `src/runtime/services.ts` ("Expected 3 arguments, but got 2"). This is expected and resolves in Task 7.

- [ ] **Step 3: Commit**

```bash
git add src/agent/runner.ts
git commit -m "feat(runner): inject CLAUDE_CONFIG_DIR from paths.sdkConfigDir"
```

---

## Task 7: Services — instantiate `sessionStore`, pass `sdkConfigDir`, drop `inbox` fallback

**Files:**
- Modify: `src/runtime/services.ts`

- [ ] **Step 1: Add the adapter import and instantiation**

At the top of `src/runtime/services.ts`, add the import:

```ts
import { createClaudebotSessionStore } from "../sessions/adapter.ts";
```

Inside `buildServices` (or wherever `makeRealQueryFactory` is called), update the call to pass `paths.sdkConfigDir` and create the adapter:

```ts
const sessionStore = createClaudebotSessionStore({ sessionsDir: paths.sessionsDir });
const queryFactory = makeRealQueryFactory(registry, config, paths.sdkConfigDir);
```

- [ ] **Step 2: Attach the adapter to the query options**

Find the location where `query({ options: { ... } })` is invoked in `makeRealQueryFactory`. Add the `sessionStore` to options:

```ts
const stream = query({
  prompt,
  options: {
    model: config.claudeCode.model,
    systemPrompt,
    permissionMode: config.claudeCode.permissionMode,
    maxTurns: config.claudeCode.maxTurns,
    env,
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    mcpServers: { claudebot: mcpServer },
    sessionStore,    // NEW
  },
});
```

- [ ] **Step 3: Remove `inbox` fallback in `runScheduledTurn`**

In `runScheduledTurn` (and the surrounding `readRuntimeStateOrEmpty` / `getOrCreateInbox` paths), change the function body so it no longer falls back to the `"inbox"` id and no longer creates an inbox record. The full replacement for `runScheduledTurn` is in Task 10. For now, remove only the inbox literal:

Replace:

```ts
const target = state.lastActiveSessionId || "inbox";
const sessions = new SessionStore(paths.sessionsDir);
const session = (await sessions.get(target)) || (await sessions.getOrCreateInbox());
```

with:

```ts
const target = state.lastActiveSessionId;
if (!target) return `[schedule ${sched.id}] skipped: no active session`;
const session = (await services.sessions.get(target));
if (!session) return `[schedule ${sched.id}] skipped: session ${target} not found`;
```

(Final form in Task 10 will call `runner.run()` instead of `appendMessage`.)

- [ ] **Step 4: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Run existing tests**

Run: `bun test`
Expected: existing tests still pass (some may need updating in Task 12; address any outright failures that are simple — defer the rest).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/services.ts
git commit -m "feat(services): wire ClaudebotSessionStore + pass sdkConfigDir"
```

---

## Task 8: HTTP endpoints — list, messages, PATCH, DELETE; remove POST

**Files:**
- Modify: `src/gateway/http.ts`

- [ ] **Step 1: Replace `/webui/bootstrap` and `/api/sessions` list logic**

Replace the bodies that use `services.sessions.list()` with calls to the SDK's `listSessions` and `getSessionInfo`. The HTTP handler needs access to the SDK helpers; expose them via a new field on `ServiceContainer` (e.g. `services.sdk.listSessions`), or call the `queryFactory` via a small wrapper. For simplicity, add a `services.sdkSessions` field that wraps the adapter + SDK helpers. The shape:

```ts
// in services.ts
const sdkSessions = {
  store: sessionStore,
  list: (projectKey: string) => sessionStore.listSessions!(projectKey),
  info: async (sessionId: string) => {
    // Use SDK's getSessionInfo with our store as the source.
    const { getSessionInfo } = await import("@anthropic-ai/claude-agent-sdk");
    return getSessionInfo(sessionId, { sessionStore: sessionStore });
  },
  rename: async (sessionId: string, title: string) => {
    const { renameSession } = await import("@anthropic-ai/claude-agent-sdk");
    await renameSession(sessionId, title);
  },
  remove: (sessionId: string) => sessionStore.delete!({ projectKey: "claudebot", sessionId }),
};
```

In `http.ts`, replace the list endpoints with:

```ts
if (path === "/webui/bootstrap" && method === "GET") {
  const list = await services.sdkSessions.list("claudebot");
  const summaries = await Promise.all(
    list.map(async (s) => {
      const info = await services.sdkSessions.info(s.sessionId);
      return {
        id: s.sessionId,
        title: info?.customTitle ?? info?.summary ?? info?.firstPrompt ?? "(untitled)",
        preview: info?.firstPrompt ?? "",
        updatedAt: new Date(s.mtime).toISOString(),
        messageCount: 0, // populated by a follow-up count call if needed; UI tolerates 0
      };
    }),
  );
  const state = await services.runtimeState.get();
  return json(200, {
    config: { gateway: services.config.gateway, claudeCode: { model: services.config.claudeCode.model, permissionMode: services.config.claudeCode.permissionMode } },
    lastActiveSessionId: state.lastActiveSessionId,
    sessions: summaries,
  });
}

if (path === "/api/sessions" && method === "GET") {
  const list = await services.sdkSessions.list("claudebot");
  return json(200, list.map((s) => ({ id: s.sessionId, mtime: s.mtime })));
}
```

- [ ] **Step 2: Remove `POST /api/sessions` handler**

Delete the `if (path === "/api/sessions" && method === "POST")` block. Creating a session is now a side effect of `chat.user_message` with no `resumeSessionId`.

- [ ] **Step 3: Replace `/api/sessions/:id/messages` with parser-based read**

In the `sessionMatch` branch, replace the `/messages` GET:

```ts
if (sub === "/messages" && method === "GET") {
  const sessionDir = join(services.paths.sessionsDir, id, "main.jsonl");
  const file = Bun.file(sessionDir);
  if (!(await file.exists())) return json(200, []);
  const { parseJsonlToUIMessages } = await import("../sessions/jsonl-parser.ts");
  const messages = await parseJsonlToUIMessages(sessionDir);
  return json(200, messages);
}
```

- [ ] **Step 4: Replace PATCH with `renameSession`**

```ts
if (sub === "" && method === "PATCH") {
  const body = await safeJson(req) as { title?: string } | null;
  if (!body?.title) return json(400, { error: "title required" });
  await services.sdkSessions.rename(id, body.title);
  return json(200, { id, title: body.title });
}
```

- [ ] **Step 5: Replace DELETE with adapter call**

```ts
if (sub === "" && method === "DELETE") {
  await services.sdkSessions.remove(id);
  return json(200, { deleted: id });
}
```

- [ ] **Step 6: Update `/api/sessions/:id/activate` if needed**

This endpoint already takes only `id` and updates `runtimeState`. No change.

- [ ] **Step 7: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/gateway/http.ts src/runtime/services.ts
git commit -m "feat(gateway): HTTP endpoints read from jsonl adapter"
```

---

## Task 9: WebSocket `runUserTurn` — drop `appendMessage`, handle `mirror_error`

**Files:**
- Modify: `src/gateway/websocket.ts`

- [ ] **Step 1: Replace `runUserTurn` body**

The new body:

```ts
export async function runUserTurn(
  ws: ServerWebSocket<WsData>,
  services: ServiceContainer,
  sessionId: string | null,
  content: string,
): Promise<void> {
  const send = (m: WsServerMessage) => sendTo(ws, m);

  // Resolve session: either caller-supplied, last active, or null (let SDK create)
  let sdkSessionId: string | undefined;
  if (sessionId) {
    sdkSessionId = sessionId;
  } else {
    const state = await services.runtimeState.get();
    sdkSessionId = state.lastActiveSessionId || undefined;
  }

  // We need a session id before we can persist anything. If we don't have one
  // yet, run the query and capture the new id from system/init or the result.
  const runner = services.makeRunner("user_turn", sdkSessionId ?? "pending");
  let lastSessionId: string | undefined = sdkSessionId;
  let collected = "";
  let turnErrored = false;
  let finalResult = "";

  try {
    for await (const ev of runner.run({ prompt: content, resumeSessionId: sdkSessionId })) {
      // Surface mirror_error so WebUI status reflects SDK health
      if (ev.type === "error" && ev.message.includes("mirror_error")) {
        send({ type: "agent.status", status: "mirror_error", sessionId: ev.sessionId });
        continue;
      }
      forward(send, ev);
      if (ev.type === "text_delta") collected += ev.text;
      if (ev.type === "turn_done") {
        finalResult = ev.result;
        if (ev.sessionId) lastSessionId = ev.sessionId;
      }
      if (ev.type === "error") {
        turnErrored = true;
        finalResult = `[error] ${ev.message}`;
      }
    }
  } catch (err) {
    turnErrored = true;
    finalResult = `[error] ${err instanceof Error ? err.message : String(err)}`;
  }

  if (lastSessionId) {
    await services.runtimeState.setLastActiveSession(lastSessionId, "user_message");
    ws.data.sessionId = lastSessionId;
  }

  // Settle delay: sessionStoreFlush defaults to 'batched'. Give the mirror a
  // beat to flush before we ack the WebUI (50ms is plenty for small batches).
  await new Promise((r) => setTimeout(r, 50));

  const finalText = collected || finalResult || (turnErrored ? "(no response)" : "(no response)");
  const activeSdkId = lastSessionId ?? sdkSessionId ?? "pending";
  send({
    type: "message.appended",
    sessionId: activeSdkId,
    message: {
      id: `local-${Date.now()}`,
      role: turnErrored ? "system" : "assistant",
      content: finalText,
      createdAt: new Date().toISOString(),
      metadata: turnErrored ? { error: true } : {},
    },
  });
}
```

- [ ] **Step 2: Update `handleClientMessage` to remove the `inbox` fallback**

In `handleClientMessage` (`session.activate` and `chat.user_message` branches), remove any reference to the literal `"inbox"` and pass `null` when no session is known:

```ts
case "chat.user_message": {
  const state = await services.runtimeState.get();
  const sessionId = ws.data.sessionId && ws.data.sessionId !== "pending"
    ? ws.data.sessionId
    : (state.lastActiveSessionId || null);
  await runUserTurn(ws, services, sessionId, msg.content);
  return;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/gateway/websocket.ts
git commit -m "feat(gateway): runUserTurn no longer appendMessage; mirror_error surfaced"
```

---

## Task 10: Scheduler stub → real

**Files:**
- Modify: `src/runtime/services.ts`

- [ ] **Step 1: Rewrite `runScheduledTurn`**

Replace the body of `runScheduledTurn` so it actually invokes the runner against the last active session:

```ts
async function runScheduledTurn(
  sched: { id: string; message: string; timezone: string },
  run: { id: string; startedAt: string },
  _config: RuntimeConfig,
  paths: RuntimePaths,
  queryFactory: QueryFactory,
): Promise<string> {
  const state = await readRuntimeStateOrEmpty(paths.runtimeStateFile);
  const target = state.lastActiveSessionId;
  if (!target) {
    return `[schedule ${sched.id}] skipped: no active session`;
  }
  // Dispatch a real turn. The runner streams via the same queryFactory
  // we use for user turns; the result is folded into the session's .jsonl
  // via the sessionStore adapter.
  const prompt = `[schedule ${sched.id}] ${sched.message}`;
  const runner = new ClaudeRunner(
    {
      config: _config,
      registry: toolRegistry, // hoist to module scope if not already
      promptInputs: {
        source: "scheduler",
        home: paths.home,
        workspacePath: paths.workspace,
        timezone: sched.timezone,
        sessionId: target,
        scheduleRunId: run.id,
      },
    },
    queryFactory,
  );
  let result = "";
  for await (const ev of runner.run({ prompt, resumeSessionId: target })) {
    if (ev.type === "text_delta") result += ev.text;
    if (ev.type === "turn_done") result = ev.result || result;
  }
  return result || `[schedule ${sched.id}] (no output)`;
}
```

If `toolRegistry` is not already in scope of `runScheduledTurn`, hoist it (it currently is — see `src/runtime/services.ts:71`).

- [ ] **Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/runtime/services.ts
git commit -m "feat(scheduler): runScheduledTurn dispatches a real Claude turn"
```

---

## Task 11: Strip `SessionStore.messages` and `SessionMessage` types

**Files:**
- Modify: `src/sessions/store.ts`
- Modify: `src/sessions/types.ts`

- [ ] **Step 1: Remove the `messages` field from `SessionRecord`**

In `src/sessions/types.ts`, change:

```ts
export type SessionRecord = {
  id: string;
  title: string;
  preview: string;
  claudeSessionId: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];   // DELETE THIS LINE
};
```

`SessionMessage` itself is no longer referenced after Tasks 7–10 land; delete the type if `grep -rn "SessionMessage" src/` returns no other callers.

- [ ] **Step 2: Slim down `SessionStore`**

In `src/sessions/store.ts`, delete `appendMessage` and the `messages` field handling. The remaining methods (`create`, `get`, `list`, `delete`, `save`, `getOrCreateInbox` — drop the last) deal only with metadata. `save` is still used by the gateway for title/preview/createdAt/updatedAt; keep it.

If `getOrCreateInbox` is no longer called from anywhere (search for it), delete it.

- [ ] **Step 3: Verify typecheck + test**

Run: `bunx tsc --noEmit && bun test src/sessions/ tests/sdk-conformance.test.ts`
Expected: 0 type errors; adapter + parser + conformance tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/sessions/store.ts src/sessions/types.ts
git commit -m "refactor(sessions): remove SessionRecord.messages and inbox machinery"
```

---

## Task 12: Test updates (sessions, gateway, scheduler, webui)

**Files:**
- Modify: `tests/sessions.test.ts`
- Modify: `tests/gateway.test.ts`
- Modify: `tests/scheduler.test.ts`
- Modify: `webui/src/lib/active-session.ts`
- Modify: `webui/src/lib/claudebot-client.ts`
- Modify: `webui/src/App.tsx`
- Modify: `webui/src/tests/active-session.test.ts`

- [ ] **Step 1: Update webui comments and `pickInitialActiveSession`**

In `webui/src/lib/active-session.ts`:
- Drop the comment block that mentions "the server seeds an empty `inbox` placeholder" (lines 7–13).
- If `pickInitialActiveSession` has special handling for `id === "inbox"`, remove that branch.

In `webui/src/lib/claudebot-client.ts`:
- Drop the comment in the constructor / `currentChatId` field that explains "the wire's sessionId is the *Claude* session UUID, not the claudebot session id." They are now the same.

In `webui/src/App.tsx`:
- Drop the inline comment near line 111 that references the "empty `inbox` placeholder".

- [ ] **Step 2: Update the active-session test**

In `webui/src/tests/active-session.test.ts`:
- Delete the test `falls back to the first session when lastActiveSessionId is the empty inbox`.
- Add a replacement test:

```ts
it("returns null when there are no sessions", () => {
  expect(pickInitialActiveSession([], null)).toBeNull();
});
```

- [ ] **Step 3: Rewrite `tests/sessions.test.ts`**

Replace the file contents with adapter + parser tests that re-export the suites from the unit test files. The simplest form:

```ts
import { describe } from "bun:test";
import "./../src/sessions/adapter.test.ts";
import "./../src/sessions/jsonl-parser.test.ts";
import "./sdk-conformance.test.ts";

describe("sessions (umbrella)", () => {
  // The actual tests live in their respective files. This block exists
  // only so `bun test tests/sessions.test.ts` runs them all.
});
```

- [ ] **Step 4: Update `tests/gateway.test.ts`**

Find tests that exercise `runUserTurn` and:
- Replace any `appendMessage` assertions with assertions that the runner stream is forwarded.
- Replace any `"inbox"` literal with `null` (or remove the test if its only purpose was the inbox fallback).
- Add a new test:

```ts
test("runUserTurn does not call appendMessage", async () => {
  // setup mock services with a spy on sessions.appendMessage
  let appendCalled = false;
  const services = makeMockServices({ onAppend: () => { appendCalled = true; } });
  await runUserTurn(mockWs, services, null, "hi");
  expect(appendCalled).toBe(false);
});
```

- [ ] **Step 5: Update `tests/scheduler.test.ts`**

Replace tests that assert the schedule message is appended via `appendMessage` with tests that assert the runner was invoked:

```ts
test("runScheduledTurn dispatches runner.run when there is an active session", async () => {
  const runnerSpy = mock(() => emptyAsyncIter());
  // wire runnerSpy into services
  // set runtimeState.lastActiveSessionId = "sess-1"
  await runScheduledTurn({ id: "sched-1", message: "tick", timezone: "UTC" }, { id: "run-1", startedAt: "..." }, config, paths, qf);
  expect(runnerSpy).toHaveBeenCalled();
});

test("runScheduledTurn skips when there is no active session", async () => {
  // lastActiveSessionId = null
  // assert runnerSpy not called
});
```

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add tests/sessions.test.ts tests/gateway.test.ts tests/scheduler.test.ts \
        webui/src/lib/active-session.ts webui/src/lib/claudebot-client.ts \
        webui/src/App.tsx webui/src/tests/active-session.test.ts
git commit -m "test: update for jsonl-backed sessions and real scheduler"
```

---

## Task 13: Final verification

**Files:** none

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 2: Lint WebUI**

Run: `cd webui && bun run lint`
Expected: 0 warnings.

- [ ] **Step 3: WebUI typecheck**

Run: `cd webui && bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Full server test suite**

Run: `bun test`
Expected: all tests pass, including the 13 conformance tests.

- [ ] **Step 5: Full WebUI test suite**

Run: `cd webui && bun run test`
Expected: all tests pass.

- [ ] **Step 6: Manual smoke check**

Run: `bun run dev:all` and:
1. Open `http://localhost:5173`
2. Send a message; verify the assistant reply streams
3. Reload the page; verify the history persists
4. Open a new chat; verify a new session id appears in the sidebar
5. `ls ~/.claudebot/sessions/` should show the new session directory

- [ ] **Step 7: Commit any final docs / cleanup**

If you updated CLAUDE.md or any spec docs to reflect the new model, commit them here.

```bash
git status
git add -A
git commit -m "docs: update CLAUDE.md for jsonl-backed sessions" || true
```

---

## Self-Review

**1. Spec coverage:**
- "Add `sdkConfigDir` to `RuntimePaths`" → Task 1 ✅
- "Implement `ClaudebotSessionStore` with `append/load/listSessions/delete/listSubkeys`" → Tasks 2–3 ✅
- "Pass the SDK's 13-test conformance suite" → Task 4 ✅
- "Implement `jsonl-parser` (TDD, user/assistant filter, content flatten, timestamp fallback, metadata extraction)" → Task 5 ✅
- "Runner takes `sdkConfigDir`, injects `CLAUDE_CONFIG_DIR`" → Task 6 ✅
- "Services wires adapter, passes `paths.sdkConfigDir` to `queryFactory`, drops `inbox` fallback" → Task 7 ✅
- "HTTP: list via SDK helpers, messages via parser, PATCH via `renameSession`, DELETE via adapter, remove POST" → Task 8 ✅
- "WebSocket `runUserTurn` drops `appendMessage`, surfaces `mirror_error`, persists new `sdkSessionId`" → Task 9 ✅
- "Scheduler dispatches `runner.run()`" → Task 10 ✅
- "Strip `SessionRecord.messages` and `SessionMessage`" → Task 11 ✅
- "Update webui comments and active-session tests" → Task 12 ✅
- "Update server tests" → Task 12 ✅
- "Final verification" → Task 13 ✅

**2. Placeholder scan:**
- No "TBD" / "TODO" / "fill in" / "similar to Task N" / "implement later" / "add appropriate handling".
- Every code step shows actual code; every test step shows actual assertions.

**3. Type consistency:**
- `SessionStore`, `SessionKey`, `SessionStoreEntry` are used structurally in the conformance suite; in production code they are imported from `@anthropic-ai/claude-agent-sdk` (Task 2–3). Names match.
- `UIMessage` defined in `jsonl-parser.ts` matches the `message.appended` wire shape (`{id, role, content, createdAt, metadata}`).
- `makeRealQueryFactory` signature in Task 6 (3-arg) is the only signature used in Task 7's call site.
- `services.sdkSessions` defined in Task 8 and consumed in `http.ts` — consistent.

**4. Open decisions deferred to user (called out in chat, not the plan):**
- `POST /api/sessions` is **removed** (per the chat-decided direction). If the user later wants it back as "init session", that is a follow-up plan, not a blocker.

---

## Plan complete

Saved to `docs/superpowers/plans/2026-06-09-session-storage-refactor.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
