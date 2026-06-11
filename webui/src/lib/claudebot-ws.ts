import type { ClientFrame, ServerFrame } from "./claudebot-types";

export type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

type Unsubscribe = () => void;
type StatusHandler = (status: ConnectionStatus) => void;
type FrameHandler = (frame: ServerFrame) => void;

export type ClaudebotWsClientOptions = {
  url: string;
  socketFactory?: (url: string) => WebSocket;
};

const WS_OPEN = 1;

export class ClaudebotWsClient {
  private socket: WebSocket | null = null;
  private queue: ClientFrame[] = [];
  private status: ConnectionStatus = "idle";
  private statusHandlers = new Set<StatusHandler>();
  private frameHandlers = new Set<FrameHandler>();
  private socketFactory: (url: string) => WebSocket;

  constructor(private readonly options: ClaudebotWsClientOptions) {
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
  }

  connect(): void {
    if (this.socket && this.socket.readyState === WS_OPEN) return;
    this.setStatus("connecting");
    const socket = this.socketFactory(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      this.setStatus("open");
      this.flushQueue();
    };
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onerror = () => this.setStatus("error");
    socket.onclose = () => {
      this.socket = null;
      this.setStatus("closed");
    };
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.queue = [];
    try {
      socket?.close();
    } catch {
      // best effort
    }
    this.setStatus("closed");
  }

  onStatus(handler: StatusHandler): Unsubscribe {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  onFrame(handler: FrameHandler): Unsubscribe {
    this.frameHandlers.add(handler);
    return () => {
      this.frameHandlers.delete(handler);
    };
  }

  activateSession(sessionId: string | null): void {
    this.sendFrame({ type: "session.activate", sessionId });
  }

  sendMessage(input: { sessionId?: string; draftId?: string; content: string }): void {
    this.sendFrame({ type: "chat.send", ...input });
  }

  cancel(sessionId: string): void {
    this.sendFrame({ type: "chat.cancel", sessionId });
  }

  private sendFrame(frame: ClientFrame): void {
    if (this.socket?.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(frame));
      return;
    }
    this.queue.push(frame);
  }

  private flushQueue(): void {
    const pending = this.queue.splice(0);
    for (const frame of pending) this.sendFrame(frame);
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(event.data) as ServerFrame;
    } catch {
      return;
    }
    for (const handler of this.frameHandlers) {
      handler(frame);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }
}
