import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchBootstrap, fetchRuntime, fetchThreadMessages, listSessions } from "@/lib/claudebot-api";

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
          model: "glm-5.1",
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

    expect(boot.runtime.model).toBe("glm-5.1");
    expect(boot.ws.path).toBe("/ws");
    expect(boot.sessions[0]?.title).toBe("hello");
    expect(boot.activeSessionId).toBe("s1");
  });

  it("normalizes an empty lastActiveSessionId to null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      runtime: {
        home: "/tmp/home",
        workspace: "/tmp/home/workspace",
        gateway: { host: "127.0.0.1", port: 18790 },
        model: "glm-5.1",
        permissionMode: "bypassPermissions",
      },
      ws_path: "/ws",
      sessions: [],
      lastActiveSessionId: "",
    })));

    const boot = await fetchBootstrap();

    expect(boot.activeSessionId).toBeNull();
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
      return jsonResponse({ home: "/h", workspace: "/w", gateway: { host: "127.0.0.1", port: 18790 }, model: "glm-5.1", permissionMode: "bypassPermissions" });
    }));

    const runtime = await fetchRuntime();

    expect(runtime.workspace).toBe("/w");
    expect(runtime.gateway.port).toBe(18790);
  });

  it("fetchThreadMessages reads native thread messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe("/api/sessions/s1/messages");
      return jsonResponse([{ id: "m1", role: "user", content: "hi", createdAt: "2026-06-10T09:59:40.000Z", metadata: {} }]);
    }));

    const messages = await fetchThreadMessages("s1");

    expect(messages[0]).toMatchObject({ id: "m1", role: "user", content: "hi" });
  });
});
