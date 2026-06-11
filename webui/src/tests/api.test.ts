import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteSession,
  fetchClaudeCodeHealth,
  fetchClaudeCodeSettings,
  fetchFilePreview,
  fetchSessionAutomations,
  fetchSettings,
  fetchSettingsUsage,
  fetchSidebarState,
  fetchSkillDetail,
  fetchSkills,
  fetchWebuiThread,
  fetchWorkspaces,
  listSessions,
  listSlashCommands,
  updateClaudeCodeSettings,
  updateSidebarState,
  updateNetworkSafetySettings,
  updateSettings,
} from "@/lib/api";

describe("webui API helpers", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // -- Functions that make real HTTP calls (request()) --

  it("listSessions calls GET /api/sessions and maps rows", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: "sess-1",
          title: "Test session",
          preview: "Hello",
          createdAt: "2026-05-01T10:00:00Z",
          updatedAt: "2026-05-01T10:01:00Z",
        },
      ],
    } as Response);

    const sessions = await listSessions("tok");
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      key: "websocket:sess-1",
      channel: "websocket",
      chatId: "sess-1",
      title: "Test session",
      preview: "Hello",
    });
  });

  it("fetchWebuiThread calls GET /api/sessions/:id/messages", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => [
        { id: "m1", role: "user", content: "hello", createdAt: "2026-01-01T00:00:00Z" },
        { id: "m2", role: "assistant", content: "world", createdAt: "2026-01-01T00:00:01Z" },
      ],
    } as Response);

    const result = await fetchWebuiThread("tok", "websocket:sess-1");
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions/sess-1/messages",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0]).toMatchObject({ role: "user", content: "hello" });
    expect(result!.messages[1]).toMatchObject({ role: "assistant", content: "world" });
  });

  it("fetchWebuiThread returns null on 404", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "not found",
    } as Response);

    const result = await fetchWebuiThread("tok", "websocket:missing");
    expect(result).toBeNull();
  });

  it("deleteSession calls DELETE /api/sessions/:id", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ deleted: true }),
    } as Response);

    const deleted = await deleteSession("tok", "websocket:sess-1");
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions/sess-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(deleted).toBe(true);
  });

  // -- Stub functions (no fetch calls) --

  it("fetchFilePreview throws 501", async () => {
    await expect(fetchFilePreview("tok", "websocket:s", "/path")).rejects.toThrow(
      "File preview not supported in claudebot MVP",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetchSessionAutomations returns empty jobs without fetch", async () => {
    const result = await fetchSessionAutomations("tok", "websocket:s");
    expect(result).toEqual({ jobs: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetchSkills returns empty skills without fetch", async () => {
    const result = await fetchSkills("tok");
    expect(result).toEqual({ skills: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetchSkillDetail throws 404", async () => {
    await expect(fetchSkillDetail("tok", "test")).rejects.toThrow("skills not supported");
  });

  it("fetchSettings returns hardcoded defaults without fetch", async () => {
    const settings = await fetchSettings("tok");
    expect(settings.agent.model).toBe("glm-5.1");
    expect(settings.agent.has_api_key).toBe(true);
  });

  it("fetchSettingsUsage returns hardcoded defaults without fetch", async () => {
    const settings = await fetchSettingsUsage("tok");
    expect(settings.agent.model).toBe("glm-5.1");
  });

  it("fetchClaudeCodeSettings returns hardcoded defaults", async () => {
    const result = await fetchClaudeCodeSettings("tok");
    expect(result.claudeCode.model).toBe("glm-5.1");
    expect(result.health.sdkRuntime).toBe(true);
  });

  it("fetchClaudeCodeHealth returns healthy by default", async () => {
    const result = await fetchClaudeCodeHealth("tok");
    expect(result.health.sdkRuntime).toBe(true);
    expect(result.health.modelsEndpointReachable).toBe(true);
  });

  it("updateClaudeCodeSettings returns defaults unchanged", async () => {
    const result = await updateClaudeCodeSettings("tok", {
      baseUrl: "http://test",
      apiKey: "key",
      model: "test-model",
      permissionMode: "bypassPermissions",
      enableGatewayModelDiscovery: false,
    });
    // Returns hardcoded defaults, ignores the update payload.
    expect(result.claudeCode.model).toBe("glm-5.1");
  });

  it("updateSettings returns hardcoded defaults", async () => {
    const result = await updateSettings("tok", {
      timezone: "Asia/Shanghai",
      botName: "test",
    });
    expect(result.agent.model).toBe("glm-5.1");
  });

  it("updateNetworkSafetySettings returns hardcoded defaults", async () => {
    const result = await updateNetworkSafetySettings("tok", {
      webuiAllowLocalServiceAccess: false,
      webuiDefaultAccessMode: "full",
    });
    expect(result.agent.model).toBe("glm-5.1");
  });

  it("fetchSidebarState returns hardcoded defaults", async () => {
    const result = await fetchSidebarState("tok");
    expect(result.schema_version).toBe(1);
    expect(result.pinned_keys).toEqual([]);
  });

  it("updateSidebarState returns hardcoded defaults", async () => {
    const result = await updateSidebarState("tok", { pinned_keys: ["k1"] });
    expect(result.schema_version).toBe(1);
  });

  it("fetchWorkspaces returns hardcoded defaults", async () => {
    const result = await fetchWorkspaces("tok");
    expect(result.schema_version).toBe(1);
    expect(result.controls.can_change_project).toBe(false);
  });

  it("listSlashCommands returns empty array without fetch", async () => {
    const result = await listSlashCommands("tok");
    expect(result).toEqual([]);
  });

  // -- Error handling (tested through functions that call request()) --

  it("reports HTML API fallbacks as gateway mismatch errors", async () => {
    // fetchClaudeCodeSettings is a stub — test HTML detection through
    // listSessions which calls request() and checks content-type.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () => "<!doctype html><html></html>",
      }),
    );

    await expect(listSessions("tok")).rejects.toMatchObject({
      status: 200,
      message: "Gateway returned WebUI HTML instead of JSON. Restart claudebot gateway and try again.",
    });
  });

  it("surfaces API error response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "npm error ENOTEMPTY",
      }),
    );

    await expect(listSessions("tok")).rejects.toMatchObject({
      status: 500,
      message: "npm error ENOTEMPTY",
    });
  });

  it("times out when an API request never responds", async () => {
    vi.useFakeTimers();
    // Mock fetch that listens to the abort signal so controller.abort() rejects.
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
    ));

    const pending = expect(listSessions("tok")).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(20_000);

    await pending;
  });
});
