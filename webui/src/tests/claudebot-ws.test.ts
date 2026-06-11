import { describe, expect, it, vi } from "vitest";

import { ClaudebotWsClient } from "@/lib/claudebot-ws";
import type { ServerFrame } from "@/lib/claudebot-types";

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(frame: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("ClaudebotWsClient", () => {
  it("connects, reports status, and sends chat.send frames", () => {
    let socket: FakeSocket | null = null;
    const client = new ClaudebotWsClient({
      url: "ws://127.0.0.1:18790/ws",
      socketFactory: () => {
        socket = new FakeSocket();
        return socket as unknown as WebSocket;
      },
    });
    const statuses: string[] = [];
    client.onStatus((status) => statuses.push(status));

    client.connect();
    socket?.open();
    client.sendMessage({ draftId: "draft-1", content: "hello" });

    expect(statuses).toEqual(["idle", "connecting", "open"]);
    expect(JSON.parse(socket?.sent[0] ?? "{}")).toEqual({ type: "chat.send", draftId: "draft-1", content: "hello" });
  });

  it("dispatches server frames to subscribers", () => {
    let socket: FakeSocket | null = null;
    const client = new ClaudebotWsClient({
      url: "ws://x/ws",
      socketFactory: () => {
        socket = new FakeSocket();
        return socket as unknown as WebSocket;
      },
    });
    const handler = vi.fn();
    client.onFrame(handler);

    client.connect();
    socket?.open();
    socket?.receive({
      type: "session.created",
      draftId: "draft-1",
      session: { id: "s1", title: "hello", preview: "hello", createdAt: null, updatedAt: null, messageCount: 1, status: "persisted" },
    });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: "session.created", draftId: "draft-1" }));
  });

  it("queues frames until the socket opens", () => {
    let socket: FakeSocket | null = null;
    const client = new ClaudebotWsClient({
      url: "ws://x/ws",
      socketFactory: () => {
        socket = new FakeSocket();
        return socket as unknown as WebSocket;
      },
    });

    client.connect();
    client.activateSession("s1");
    expect(socket?.sent).toEqual([]);

    socket?.open();
    expect(JSON.parse(socket?.sent[0] ?? "{}")).toEqual({ type: "session.activate", sessionId: "s1" });
  });
});
