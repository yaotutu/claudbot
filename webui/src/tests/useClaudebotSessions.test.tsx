import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useClaudebotSessions } from "@/hooks/useClaudebotSessions";
import type { ServerFrame, SessionSummary } from "@/lib/claudebot-types";

function makeClient() {
  const handlers = new Set<(frame: ServerFrame) => void>();
  return {
    onFrame: (handler: (frame: ServerFrame) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    activateSession: vi.fn(),
    emit: (frame: ServerFrame) => {
      for (const handler of handlers) handler(frame);
    },
  };
}

const persisted: SessionSummary = {
  id: "s1",
  title: "hello",
  preview: "hello",
  createdAt: "2026-06-10T09:59:40.000Z",
  updatedAt: "2026-06-10T09:59:45.000Z",
  messageCount: 2,
  status: "persisted",
};

describe("useClaudebotSessions", () => {
  it("creates a draft session and replaces it when session.created arrives", async () => {
    const client = makeClient();
    const { result } = renderHook(() => useClaudebotSessions({
      initialSessions: [persisted],
      activeSessionId: "s1",
      client,
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
    }));

    let draftId = "";
    act(() => {
      draftId = result.current.createDraftSession();
    });

    expect(result.current.activeSessionId).toBe(draftId);
    expect(result.current.sessions[0]).toMatchObject({ id: draftId, status: "draft", title: "New chat" });

    const session: SessionSummary = { ...persisted, id: "s2", title: "ping", preview: "ping", messageCount: 1 };
    act(() => {
      client.emit({ type: "session.created", draftId, session });
    });

    await waitFor(() => expect(result.current.activeSessionId).toBe("s2"));
    expect(result.current.sessions[0]).toEqual(session);
    expect(result.current.sessions.some((item) => item.id === draftId)).toBe(false);
  });

  it("updates preview on message.appended and supports delete/rename", async () => {
    const client = makeClient();
    const deleteSession = vi.fn(async () => true);
    const renameSession = vi.fn(async () => undefined);
    const { result } = renderHook(() => useClaudebotSessions({
      initialSessions: [persisted],
      activeSessionId: "s1",
      client,
      deleteSession,
      renameSession,
    }));

    act(() => {
      client.emit({ type: "message.appended", sessionId: "s1", message: { id: "m1", role: "assistant", content: "new preview", createdAt: "2026-06-10T10:00:00.000Z", metadata: {} } });
    });

    expect(result.current.sessions[0]?.preview).toBe("new preview");

    await act(async () => {
      await result.current.renameSession("s1", "renamed");
    });
    expect(renameSession).toHaveBeenCalledWith("s1", "renamed");
    expect(result.current.sessions[0]?.title).toBe("renamed");

    await act(async () => {
      await result.current.deleteSession("s1");
    });
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(result.current.sessions).toEqual([]);
  });

  it("ignores legacy session.updated frames without a canonical summary", () => {
    const client = makeClient();
    const { result } = renderHook(() => useClaudebotSessions({
      initialSessions: [persisted],
      activeSessionId: "s1",
      client,
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
    }));

    act(() => {
      client.emit({ type: "session.updated", sessionId: "" } as unknown as ServerFrame);
    });

    expect(result.current.sessions).toEqual([persisted]);
    expect(result.current.activeSessionId).toBe("s1");
  });
});
