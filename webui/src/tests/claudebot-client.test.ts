import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudebotClient } from "@/lib/claudebot-client";

/**
 * Minimal fake WebSocket implementing the subset ClaudebotClient touches.
 * Every instance is retrievable via ``FakeSocket.instances`` so tests can
 * drive open/close/message lifecycles deterministically.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  /** Simulate a server-initiated drop with a specific wire-level close code
   * (e.g. ``1009`` for Message Too Big). */
  fakeCloseWithCode(code: number) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }

  fakeOpen() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  fakeMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

function lastSocket(): FakeSocket {
  const s = FakeSocket.instances.at(-1);
  if (!s) throw new Error("no socket created yet");
  return s;
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaudebotClient", () => {
  it("routes message.appended events to the matching chat handler", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const handler = vi.fn();
    client.onChat("chat-a", handler);
    client.connect();
    lastSocket().fakeOpen();
    // claudebot wire format: message.appended with sessionId matching the chat
    lastSocket().fakeMessage({
      type: "message.appended",
      sessionId: "chat-a",
      message: { id: "1", role: "assistant", content: "hi", createdAt: "2026-01-01T00:00:00Z", metadata: { source: "schedule" } },
    });
    lastSocket().fakeMessage({
      type: "message.appended",
      sessionId: "chat-b",
      message: { id: "2", role: "assistant", content: "no", createdAt: "2026-01-01T00:00:00Z", metadata: { source: "schedule" } },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      event: "message",
      chat_id: "chat-a",
      text: "hi",
    });
  });

  it("can swap the socket factory when the runtime URL changes", () => {
    const browserFactory = vi.fn(
      (url: string) => new FakeSocket(`browser:${url}`) as unknown as WebSocket,
    );
    const hostFactory = vi.fn(
      (url: string) => new FakeSocket(`host:${url}`) as unknown as WebSocket,
    );
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: browserFactory,
    });

    client.connect();
    expect(lastSocket().url).toBe("browser:ws://test");
    client.close();
    client.updateUrl("ws://127.0.0.1:18791/", hostFactory);
    client.connect();

    expect(hostFactory).toHaveBeenCalledWith("ws://127.0.0.1:18791/");
    expect(lastSocket().url).toBe("host:ws://127.0.0.1:18791/");
  });

  it("buffers chat events while no chat handler is registered and replays on subscribe", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    // Nobody listening yet — message.appended events are buffered by sessionId.
    lastSocket().fakeMessage({
      type: "message.appended",
      sessionId: "chat-queue",
      message: { id: "1", role: "assistant", content: "a", createdAt: "2026-01-01T00:00:00Z", metadata: { source: "schedule" } },
    });
    lastSocket().fakeMessage({
      type: "message.appended",
      sessionId: "chat-queue",
      message: { id: "2", role: "assistant", content: "b", createdAt: "2026-01-01T00:00:00Z", metadata: { source: "schedule" } },
    });
    const handler = vi.fn();
    client.onChat("chat-queue", handler);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0]).toMatchObject({ event: "message", text: "a" });
    expect(handler.mock.calls[1][0]).toMatchObject({ event: "message", text: "b" });
    // New events after subscription should go directly.
    lastSocket().fakeMessage({
      type: "message.appended",
      sessionId: "chat-queue",
      message: { id: "3", role: "assistant", content: "c", createdAt: "2026-01-01T00:00:00Z", metadata: { source: "schedule" } },
    });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("records running status from agent.status without an onChat subscriber", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    // Must set currentChatId via attach so agent.status can record by rid.
    client.onChat("chat-strip", () => {});
    client.connect();
    lastSocket().fakeOpen();
    // agent.status with "running" sets runStartedAt.
    lastSocket().fakeMessage({
      type: "agent.status",
      status: "running",
      sessionId: "some-sdk-id",
    });
    expect(client.getRunStartedAt("chat-strip")).toBeTruthy();
    // agent.turn_done clears it.
    lastSocket().fakeMessage({
      type: "agent.turn_done",
      sessionId: "some-sdk-id",
      isError: false,
      result: "",
    });
    expect(client.getRunStartedAt("chat-strip")).toBeNull();
  });

  it("clears run strip when a turn_done arrives", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const handler = vi.fn();
    client.onRunStatus(handler);
    client.onChat("chat-strip", () => {});
    client.connect();
    lastSocket().fakeOpen();
    // Start a run.
    lastSocket().fakeMessage({
      type: "agent.status",
      status: "running",
      sessionId: "sdk-1",
    });
    // End the turn — clears run strip.
    lastSocket().fakeMessage({
      type: "agent.turn_done",
      sessionId: "sdk-1",
      isError: false,
      result: "",
    });
    expect(client.getRunStartedAt("chat-strip")).toBeNull();
    expect(handler).toHaveBeenLastCalledWith("chat-strip", null);
  });

  it("notifies run status subscribers and replays running chats", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const handler = vi.fn();
    client.onRunStatus(handler);
    client.onChat("chat-status", () => {});
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeMessage({
      type: "agent.status",
      status: "running",
      sessionId: "sdk-1",
    });
    expect(handler).toHaveBeenCalledWith("chat-status", expect.any(Number));

    // Late subscriber gets replay of the current running state.
    const lateHandler = vi.fn();
    client.onRunStatus(lateHandler);
    expect(lateHandler).toHaveBeenCalledWith("chat-status", expect.any(Number));

    // Turn done clears the run.
    lastSocket().fakeMessage({
      type: "agent.turn_done",
      sessionId: "sdk-1",
      isError: false,
      result: "",
    });
    expect(handler).toHaveBeenCalledWith("chat-status", null);
    expect(lateHandler).toHaveBeenCalledWith("chat-status", null);
  });

  it("records goal_state from turn_done", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.onChat("chat-goal", () => {});
    client.connect();
    lastSocket().fakeOpen();
    // turn_done always sets goal_state to { active: false }.
    lastSocket().fakeMessage({
      type: "agent.turn_done",
      sessionId: "sdk-1",
      isError: false,
      result: "",
    });
    expect(client.getGoalState("chat-goal")).toEqual({ active: false });
  });

  it("buffers after unsubscribe until the chat is subscribed again", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const h1 = vi.fn();
    const unsub = client.onChat("chat-rejoin", h1);
    client.connect();
    lastSocket().fakeOpen();
    // Live event arrives while subscribed.
    lastSocket().fakeMessage({
      type: "message.appended",
      sessionId: "chat-rejoin",
      message: { id: "1", role: "assistant", content: "live", createdAt: "2026-01-01T00:00:00Z", metadata: { source: "schedule" } },
    });
    expect(h1).toHaveBeenCalledTimes(1);
    unsub();
    // Event after unsubscribe — should be buffered.
    lastSocket().fakeMessage({
      type: "message.appended",
      sessionId: "chat-rejoin",
      message: { id: "2", role: "assistant", content: "queued", createdAt: "2026-01-01T00:00:00Z", metadata: { source: "schedule" } },
    });
    expect(h1).toHaveBeenCalledTimes(1);
    // Re-subscribe — buffered event replays.
    const h2 = vi.fn();
    client.onChat("chat-rejoin", h2);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h2.mock.calls[0][0]).toMatchObject({ event: "message", text: "queued" });
  });

  it("dispatches runtime model updates via setRuntimeModelName", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const handler = vi.fn();
    client.onRuntimeModelUpdate(handler);
    // claudebot does not receive model updates over WS — the shell calls
    // setRuntimeModelName() directly after bootstrap.
    client.setRuntimeModelName("glm-cn/glm-5.1");
    expect(handler).toHaveBeenCalledWith("glm-cn/glm-5.1");
  });

  it("dispatches session updates globally", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const globalHandler = vi.fn();
    const chatHandler = vi.fn();
    client.onSessionUpdate(globalHandler);
    client.onChat("chat-title", chatHandler);
    client.connect();
    lastSocket().fakeOpen();

    lastSocket().fakeMessage({
      type: "session.updated",
      sessionId: "chat-title",
    });

    expect(globalHandler).toHaveBeenCalledWith("chat-title", "metadata");
    expect(chatHandler).not.toHaveBeenCalled();
  });

  it("resolves newChat() immediately with a locally generated UUID", async () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    const chatId = await client.newChat(1_000);
    expect(chatId).toBeTruthy();
    // newChat sends session.activate immediately.
    expect(lastSocket().sent).toContainEqual(
      JSON.stringify({ type: "session.activate", sessionId: chatId }),
    );
  });

  it("sends workspace scope with newChat session.activate", async () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    const workspaceScope = {
      project_path: "/tmp/project",
      project_name: "project",
      access_mode: "full" as const,
      restrict_to_workspace: false,
    };
    const chatId = await client.newChat(1_000, workspaceScope);
    expect(chatId).toBeTruthy();
    // newChat sends session.activate — workspace scope is informational only.
    expect(lastSocket().sent).toContainEqual(
      JSON.stringify({ type: "session.activate", sessionId: chatId }),
    );

    // sendMessage sends chat.user_message (workspace scope not serialized).
    client.sendMessage(chatId, "hello");
    expect(lastSocket().sent).toContainEqual(
      JSON.stringify({ type: "chat.user_message", content: "hello" }),
    );
  });

  it("queues sends while connecting and flushes on open", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    client.sendMessage("chat-x", "hello");
    expect(lastSocket().sent).toEqual([]);
    lastSocket().fakeOpen();
    // handleOpen re-activates known chats and flushes the send queue.
    // sendMessage adds "chat-x" to knownChats, so handleOpen sends
    // session.activate for it, then flushes the queued chat.user_message.
    const sent = lastSocket().sent.map((s) => JSON.parse(s));
    expect(sent).toContainEqual({ type: "session.activate", sessionId: "chat-x" });
    expect(sent).toContainEqual({ type: "chat.user_message", content: "hello" });
  });

  it("sends chat.user_message without extra options (claudebot protocol)", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    // sendMessage ignores turnId, cliApps, mcpPresets, media — claudebot
    // protocol only sends {type: "chat.user_message", content}.
    client.sendMessage("chat-x", "hello", undefined, { turnId: "turn-1" });
    expect(JSON.parse(lastSocket().sent.at(-1) as string)).toEqual({
      type: "chat.user_message",
      content: "hello",
    });
  });

  it("re-attaches known chats after a reconnect", async () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: true,
      maxBackoffMs: 10,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.onChat("chat-z", () => {});
    client.connect();
    lastSocket().fakeOpen();
    expect(lastSocket().sent).toContain(
      JSON.stringify({ type: "session.activate", sessionId: "chat-z" }),
    );
    // Drop the socket.
    lastSocket().close();
    // Advance the backoff timer.
    await vi.advanceTimersByTimeAsync(20);
    const reconnected = lastSocket();
    expect(reconnected).not.toBe(FakeSocket.instances[0]);
    reconnected.fakeOpen();
    expect(reconnected.sent).toContain(
      JSON.stringify({ type: "session.activate", sessionId: "chat-z" }),
    );
  });

  it("reports status transitions through onStatus", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const seen: string[] = [];
    client.onStatus((s) => seen.push(s));
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().close();
    expect(seen).toEqual(["idle", "connecting", "open", "closed"]);
  });

  it("does not schedule a reconnect when close() is called explicitly", async () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: true,
      maxBackoffMs: 10,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const seen: string[] = [];
    client.onStatus((s) => seen.push(s));
    client.connect();
    lastSocket().fakeOpen();
    client.close();
    // Advance past any possible backoff window to prove no reconnect was scheduled.
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeSocket.instances).toHaveLength(1);
    // "reconnecting" must never appear after an intentional close.
    expect(seen).not.toContain("reconnecting");
    expect(seen.at(-1)).toBe("closed");
  });

  it("sendMessage ignores media and extra options (claudebot protocol)", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    client.sendMessage("chat-x", "look", [
      { data_url: "data:image/png;base64,AAAA", name: "shot.png" },
    ]);
    const lastFrame = JSON.parse(lastSocket().sent.at(-1) as string);
    // claudebot protocol: only type + content, no media/options.
    expect(lastFrame).toEqual({
      type: "chat.user_message",
      content: "look",
    });
  });

  it("emits a message_too_big error when the socket closes with code 1009", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const errors: Array<{ kind: string }> = [];
    client.onError((e) => errors.push(e));
    client.connect();
    lastSocket().fakeOpen();
    // Server rejected an outbound frame as too large.
    lastSocket().fakeCloseWithCode(1009);
    expect(errors).toEqual([{ kind: "message_too_big" }]);
  });

  it("emits agent.error events to the chat handler", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    // agent.error dispatches to msg.sessionId (or readyChatId fallback).
    const handler = vi.fn();
    client.onChat("chat-a", handler);
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeMessage({
      type: "agent.error",
      message: "something went wrong",
      sessionId: "chat-a",
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "error",
        chat_id: "chat-a",
        detail: "something went wrong",
      }),
    );
  });

  it("isolates throwing error handlers so reconnect bookkeeping still runs", async () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: true,
      maxBackoffMs: 5,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    // First handler explodes; subsequent reconnect state must be untouched.
    client.onError(() => {
      throw new Error("subscriber blew up");
    });
    const seenStatuses: string[] = [];
    client.onStatus((s) => seenStatuses.push(s));
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeCloseWithCode(1009);
    // Despite the throwing handler, the client must still schedule a reconnect.
    expect(seenStatuses).toContain("reconnecting");
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });

  it("does not emit a stream error on a vanilla socket close", () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const errors: Array<{ kind: string }> = [];
    client.onError((e) => errors.push(e));
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().close();
    expect(errors).toEqual([]);
  });

  it("surfaces 'reconnecting' only on an unexpected drop", async () => {
    const client = new ClaudebotClient({
      url: "ws://test",
      reconnect: true,
      maxBackoffMs: 5,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const seen: string[] = [];
    client.onStatus((s) => seen.push(s));
    client.connect();
    lastSocket().fakeOpen();
    // Simulate the remote side hanging up (no client.close() call).
    lastSocket().close();
    await vi.advanceTimersByTimeAsync(50);
    expect(seen).toContain("reconnecting");
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });
});
