import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App";
import type { ServerFrame, WebuiBootstrap } from "@/lib/claudebot-types";

const frameHandlers = new Set<(frame: ServerFrame) => void>();
const sendMessage = vi.fn();
const activateSession = vi.fn();
const connect = vi.fn();
const close = vi.fn();
let bootstrapPayload: WebuiBootstrap;

function persistedBootstrap(): WebuiBootstrap {
  return {
    runtime: { home: "/tmp/home", workspace: "/tmp/workspace", gateway: { host: "127.0.0.1", port: 18790 }, model: "glm-5.1", permissionMode: "bypassPermissions" },
    ws: { path: "/ws" },
    activeSessionId: "s1",
    sessions: [{ id: "s1", title: "hello", preview: "hello preview", createdAt: null, updatedAt: null, messageCount: 1, status: "persisted" }],
  };
}

vi.mock("@/lib/claudebot-api", () => ({
  fetchBootstrap: vi.fn(async () => bootstrapPayload),
  fetchThreadMessages: vi.fn(async () => [{ id: "m1", role: "user", content: "hello", createdAt: "2026-06-10T09:59:40.000Z", metadata: {} }]),
  deleteSession: vi.fn(async () => true),
  renameSession: vi.fn(async () => undefined),
}));

vi.mock("@/lib/claudebot-ws", () => ({
  ClaudebotWsClient: vi.fn().mockImplementation(() => ({
    connect,
    close,
    sendMessage,
    activateSession,
    onFrame: (handler: (frame: ServerFrame) => void) => {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    },
    onStatus: (handler: (status: string) => void) => {
      handler("open");
      return () => undefined;
    },
  })),
}));

describe("App native layout", () => {
  beforeEach(() => {
    bootstrapPayload = persistedBootstrap();
    frameHandlers.clear();
    sendMessage.mockClear();
    activateSession.mockClear();
    connect.mockClear();
    close.mockClear();
  });

  it("renders persisted sessions and visible MVP panels", async () => {
    render(<App />);

    expect((await screen.findAllByText("hello")).length).toBeGreaterThan(0);
    expect(screen.getByText("hello preview")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("运行状态")).toBeInTheDocument();
    expect(screen.getByText("/tmp/workspace")).toBeInTheDocument();
    expect(screen.getAllByText("glm-5.1").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/会话搜索暂未接入/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(await screen.findByText(/技能目录暂未接入/)).toBeInTheDocument();
  });

  it("creates a draft chat and sends through native websocket frames", async () => {
    render(<App />);
    expect((await screen.findAllByText("hello")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.change(screen.getByPlaceholderText("Ask anything..."), { target: { value: "ping" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "ping" }));
    expect(await screen.findByText("ping")).toBeInTheDocument();

    const sentDraftId = sendMessage.mock.calls[0]?.[0]?.draftId as string;
    expect(sentDraftId).toMatch(/^draft-/);

    act(() => {
      for (const handler of frameHandlers) {
        handler({ type: "session.created", draftId: sentDraftId, session: { id: "s2", title: "ping", preview: "ping", createdAt: null, updatedAt: null, messageCount: 1, status: "persisted" } });
        handler({ type: "run.started", sessionId: "s2", runId: "r1" });
        handler({ type: "run.delta", sessionId: "s2", runId: "r1", text: "pong" });
        handler({ type: "run.completed", sessionId: "s2", runId: "r1", isError: false });
      }
    });

    await waitFor(() => expect(screen.getByText("pong")).toBeInTheDocument());
  });

  it("allows typing on the empty landing screen before clicking New chat", async () => {
    bootstrapPayload = { ...persistedBootstrap(), activeSessionId: null, sessions: [] };

    render(<App />);

    const input = await screen.findByPlaceholderText("Ask anything...");
    await waitFor(() => expect(input).not.toBeDisabled());

    fireEvent.change(input, { target: { value: "start from landing" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "start from landing", draftId: expect.stringMatching(/^draft-/) }));
    expect(await screen.findByText("start from landing")).toBeInTheDocument();
  });
});
