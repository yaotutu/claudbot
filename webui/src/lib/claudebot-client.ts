// Claudebot WS client adapter: speaks claudebot's simple WS protocol but
// exposes the rich `InboundEvent` shape that the copied nanobot hooks/views
// (useClaudebotStream, ThreadShell, etc.) expect.

import type {
  ConnectionStatus,
  GoalStateWsPayload,
  InboundEvent,
} from "./types";

/** Structured errors surfaced to the UI. */
export type StreamError =
  | { kind: "message_too_big" }
  | { kind: "workspace_scope_rejected"; reason?: string; chatId?: string };

type Unsubscribe = () => void;
type EventHandler = (ev: InboundEvent) => void;
type StatusHandler = (status: ConnectionStatus) => void;
type RuntimeModelHandler = (modelName: string | null) => void;
type SessionUpdateScope = "metadata" | "thread" | string;
type SessionUpdateHandler = (
  chatId: string,
  scope?: SessionUpdateScope,
  workspaceScope?: unknown,
) => void;
type RunStatusHandler = (chatId: string, startedAt: number | null) => void;
type ErrorHandler = (error: StreamError) => void;
type MessageRole = "user" | "assistant" | "system";
type MessageAppendedHandler = (
  chatId: string,
  content: string,
  role: MessageRole,
  createdAt: string,
) => void;
type SessionRemapHandler = (oldChatId: string, newChatId: string) => void;

