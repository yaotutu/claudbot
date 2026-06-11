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
    frameHandlerCount: () => handlers.size,
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

  it("keeps optimistic draft messages across remap and replaces streaming reply with final message", async () => {
    const client = makeClient();
    const fetchMessages = vi.fn(async () => []);
    const { result, rerender } = renderHook(
      ({ sessionId, sessionStatus }: { sessionId: string; sessionStatus: "draft" | "persisted" }) => useClaudebotThread({
        sessionId,
        sessionStatus,
        client,
        fetchMessages,
      }),
      { initialProps: { sessionId: "draft-1", sessionStatus: "draft" as const } },
    );

    await act(async () => {
      result.current.send("早上好");
    });

    act(() => {
      client.emit({ type: "session.created", draftId: "draft-1", session: { id: "s1", title: "早上好", preview: "早上好", createdAt: null, updatedAt: null, messageCount: 1, status: "persisted" } });
    });

    rerender({ sessionId: "s1", sessionStatus: "persisted" });
    await waitFor(() => expect(fetchMessages).toHaveBeenCalledWith("s1"));

    act(() => {
      client.emit({ type: "run.started", sessionId: "s1", runId: "r1" });
      client.emit({ type: "run.delta", sessionId: "s1", runId: "r1", text: "早上好！" });
      client.emit({ type: "run.completed", sessionId: "s1", runId: "r1", isError: false, result: "早上好！" });
      client.emit({ type: "message.appended", sessionId: "s1", message: { id: "server-a1", role: "assistant", content: "早上好！", createdAt: "2026-06-10T10:00:00.000Z", metadata: {} } });
    });

    expect(result.current.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:早上好",
      "assistant:早上好！",
    ]);
  });

  it("clears the previous persisted thread when switching to a new draft", async () => {
    const client = makeClient();
    const fetchMessages = vi.fn(async () => [{ id: "m1", role: "user", content: "旧消息", createdAt: "2026-06-10T10:00:00.000Z", metadata: {} }]);
    const { result, rerender } = renderHook(
      ({ sessionId, sessionStatus }: { sessionId: string; sessionStatus: "draft" | "persisted" }) => useClaudebotThread({
        sessionId,
        sessionStatus,
        client,
        fetchMessages,
      }),
      { initialProps: { sessionId: "s1", sessionStatus: "persisted" as const } },
    );

    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    rerender({ sessionId: "draft-2", sessionStatus: "draft" });

    expect(result.current.messages).toEqual([]);
  });

  it("stops streaming when websocket closes mid-run", async () => {
    const client = makeClient();
    const fetchMessages = vi.fn(async () => []);
    const { result } = renderHook(() => useClaudebotThread({
      sessionId: "s1",
      sessionStatus: "draft",
      client,
      fetchMessages,
    }));

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      client.emit({ type: "run.started", sessionId: "s1", runId: "r1" });
    });
    expect(result.current.streaming).toBe(true);

    act(() => {
      client.emitStatus("closed");
    });
    expect(result.current.streaming).toBe(false);
  });

  it("shows run.error as a system message and stops streaming", async () => {
    const client = makeClient();
    const fetchMessages = vi.fn(async () => []);
    const { result } = renderHook(() => useClaudebotThread({
      sessionId: "s1",
      sessionStatus: "draft",
      client,
      fetchMessages,
    }));

    await waitFor(() => expect(client.frameHandlerCount()).toBe(1));

    act(() => {
      client.emit({ type: "run.started", sessionId: "s1", runId: "r1" });
      client.emit({ type: "run.error", sessionId: "s1", runId: "r1", message: "mirror_error: flush failed" });
    });

    expect(result.current.streaming).toBe(false);
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "system",
      content: "mirror_error: flush failed",
      metadata: { error: true, runId: "r1" },
    });
  });
});
