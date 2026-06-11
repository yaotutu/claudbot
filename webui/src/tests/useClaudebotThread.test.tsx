import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useClaudebotThread } from "@/hooks/useClaudebotThread";
import type { ServerFrame, ThreadMessage } from "@/lib/claudebot-types";

function makeClient() {
  const handlers = new Set<(frame: ServerFrame) => void>();
  const statusHandlers = new Set<(status: string) => void>();
  return {
    onFrame: (handler: (frame: ServerFrame) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onStatus: (handler: (status: string) => void) => {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
    sendMessage: vi.fn(),
    emit: (frame: ServerFrame) => {
      for (const handler of handlers) handler(frame);
    },
    emitStatus: (status: string) => {
      for (const handler of statusHandlers) handler(status);
    },
  };
}

describe("useClaudebotThread", () => {
  it("loads persisted messages for a session", async () => {
    const messages: ThreadMessage[] = [{ id: "m1", role: "user", content: "hi", createdAt: "2026-06-10T09:59:40.000Z", metadata: {} }];
    const fetchMessages = vi.fn(async () => messages);
    const { result } = renderHook(() => useClaudebotThread({
      sessionId: "s1",
      sessionStatus: "persisted",
      client: makeClient(),
      fetchMessages,
    }));

    await waitFor(() => expect(result.current.messages).toEqual(messages));
    expect(result.current.loading).toBe(false);
  });

  it("sends a draft message and streams the assistant reply", async () => {
    const client = makeClient();
    const fetchMessages = vi.fn(async () => []);
    const { result } = renderHook(() => useClaudebotThread({
      sessionId: "draft-1",
      sessionStatus: "draft",
      client,
      fetchMessages,
    }));

    await act(async () => {
      result.current.send("ping");
    });

    expect(client.sendMessage).toHaveBeenCalledWith({ draftId: "draft-1", content: "ping" });
    expect(result.current.messages.at(-1)).toMatchObject({ role: "user", content: "ping" });

    act(() => {
      client.emit({ type: "session.created", draftId: "draft-1", session: { id: "s1", title: "ping", preview: "ping", createdAt: null, updatedAt: null, messageCount: 1, status: "persisted" } });
      client.emit({ type: "run.started", sessionId: "s1", runId: "r1" });
      client.emit({ type: "run.delta", sessionId: "s1", runId: "r1", text: "po" });
      client.emit({ type: "run.delta", sessionId: "s1", runId: "r1", text: "ng" });
    });

    expect(result.current.streaming).toBe(true);
    expect(result.current.messages.at(-1)).toMatchObject({ role: "assistant", content: "pong" });

    act(() => {
      client.emit({ type: "run.completed", sessionId: "s1", runId: "r1", isError: false });
    });

    expect(result.current.streaming).toBe(false);
  });

  it("stops streaming when websocket closes mid-run", async () => {
    const client = makeClient();
    const fetchMessages = vi.fn(async () => []);
    const { result } = renderHook(() => useClaudebotThread({
      sessionId: "s1",
      sessionStatus: "persisted",
      client,
      fetchMessages,
    }));

    act(() => {
      client.emit({ type: "run.started", sessionId: "s1", runId: "r1" });
    });
    expect(result.current.streaming).toBe(true);

    act(() => {
      client.emitStatus("closed");
    });
    expect(result.current.streaming).toBe(false);
  });
});
