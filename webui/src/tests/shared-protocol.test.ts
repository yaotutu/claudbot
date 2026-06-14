import { describe, expect, it } from "vitest";

import { WEBUI_PROTOCOL_VERSION } from "@/lib/claudebot-types";

describe("shared WebUI protocol", () => {
  it("exports the shared protocol version through the frontend type module", () => {
    expect(WEBUI_PROTOCOL_VERSION).toBe(1);
  });
});
