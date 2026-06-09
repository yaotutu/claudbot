import { describe, expect, it } from "vitest";

import { pickInitialActiveSession } from "@/lib/active-session";
import type { ChatSummary } from "@/lib/types";

function makeSession(chatId: string, updatedAt: string): ChatSummary {
  return {
    key: `websocket:${chatId}`,
    channel: "websocket",
    chatId,
    createdAt: updatedAt,
    updatedAt,
    title: "",
    preview: "",
  };
}

describe("pickInitialActiveSession", () => {
  it("returns null when there are no sessions", () => {
    expect(pickInitialActiveSession([], null)).toBeNull();
    expect(pickInitialActiveSession([], "sess_abc")).toBeNull();
  });

  it("uses lastActiveSessionId when it matches a known session", () => {
    const sessions = [
      makeSession("sess_old", "2026-04-16T10:00:00Z"),
      makeSession("sess_recent", "2026-04-16T11:00:00Z"),
    ];

    expect(pickInitialActiveSession(sessions, "sess_recent")).toBe(
      "websocket:sess_recent",
    );
  });

  it("falls back to the first session when lastActiveSessionId is null", () => {
    const sessions = [
      makeSession("sess_recent", "2026-04-16T11:00:00Z"),
      makeSession("sess_old", "2026-04-16T10:00:00Z"),
    ];

    expect(pickInitialActiveSession(sessions, null)).toBe(
      "websocket:sess_recent",
    );
  });

  it("falls back to the first session when lastActiveSessionId is unknown", () => {
    const sessions = [
      makeSession("sess_recent", "2026-04-16T11:00:00Z"),
      makeSession("sess_old", "2026-04-16T10:00:00Z"),
    ];

    expect(pickInitialActiveSession(sessions, "sess_missing")).toBe(
      "websocket:sess_recent",
    );
  });

  it("falls back to the first session when lastActiveSessionId is the empty inbox", () => {
    // The server seeds an empty `inbox` placeholder. If the persisted
    // lastActiveSessionId points at it, prefer the most recent real chat.
    const sessions = [
      makeSession("sess_recent", "2026-04-16T11:00:00Z"),
      makeSession("sess_old", "2026-04-16T10:00:00Z"),
    ];

    expect(pickInitialActiveSession(sessions, "inbox")).toBe(
      "websocket:sess_recent",
    );
  });
});
