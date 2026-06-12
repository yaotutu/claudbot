import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeStateStore } from "../runtime/state.ts";
import { appendSessionJsonlEntry, readSessionJsonl } from "./jsonl-store.ts";
import { createSessionService } from "./session-service.ts";

describe("session service", () => {
  let dir: string;
  let state: RuntimeStateStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claudebot-session-service-"));
    state = new RuntimeStateStore(join(dir, "runtime-state.json"));
  });

  test("clearStaleActiveSession clears runtime state when main.jsonl is missing", async () => {
    const service = createSessionService({ sessionsDir: join(dir, "sessions"), runtimeState: state });
    await state.setLastActiveSession("missing", "user_open");

    await service.clearStaleActiveSession();

    expect((await state.get()).lastActiveSessionId).toBe("");
  });

  test("resolveResumeSessionId returns only persisted JSONL sessions", async () => {
    const sessionsDir = join(dir, "sessions");
    const service = createSessionService({ sessionsDir, runtimeState: state });
    await appendSessionJsonlEntry(sessionsDir, "real", { type: "user", uuid: "u1" });
    await state.setLastActiveSession("real", "user_open");

    expect(await service.resolveResumeSessionId(null)).toBe("real");
    expect(await service.resolveResumeSessionId("draft-local")).toBeUndefined();
    expect((await state.get()).lastActiveSessionId).toBe("");
  });

  test("rename appends a custom-title entry to JSONL", async () => {
    const sessionsDir = join(dir, "sessions");
    const service = createSessionService({ sessionsDir, runtimeState: state });
    await appendSessionJsonlEntry(sessionsDir, "s1", { type: "user", uuid: "u1", message: { role: "user", content: "hello" } });

    await service.rename("s1", "New title");

    const entries = await readSessionJsonl(sessionsDir, "s1");
    expect(entries.at(-1)).toMatchObject({ type: "custom-title", customTitle: "New title", sessionId: "s1" });
    expect((await service.getSummary("s1")).title).toBe("New title");
  });
});
