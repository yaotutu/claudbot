// Wire-shape contract tests for the REST adapter.
//
// The claudebot gateway returns arrays directly from list endpoints
// (`GET /api/sessions` → SessionRecord[], `GET /api/sessions/:id/messages`
// → SessionMessage[]). The nanobot-shaped components the WebUI was copied
// from expect `{ sessions: [...] }` / `{ messages: [...] }`. The adapter
// in `@/lib/api` is responsible for the unwrap — these tests pin it down
// so we don't regress when the server is touched.

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWebuiThread, listSessions } from "@/lib/api";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("REST adapter — wire shape", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listSessions unwraps the gateway's array response into ChatSummary[]", async () => {
    const serverRows = [
      {
        id: "sess_top",
        title: "Top chat",
        preview: "hi",
        createdAt: "2026-06-09T08:34:24.796Z",
        updatedAt: "2026-06-09T08:34:45.963Z",
        messages: [],
      },
      {
        id: "sess_two",
        title: "Second",
        preview: "yo",
        createdAt: "2026-06-09T08:28:00.000Z",
        updatedAt: "2026-06-09T08:28:04.996Z",
        messages: [],
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url) === "/api/sessions") {
          // Server returns the array directly — NOT wrapped in { sessions: ... }
          return jsonResponse(serverRows);
        }
        return jsonResponse({}, 404);
      }),
    );

    const out = await listSessions("", "");

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      key: "websocket:sess_top",
      chatId: "sess_top",
      channel: "websocket",
      title: "Top chat",
      preview: "hi",
    });
    expect(out[1].chatId).toBe("sess_two");
  });

  it("fetchWebuiThread unwraps the gateway's array response into UIMessage[]", async () => {
    const serverMessages = [
      { id: "m1", role: "user", content: "hi", createdAt: "2026-06-09T08:34:33.643Z", metadata: {} },
      { id: "m2", role: "assistant", content: "hello", createdAt: "2026-06-09T08:34:45.963Z", metadata: {} },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url) === "/api/sessions/sess_top/messages") {
          // Server returns the array directly — NOT wrapped in { messages: ... }
          return jsonResponse(serverMessages);
        }
        return jsonResponse({}, 404);
      }),
    );

    const out = await fetchWebuiThread("", "websocket:sess_top", "");

    expect(out).not.toBeNull();
    expect(out?.messages).toHaveLength(2);
    expect(out?.messages[0]).toMatchObject({ role: "user", content: "hi" });
    expect(out?.messages[1]).toMatchObject({ role: "assistant", content: "hello" });
  });
});