interface PendingNewChat {
  resolve: (chatId: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ClaudebotClientOptions {
  url: string;
  reconnect?: boolean;
  socketFactory?: (url: string) => WebSocket;
  maxBackoffMs?: number;
}

type WsOutbound =
  | { type: "session.activate"; sessionId: string }
  | { type: "chat.user_message"; content: string }
  | { type: "chat.cancel" };

type WsServerMessage =
  | { type: "session.updated"; sessionId: string }
  | { type: "message.appended"; sessionId: string; message: { id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string; metadata: Record<string, unknown> } }
  | { type: "agent.text_delta"; text: string; sessionId?: string }
  | { type: "agent.thinking_delta"; thinking: string; sessionId?: string }
  | { type: "agent.tool_start"; id: string; name: string; input: unknown; sessionId?: string }
  | { type: "agent.tool_result"; id: string; output: unknown; isError: boolean; sessionId?: string }
  | { type: "agent.status"; status: string; sessionId?: string }
  | { type: "agent.turn_done"; sessionId: string; isError: boolean; result: string; totalCostUsd?: number }
  | { type: "agent.error"; message: string; sessionId?: string }
  | { type: "schedule.delivered"; scheduleId: string; status: "succeeded" | "failed" };

const WS_OPEN = 1;
const WS_CLOSING = 2;

function defaultSocketFactory(url: string): WebSocket {
  return new WebSocket(url);
}

export class ClaudebotClient {
  private socket: WebSocket | null = null;
  private statusHandlers = new Set<StatusHandler>();
  private runtimeModelHandlers = new Set<RuntimeModelHandler>();
  private sessionUpdateHandlers = new Set<SessionUpdateHandler>();
  private runStatusHandlers = new Set<RunStatusHandler>();
  private errorHandlers = new Set<ErrorHandler>();
  private messageAppendedHandlers = new Set<MessageAppendedHandler>();
  private sessionRemapHandlers = new Set<SessionRemapHandler>();
  private chatHandlers = new Map<string, Set<EventHandler>>();
  private pendingInboundByChat = new Map<string, InboundEvent[]>();
  private static readonly PENDING_INBOUND_MAX = 2000;
  private knownChats = new Set<string>();
  /** Chat IDs created by newChat() that haven't been remapped to a real SDK ID yet. */
  private pendingChatIds = new Set<string>();
  private runStartedAtByChatId = new Map<string, number>();
  private goalStateByChatId = new Map<string, GoalStateWsPayload>();
  private pendingNewChat: PendingNewChat | null = null;
  private sendQueue: WsOutbound[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly shouldReconnect: boolean;
  private readonly maxBackoffMs: number;
  private socketFactory: (url: string) => WebSocket;
  private currentUrl: string;
  private status_: ConnectionStatus = "idle";
  private readyChatId: string | null = null;
  /**
   * The chat the user most recently activated. We use this as the routing
   * key for streaming events so a stale `sessionId` on a wire frame can't
   * make deltas land in the wrong thread.
   */
  private currentChatId: string | null = null;
  private intentionallyClosed = false;
  private modelName: string | null = null;

  constructor(options: ClaudebotClientOptions) {
    this.shouldReconnect = options.reconnect ?? true;
    this.maxBackoffMs = options.maxBackoffMs ?? 15_000;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.currentUrl = options.url;
  }

  get status(): ConnectionStatus {
    return this.status_;
  }

  get defaultChatId(): string | null {
    return this.readyChatId;
  }

  get runtimeModelName(): string | null {
    return this.modelName;
  }

  setRuntimeModelName(name: string | null): void {
    if (this.modelName === name) return;
    this.modelName = name;
    this.emitRuntimeModelUpdate(name);
  }

  updateUrl(url: string, socketFactory?: (url: string) => WebSocket): void {
    this.currentUrl = url;
    if (socketFactory) this.socketFactory = socketFactory;
  }

  onStatus(handler: StatusHandler): Unsubscribe {
    this.statusHandlers.add(handler);
    handler(this.status_);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  onRuntimeModelUpdate(handler: RuntimeModelHandler): Unsubscribe {
    this.runtimeModelHandlers.add(handler);
    handler(this.modelName);
    return () => {
      this.runtimeModelHandlers.delete(handler);
    };
  }

  onSessionUpdate(handler: SessionUpdateHandler): Unsubscribe {
    this.sessionUpdateHandlers.add(handler);
    return () => {
      this.sessionUpdateHandlers.delete(handler);
    };
  }

  onRunStatus(handler: RunStatusHandler): Unsubscribe {
    this.runStatusHandlers.add(handler);
    for (const [chatId, startedAt] of this.runStartedAtByChatId) {
      handler(chatId, startedAt);
    }
    return () => {
      this.runStatusHandlers.delete(handler);
    };
  }

  onError(handler: ErrorHandler): Unsubscribe {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to message.appended events for any chat. The handler is
   * called with the chatId, full content, role, and createdAt — enough
   * for the sidebar to update its local session state (preview, updatedAt)
   * without a server roundtrip.
   */
  onMessageAppended(handler: MessageAppendedHandler): Unsubscribe {
    this.messageAppendedHandlers.add(handler);
    return () => {
      this.messageAppendedHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to session remap events. Fired when the server assigns a
   * real SDK session ID that replaces a local placeholder UUID (created
   * by newChat). Subscribers should update their key mappings.
   */
  onSessionRemap(handler: SessionRemapHandler): Unsubscribe {
    this.sessionRemapHandlers.add(handler);
    return () => {
      this.sessionRemapHandlers.delete(handler);
    };
  }

  getRunStartedAt(chatId: string): number | null {
    const v = this.runStartedAtByChatId.get(chatId);
    return v === undefined ? null : v;
  }

  getGoalState(chatId: string): GoalStateWsPayload | undefined {
    return this.goalStateByChatId.get(chatId);
  }

  /** Notify subscribers that a session's metadata changed (e.g. new title). */
  emitSessionUpdate(chatId: string, scope: SessionUpdateScope = "metadata"): void {
    for (const handler of this.sessionUpdateHandlers) {
      try { handler(chatId, scope); } catch { /* ignore */ }
    }
  }

  onChat(chatId: string, handler: EventHandler): Unsubscribe {
    let handlers = this.chatHandlers.get(chatId);
    if (!handlers) {
      handlers = new Set();
      this.chatHandlers.set(chatId, handlers);
    }
    handlers.add(handler);
    const pending = this.pendingInboundByChat.get(chatId);
    if (pending !== undefined && pending.length > 0) {
      const flushed = pending.splice(0);
      this.pendingInboundByChat.delete(chatId);
      for (const ev of flushed) {
        handler(ev);
      }
    }
    this.attach(chatId);
    return () => {
      const current = this.chatHandlers.get(chatId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.chatHandlers.delete(chatId);
    };
  }

  connect(): void {
    if (this.socket && this.socket.readyState < WS_CLOSING) return;
    this.intentionallyClosed = false;
    this.setStatus("connecting");
    const sock = this.socketFactory(this.currentUrl);
    this.socket = sock;
    sock.onopen = () => this.handleOpen();
    sock.onmessage = (ev) => this.handleMessage(ev);
    sock.onerror = () => this.setStatus("error");
    sock.onclose = (ev) => this.handleClose(ev);
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.socket;
    this.socket = null;
    try { sock?.close(); } catch { /* ignore */ }
    this.setStatus("closed");
  }

  /**
   * Prepare a new chat context. Returns a local UUID immediately.
   *
   * In the jsonl-backed model, sessions are created by the SDK when the first
   * user message is sent — there is no REST POST /api/sessions. We generate a
   * local UUID, activate it over WS (so the server clears lastActiveSession),
   * and return it. The real SDK session UUID is assigned on the first message.
   */
  newChat(_timeoutMs: number = 5_000, _workspaceScope?: unknown): Promise<string> {
    const chatId = crypto.randomUUID();
    this.knownChats.add(chatId);
    this.pendingChatIds.add(chatId);
    // Activate over WS so the server clears its lastActiveSession — the next
    // user message will create a fresh SDK session instead of resuming.
    this.queueSend({ type: "session.activate", sessionId: chatId });
    this.readyChatId = chatId;
    this.currentChatId = chatId;
    return Promise.resolve(chatId);
  }

  attach(chatId: string): void {
    this.knownChats.add(chatId);
    this.currentChatId = chatId;
    if (this.socket?.readyState === WS_OPEN) {
      this.queueSend({ type: "session.activate", sessionId: chatId });
    }
  }

  /**
   * Send a user message on the given chat_id.
   *
   * Claudebot's protocol takes the active session from the most recent
   * `session.activate` frame, so the chatId is informational here.
   */
  sendMessage(
    chatId: string,
    content: string,
    _media?: unknown,
    _options?: unknown,
  ): void {
    this.knownChats.add(chatId);
    this.queueSend({ type: "chat.user_message", content });
  }

  cancel(_chatId: string): void {
    this.queueSend({ type: "chat.cancel" });
  }

  // -- internals ---------------------------------------------------------

  private setStatus(status: ConnectionStatus): void {
    if (this.status_ === status) return;
    this.status_ = status;
    for (const handler of this.statusHandlers) handler(status);
  }

  private handleOpen(): void {
    this.setStatus("open");
    this.reconnectAttempts = 0;
    // Re-activate every known chat so deliveries continue routing after a drop.
    for (const chatId of this.knownChats) {
      this.rawSend({ type: "session.activate", sessionId: chatId });
    }
    const queued = this.sendQueue.splice(0);
    for (const frame of queued) this.rawSend(frame);
  }

  private handleMessage(ev: MessageEvent): void {
    let parsed: WsServerMessage;
    try {
      parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "") as WsServerMessage;
    } catch {
      return;
    }
    this.dispatchServerMessage(parsed);
  }

  private dispatchServerMessage(msg: WsServerMessage): void {
    // Detect server-assigned session ID and remap from local placeholder.
    // When the user creates a new chat, newChat() generates a local UUID.
    // The SDK assigns its own session ID on the first message. This remap
    // keeps the UI's routing consistent so the sidebar doesn't show two entries.
    // Guard: only remap if currentChatId is still a pending placeholder —
    // prevents stale events from an old session corrupting a brand-new chat.
    const serverSid = ("sessionId" in msg) ? (msg as { sessionId?: string }).sessionId : undefined;
    if (serverSid && this.currentChatId && serverSid !== this.currentChatId && this.pendingChatIds.has(this.currentChatId)) {
      this.remapChatId(this.currentChatId, serverSid);
    }

    // Use `currentChatId` (set by `attach`/`newChat`) as the routing key for
    // streaming events. After remap, this is the real SDK session ID.
    const rid = this.currentChatId ?? "";
    switch (msg.type) {
      case "session.updated": {
        this.emitSessionUpdate(msg.sessionId, "metadata");
        return;
      }
      case "message.appended": {
        // Notify message-appended subscribers (e.g. the sidebar) so they
        // can update local state for the affected session. We intentionally
        // do NOT translate this to session.updated — that caused the
        // sidebar to refetch the full list on every message, which the
        // browser's per-origin concurrent-request cap then choked on.
        // The full message content is in the event payload, so subscribers
        // can update locally without a server roundtrip.
        this.fireMessageAppended(
          msg.sessionId,
          msg.message.content,
          msg.message.role,
          msg.message.createdAt,
        );
        // The user message is added optimistically in the client's send()
        // path, and echoed back here by the server. Don't dispatch the
        // echo as a streaming event — the hook would re-render it as an
        // assistant bubble.
        if (msg.message.role === "user") return;
        // Regular assistant responses are already delivered via streaming
        // text_delta events — dispatching them again here as "progress"
        // causes duplicate content and spurious "Working" trace rows.
        // Only dispatch non-streaming sources (e.g. scheduled task results
        // identified by metadata.source).
        if (!msg.message.metadata?.source) return;
        const inbound: InboundEvent = {
          event: "message",
          chat_id: msg.sessionId,
          text: msg.message.content,
          kind: "progress",
        };
        this.dispatch(msg.sessionId, inbound);
        return;
      }
      case "agent.text_delta": {
        this.dispatch(rid, { event: "delta", chat_id: rid, text: msg.text });
        return;
      }
      case "agent.thinking_delta": {
        this.dispatch(rid, { event: "reasoning_delta", chat_id: rid, text: msg.thinking });
        return;
      }
      case "agent.tool_start": {
        this.dispatch(rid, {
          event: "message",
          chat_id: rid,
          text: "",
          tool_events: [
            {
              phase: "start",
              call_id: msg.id,
              name: msg.name,
              arguments: msg.input,
            },
          ],
          kind: "tool_hint",
        });
        return;
      }
      case "agent.tool_result": {
        this.dispatch(rid, {
          event: "message",
          chat_id: rid,
          text: "",
          tool_events: [
            {
              phase: msg.isError ? "error" : "end",
              call_id: msg.id,
              result: msg.output,
              error: msg.isError ? msg.output : undefined,
            },
          ],
          kind: "tool_hint",
        });
        return;
      }
      case "agent.status": {
        const running = /run|think|stream/i.test(msg.status);
        if (running) {
          const startedAt = Math.floor(Date.now() / 1000);
          this.runStartedAtByChatId.set(rid, startedAt);
          this.emitRunStatus(rid, startedAt);
          this.dispatch(rid, { event: "goal_status", chat_id: rid, status: "running", started_at: startedAt });
        }
        return;
      }
      case "agent.turn_done": {
        if (this.runStartedAtByChatId.has(rid)) {
          this.runStartedAtByChatId.delete(rid);
          this.emitRunStatus(rid, null);
        }
        const goalState: GoalStateWsPayload = { active: false };
        this.goalStateByChatId.set(rid, goalState);
        this.dispatch(rid, { event: "turn_end", chat_id: rid, goal_state: goalState });
        this.emitSessionUpdate(rid, "thread");
        return;
      }
      case "agent.error": {
        const sid = msg.sessionId ?? this.readyChatId ?? "";
        this.dispatch(sid, { event: "error", chat_id: sid, detail: msg.message });
        return;
      }
      case "schedule.delivered": {
        return;
      }
    }
  }

  private emitRuntimeModelUpdate(modelName: string | null): void {
    for (const handler of this.runtimeModelHandlers) handler(modelName);
  }

  private emitRunStatus(chatId: string, startedAt: number | null): void {
    for (const handler of this.runStatusHandlers) handler(chatId, startedAt);
  }

  private dispatch(chatId: string, ev: InboundEvent): void {
    if (!chatId) return;
    const handlers = this.chatHandlers.get(chatId);
    if (handlers !== undefined && handlers.size > 0) {
      for (const h of handlers) {
        try { h(ev); } catch { /* swallow */ }
      }
      return;
    }
    let q = this.pendingInboundByChat.get(chatId);
    if (!q) {
      q = [];
      this.pendingInboundByChat.set(chatId, q);
    }
    q.push(ev);
    const over = q.length - ClaudebotClient.PENDING_INBOUND_MAX;
    if (over > 0) q.splice(0, over);
  }

  private handleClose(event?: { code?: number }): void {
    this.socket = null;
    if (this.pendingNewChat) {
      clearTimeout(this.pendingNewChat.timer);
      this.pendingNewChat.reject(new Error("socket closed"));
      this.pendingNewChat = null;
    }
    if (event?.code === 1009) {
      this.emitError({ kind: "message_too_big" });
    }
    if (this.intentionallyClosed || !this.shouldReconnect) {
      this.setStatus("closed");
      return;
    }
    this.scheduleReconnect();
  }

  private emitError(error: StreamError): void {
    for (const handler of this.errorHandlers) {
      try { handler(error); } catch { /* best-effort */ }
    }
  }

  private fireMessageAppended(
    chatId: string,
    content: string,
    role: MessageRole,
    createdAt: string,
  ): void {
    for (const handler of this.messageAppendedHandlers) {
      try { handler(chatId, content, role, createdAt); } catch { /* best-effort */ }
    }
  }

  /**
   * Remap all internal state from a local placeholder chatId to the real
   * SDK-assigned session ID. Moves handlers, pending events, and notifies
   * subscribers so the UI can update its key mappings.
   */
  private remapChatId(oldId: string, newId: string): void {
    if (oldId === newId) return;
    // Move chat handlers
    const oldHandlers = this.chatHandlers.get(oldId);
    if (oldHandlers) {
      const existing = this.chatHandlers.get(newId);
      if (existing) {
        for (const h of oldHandlers) existing.add(h);
      } else {
        this.chatHandlers.set(newId, oldHandlers);
      }
      this.chatHandlers.delete(oldId);
    }
    // Move pending inbound
    const oldPending = this.pendingInboundByChat.get(oldId);
    if (oldPending && oldPending.length > 0) {
      const newPending = this.pendingInboundByChat.get(newId);
      if (newPending) {
        newPending.push(...oldPending);
      } else {
        this.pendingInboundByChat.set(newId, oldPending);
      }
      this.pendingInboundByChat.delete(oldId);
    }
    // Update known chats
    this.knownChats.delete(oldId);
    this.knownChats.add(newId);
    // Clear pending marker — this ID is now a real SDK session
    this.pendingChatIds.delete(oldId);
    // Update current/ready references
    if (this.currentChatId === oldId) this.currentChatId = newId;
    if (this.readyChatId === oldId) this.readyChatId = newId;
    // Move run-started tracking
    const runStarted = this.runStartedAtByChatId.get(oldId);
    if (runStarted !== undefined) {
      this.runStartedAtByChatId.set(newId, runStarted);
      this.runStartedAtByChatId.delete(oldId);
    }
    // Move goal state
    const goalState = this.goalStateByChatId.get(oldId);
    if (goalState) {
      this.goalStateByChatId.set(newId, goalState);
      this.goalStateByChatId.delete(oldId);
    }
    // Notify subscribers
    for (const handler of this.sessionRemapHandlers) {
      try { handler(oldId, newId); } catch { /* ignore */ }
    }
  }

  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    const attempt = this.reconnectAttempts++;
    const delay = Math.min(500 * 2 ** attempt, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private queueSend(frame: WsOutbound): void {
    if (this.socket?.readyState === WS_OPEN) {
      this.rawSend(frame);
    } else {
      this.sendQueue.push(frame);
    }
  }

  private rawSend(frame: WsOutbound): void {
    if (!this.socket) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      this.sendQueue.push(frame);
    }
  }
}
