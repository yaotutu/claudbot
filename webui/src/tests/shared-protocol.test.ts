import { describe, expect, it } from "vitest";

import { WEBUI_PROTOCOL_VERSION, type ThreadActivity } from "@/lib/claudebot-types";

describe("shared WebUI protocol", () => {
  it("exports the shared protocol version through the frontend type module", () => {
    expect(WEBUI_PROTOCOL_VERSION).toBe(1);
  });

  it("exports the run activity metadata shape through the frontend type module", () => {
    const activity: ThreadActivity = {
      id: "status-r1",
      kind: "status",
      runId: "r1",
      text: "session_init",
      status: "complete",
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
      mcpServers: [{ name: "claudebot", status: "connected" }],
    };

    expect(activity.kind).toBe("status");
  });
});
