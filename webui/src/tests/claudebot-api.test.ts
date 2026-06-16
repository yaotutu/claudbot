import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSchedule,
  deleteSchedule,
  fetchBootstrap,
  fetchRuntime,
  fetchMemoryStatus,
  fetchNotifications,
  fetchScheduleRuns,
  fetchThreadMessages,
  listSchedules,
  listSessions,
  markNotificationsRead,
  runMemoryDream,
  runScheduleNow,
  updateSchedule,
} from "@/lib/claudebot-api";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("claudebot native API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchBootstrap reads runtime, sessions, websocket path, and active session", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe("/webui/bootstrap");
      return jsonResponse({
        runtime: {
          home: "/tmp/home",
          workspace: "/tmp/home/workspace",
          gateway: { host: "0.0.0.0", port: 18790 },
          model: "sonnet",
          providerModel: "glm-4.7",
          permissionMode: "bypassPermissions",
        },
        ws: { path: "/ws" },
        sessions: [{
          id: "s1",
          title: "hello",
          preview: "hello",
          createdAt: "2026-06-10T09:59:40.000Z",
          updatedAt: "2026-06-10T09:59:45.000Z",
          messageCount: 2,
          status: "persisted",
        }],
        activeSessionId: "s1",
      });
    }));

    const boot = await fetchBootstrap();

    expect(boot.runtime.model).toBe("sonnet");
    expect(boot.runtime.providerModel).toBe("glm-4.7");
    expect(boot.ws.path).toBe("/ws");
    expect(boot.sessions[0]?.title).toBe("hello");
    expect(boot.activeSessionId).toBe("s1");
  });

  it("normalizes an empty activeSessionId to null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      runtime: {
        home: "/tmp/home",
        workspace: "/tmp/home/workspace",
        gateway: { host: "127.0.0.1", port: 18790 },
        model: "sonnet",
        providerModel: "glm-4.7",
        permissionMode: "bypassPermissions",
      },
      ws: { path: "/ws" },
      sessions: [],
      activeSessionId: "",
    })));

    const boot = await fetchBootstrap();

    expect(boot.activeSessionId).toBeNull();
  });

  it("rejects legacy bootstrap shapes instead of adapting old contracts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      config: {
        home: "/tmp/home",
        workspace: { path: "/tmp/home/workspace" },
        gateway: { host: "127.0.0.1", port: 18790 },
        claudeCode: { model: "sonnet", providerModel: "glm-4.7", permissionMode: "bypassPermissions" },
      },
      model_name: "sonnet",
      ws_path: "/ws",
      sessions: [],
      lastActiveSessionId: "s1",
    })));

    await expect(fetchBootstrap()).rejects.toThrow(/bootstrap/i);
  });

  it("listSessions reads canonical summaries", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe("/api/sessions");
      return jsonResponse([{ id: "s1", title: "hello", preview: "hello", createdAt: null, updatedAt: null, messageCount: 1, status: "persisted" }]);
    }));

    const sessions = await listSessions();

    expect(sessions).toEqual([{ id: "s1", title: "hello", preview: "hello", createdAt: null, updatedAt: null, messageCount: 1, status: "persisted" }]);
  });

  it("fetchRuntime reads read-only runtime info", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe("/api/runtime");
      return jsonResponse({ home: "/h", workspace: "/w", gateway: { host: "127.0.0.1", port: 18790 }, model: "sonnet", providerModel: "glm-4.7", permissionMode: "bypassPermissions" });
    }));

    const runtime = await fetchRuntime();

    expect(runtime.workspace).toBe("/w");
    expect(runtime.gateway.port).toBe(18790);
    expect(runtime.providerModel).toBe("glm-4.7");
  });

  it("fetches memory status and runs dream", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "/api/memory/status") {
        return jsonResponse({
          home: "/tmp/home/memory",
          longTermFile: "/tmp/home/memory/MEMORY.md",
          exists: true,
          sizeBytes: 42,
          lastDreamAt: null,
          pendingCandidates: 1,
          gitAudit: { available: true, latestCommit: null },
        });
      }
      if (String(url) === "/api/memory/dream" && init?.method === "POST") {
        return jsonResponse({ dryRun: true, applied: 0, summary: "No pending candidates" });
      }
      throw new Error(`unexpected ${String(url)}`);
    }));

    expect((await fetchMemoryStatus()).longTermFile).toContain("MEMORY.md");
    expect((await runMemoryDream({ dryRun: true })).summary).toBe("No pending candidates");
  });

  it("fetchThreadMessages reads native thread messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe("/api/sessions/s1/messages");
      return jsonResponse([{ id: "m1", role: "user", content: "hi", createdAt: "2026-06-10T09:59:40.000Z", metadata: {} }]);
    }));

    const messages = await fetchThreadMessages("s1");

    expect(messages[0]).toMatchObject({ id: "m1", role: "user", content: "hi" });
  });

  it("manages schedules through native scheduler endpoints", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(url) === "/api/schedules" && !init?.method) {
        return jsonResponse([{ id: "sch_1", name: "daily", enabled: true, kind: "cron", cronExpr: "* * * * *", at: null, everyMs: null, timezone: "UTC", message: "check", deleteAfterRun: false, state: { nextRunAt: "2026-06-11T00:00:00.000Z", lastRunAt: null, lastStatus: null, lastError: null, runCount: 0, running: false, runningStartedAt: null, lastSkippedReason: null }, createdAt: "2026-06-11T00:00:00.000Z", updatedAt: "2026-06-11T00:00:00.000Z" }]);
      }
      if (String(url) === "/api/schedule-runs?scheduleId=sch_1") {
        return jsonResponse([{ id: "run_1", scheduleId: "sch_1", startedAt: "2026-06-11T00:00:00.000Z", finishedAt: null, status: "running", result: "", error: "" }]);
      }
      if (String(url) === "/api/schedules/sch_1" && init?.method === "DELETE") return jsonResponse({ deleted: "sch_1" });
      if (String(url) === "/api/schedules/sch_1/run-now" && init?.method === "POST") return jsonResponse({ started: true, runId: "run_1", scheduleId: "sch_1", status: "running" });
      return jsonResponse({ id: "sch_1", name: "daily", enabled: true, kind: "cron", cronExpr: "* * * * *", at: null, everyMs: null, timezone: "UTC", message: "check", deleteAfterRun: false, state: { nextRunAt: "2026-06-11T00:00:00.000Z", lastRunAt: null, lastStatus: null, lastError: null, runCount: 0, running: false, runningStartedAt: null, lastSkippedReason: null }, createdAt: "2026-06-11T00:00:00.000Z", updatedAt: "2026-06-11T00:00:00.000Z" });
    }));

    expect((await listSchedules())[0]?.id).toBe("sch_1");
    await createSchedule({ name: "daily", message: "check", cronExpr: "* * * * *", timezone: "UTC" });
    await updateSchedule("sch_1", { enabled: false, message: "updated" });
    await expect(runScheduleNow("sch_1")).resolves.toEqual({ started: true, runId: "run_1", scheduleId: "sch_1", status: "running" });
    expect((await fetchScheduleRuns("sch_1"))[0]?.id).toBe("run_1");
    expect(await deleteSchedule("sch_1")).toBe(true);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /api/schedules",
      "POST /api/schedules",
      "PATCH /api/schedules/sch_1",
      "POST /api/schedules/sch_1/run-now",
      "GET /api/schedule-runs?scheduleId=sch_1",
      "DELETE /api/schedules/sch_1",
    ]);
  });

  it("fetchNotifications reads WebUI delivery records", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe("/api/notifications");
      return jsonResponse([{
        id: "notif_1",
        source: "schedule",
        title: "定时任务 daily",
        content: "daily result",
        status: "succeeded",
        scheduleId: "sch_1",
        runId: "run_1",
        delivery: { type: "webui_inbox", scope: "global" },
        createdAt: "2026-06-11T00:00:01.000Z",
        readAt: null,
      }]);
    }));

    const notifications = await fetchNotifications();

    expect(notifications[0]).toMatchObject({ id: "notif_1", content: "daily result", scheduleId: "sch_1" });
  });

  it("markNotificationsRead posts to the WebUI notification read endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("/api/notifications/read-all");
      expect(init?.method).toBe("POST");
      return jsonResponse({ updated: 3 });
    }));

    await expect(markNotificationsRead()).resolves.toBe(3);
  });
});
