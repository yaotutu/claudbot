import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/sessions/store.ts";
import { RuntimeStateStore } from "../src/runtime/state.ts";

describe("sessions and active state", () => {
  test("creates inbox when no active session exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-sessions-"));
    const sessions = new SessionStore(dir);
    const state = new RuntimeStateStore(join(dir, "runtime_state.json"));
    const session = await sessions.getOrCreateInbox();
    await state.setLastActiveSession(session.id, "user_open");
    expect((await state.get()).lastActiveSessionId).toBe("inbox");
  });

  test("assistant append does not change active session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-sessions-"));
    const state = new RuntimeStateStore(join(dir, "runtime_state.json"));
    await state.setLastActiveSession("sess_a", "user_message");
    await state.recordAssistantAppend("sess_b");
    expect((await state.get()).lastActiveSessionId).toBe("sess_a");
  });
});
