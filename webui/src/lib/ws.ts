// WebSocket client for the claudebot gateway.

import type { WsClientMessage, WsServerMessage } from "./protocol";

export type StreamHandlers = {
  onMessage: (m: WsServerMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
};

export class ClaudebotStream {
  private ws: WebSocket | null = null;
  private handlers: StreamHandlers;
  private url: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(handlers: StreamHandlers) {
    this.handlers = handlers;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.url = `${proto}//${window.location.host}/ws`;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => this.handlers.onOpen?.();
    ws.onclose = () => {
      this.handlers.onClose?.();
      this.scheduleReconnect();
    };
    ws.onerror = (e) => this.handlers.onError?.(e);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WsServerMessage;
        this.handlers.onMessage(msg);
      } catch {
        // ignore malformed
      }
    };
  }

  send(msg: WsClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      // queue or drop — MVP just drops
    }
  }

  close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }
}
