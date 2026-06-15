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
let scheduleRows: Array<Record<string, unknown>>;
let notificationRows: Array<Record<string, unknown>>;

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
  listSchedules: vi.fn(async () => scheduleRows),
  fetchNotifications: vi.fn(async () => notificationRows),
  fetchMemoryStatus: vi.fn(async () => ({
    home: "/tmp/home/memory",
    longTermFile: "/tmp/home/memory/MEMORY.md",
    exists: true,
    sizeBytes: 42,
    lastDreamAt: null,
    pendingCandidates: 1,
    gitAudit: { available: true, latestCommit: null },
  })),
  runMemoryDream: vi.fn(async () => ({ dryRun: true, applied: 0, summary: "No pending candidates" })),
  markNotificationsRead: vi.fn(async () => 1),
  createSchedule: vi.fn(async () => ({ id: "sch_new", name: "new task", enabled: true, kind: "cron", cronExpr: "* * * * *", at: null, everyMs: null, timezone: "UTC", message: "new", deleteAfterRun: false, state: { nextRunAt: "2026-06-11T00:00:00.000Z", lastRunAt: null, lastStatus: null, lastError: null, runCount: 0, running: false, runningStartedAt: null, lastSkippedReason: null }, createdAt: "2026-06-11T00:00:00.000Z", updatedAt: "2026-06-11T00:00:00.000Z" })),
  updateSchedule: vi.fn(async () => undefined),
  deleteSchedule: vi.fn(async () => true),
  runScheduleNow: vi.fn(async () => ({ started: true, runId: "run_1", scheduleId: "sch_1", status: "running" })),
  fetchScheduleRuns: vi.fn(async () => [{ id: "run_1", scheduleId: "sch_1", startedAt: "2026-06-11T00:00:00.000Z", finishedAt: "2026-06-11T00:00:01.000Z", status: "succeeded", result: "ok", error: "" }]),
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
    scheduleRows = [{ id: "sch_1", name: "daily", enabled: true, kind: "cron", cronExpr: "* * * * *", at: null, everyMs: null, timezone: "UTC", message: "check", deleteAfterRun: false, state: { nextRunAt: "2026-06-11T00:00:00.000Z", lastRunAt: null, lastStatus: "succeeded", lastError: null, runCount: 1, running: false, runningStartedAt: null, lastSkippedReason: null }, createdAt: "2026-06-11T00:00:00.000Z", updatedAt: "2026-06-11T00:00:00.000Z" }];
    notificationRows = [{ id: "notif_1", source: "schedule", title: "定时任务 daily", content: "ok", status: "succeeded", scheduleId: "sch_1", runId: "run_1", delivery: { type: "webui_inbox", scope: "global" }, createdAt: "2026-06-11T00:00:01.000Z", readAt: null }];
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
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByLabelText("Tasks")).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("运行状态")).toBeInTheDocument();
    expect(screen.getByText("/tmp/workspace")).toBeInTheDocument();
    expect(screen.getAllByText("glm-5.1").length).toBeGreaterThan(0);
    expect(await screen.findByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("MEMORY.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run Dream" }));
    expect(await screen.findByText(/Dream dry-run complete/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/会话搜索暂未接入/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(await screen.findByText(/技能目录暂未接入/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(await screen.findByRole("heading", { name: "定时任务" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Name")).not.toBeInTheDocument();
    expect(screen.getByText("最近提醒")).toBeInTheDocument();
    expect(await screen.findByText("daily")).toBeInTheDocument();
    expect(screen.getByText("succeeded")).toBeInTheDocument();
    expect(screen.getAllByText("ok").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByPlaceholderText("Name")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Message")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Tasks")).not.toHaveTextContent("1"));
  });

  it("shows notification results even when their original schedule no longer exists", async () => {
    scheduleRows = [];
    notificationRows = [{ id: "notif_orphan", source: "schedule", title: "定时任务 喝水提醒", content: "喝水时间到", status: "succeeded", scheduleId: "sch_deleted", runId: "run_deleted", delivery: { type: "webui_inbox", scope: "global" }, createdAt: "2026-06-12T06:59:08.300Z", readAt: null }];

    render(<App />);
    expect(await screen.findByText("Connected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));

    expect(await screen.findByText("最近提醒")).toBeInTheDocument();
    expect(screen.getByText("喝水时间到")).toBeInTheDocument();
    expect(screen.getByText("暂无定时任务")).toBeInTheDocument();
  });

  it("shows scheduled results from notification frames without creating an inbox session", async () => {
    render(<App />);
    expect(await screen.findByText("hello preview")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(await screen.findByRole("heading", { name: "定时任务" })).toBeInTheDocument();

    act(() => {
      for (const handler of frameHandlers) {
        handler({ type: "notification.created", notification: { id: "notif_2", source: "schedule", title: "定时任务 daily", content: "scheduled result", status: "succeeded", scheduleId: "sch_1", runId: "run_2", delivery: { type: "webui_inbox", scope: "global" }, createdAt: "2026-06-11T00:01:00.000Z", readAt: null } });
      }
    });

    await waitFor(() => expect(screen.getAllByText("scheduled result").length).toBeGreaterThanOrEqual(1));
    expect(screen.getByRole("status")).toHaveTextContent("scheduled result");
    expect(screen.queryByText("Claudebot Inbox")).not.toBeInTheDocument();
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
