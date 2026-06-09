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
  private chatHandlers = new Map<string, Set<EventHandler>>();
  private pendingInboundByChat = new Map<string, InboundEvent[]>();
  private static readonly PENDING_INBOUND_MAX = 2000;
  private knownChats = new Set<string>();
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
   * The claudebot session id the user most recently activated. The server
   * forwards Claude SDK events with `sessionId` set to the *Claude* session
   * (a different UUID), so we can't trust that field for routing. We
   * instead fan agent.* events out to the last attached claudebot session.
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
   * Ask the server to provision a new chat_id; resolves with the assigned id.
   *
   * Claudebot doesn't have a WS `new_chat` envelope — it has REST POST /api/sessions
   * that returns a session object, then we attach over WS.
   */
  newChat(timeoutMs: number = 5_000, _workspaceScope?: unknown): Promise<string> {
    if (this.pendingNewChat) {
      return Promise.reject(new Error("newChat already in flight"));
    }
    return new Promise<string>(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNewChat = null;
        reject(new Error("newChat timed out"));
      }, timeoutMs);
      this.pendingNewChat = { resolve, reject, timer };
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "" }),
        });
        if (!res.ok) throw new Error(`createSession HTTP ${res.status}`);
        const session = (await res.json()) as { id: string };
        if (this.pendingNewChat) {
          clearTimeout(this.pendingNewChat.timer);
          this.pendingNewChat = null;
        }
        this.knownChats.add(session.id);
        // Activate over WS so subsequent chat events for this session route here.
        this.queueSend({ type: "session.activate", sessionId: session.id });
        // Also synthesize a ready event so any pending waiters settle.
        this.readyChatId = session.id;
        // Set currentChatId so streaming events arriving before any explicit
        // attach() (e.g. text_delta from an in-flight turn) still route.
        this.currentChatId = session.id;
        resolve(session.id);
      } catch (e) {
        if (this.pendingNewChat) {
          clearTimeout(this.pendingNewChat.timer);
          this.pendingNewChat = null;
        }
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
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
    // The `sessionId` on agent.* frames is the Claude SDK session, NOT the
    // claudebot session the user activated. We use `currentChatId` (set by
    // `attach`/`newChat`) as the routing key for streaming events.
    const rid = this.currentChatId ?? "";
    switch (msg.type) {
      case "session.updated": {
        this.emitSessionUpdate(msg.sessionId, "metadata");
        return;
      }
      case "message.appended": {
        this.emitSessionUpdate(msg.sessionId, "thread");
        const inbound: InboundEvent = {
          event: "message",
          chat_id: msg.sessionId,
          text: msg.message.content,
          kind: msg.message.role === "user" ? undefined : "progress",
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
