// SessionInfoPopover tests: claudebot's fetchSessionAutomations is a hardcoded
// stub returning {jobs: []}. Tests verify the component renders with the
// stub's empty response and shows the "no automations" message.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionInfoPopover } from "@/components/thread/SessionInfoPopover";

describe("SessionInfoPopover", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows no automations message when opened (stub returns empty jobs)", async () => {
    const user = userEvent.setup();

    render(
      <SessionInfoPopover
        sessionKey="websocket:chat-1"
        token=""
        title="Release work"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Session details" }));

    // The stub returns {jobs: []} so the popover shows the empty state.
    expect(await screen.findByText("No automations in this session yet.")).toBeInTheDocument();
  });
});
