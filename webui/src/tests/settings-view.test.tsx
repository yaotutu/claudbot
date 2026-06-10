// SettingsView tests: claudebot's API functions are hardcoded stubs that return
// defaults without calling fetch. Tests verify the component renders with
// those stub defaults rather than checking fetch calls.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "@/components/settings/SettingsView";
import { ClientProvider } from "@/providers/ClientProvider";

function renderSettingsView(
  options: {
    initialSection?: "overview" | "advanced";
    onSettingsChange?: (payload: unknown) => void;
  } = {},
) {
  render(
    <ClientProvider client={{} as never} token="">
      <SettingsView
        theme="light"
        initialSection={options.initialSection ?? "overview"}
        onToggleTheme={() => {}}
        onBackToChat={() => {}}
        onModelNameChange={() => {}}
        onSettingsChange={options.onSettingsChange}
      />
    </ClientProvider>,
  );
}

describe("SettingsView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes the hardcoded settings payload to the shell", async () => {
    const onSettingsChange = vi.fn();
    renderSettingsView({ onSettingsChange });

    await waitFor(() => expect(onSettingsChange).toHaveBeenCalled());
    const payload = onSettingsChange.mock.calls[0][0];
    // fetchSettings returns hardcoded EMPTY_SETTINGS with glm-5.1.
    expect(payload.agent.model).toBe("glm-5.1");
  });

  it("shows Claude Code settings from hardcoded defaults", async () => {
    renderSettingsView({ initialSection: "overview" });

    expect(await screen.findByRole("heading", { name: "Claude Code" })).toBeInTheDocument();
    // fetchClaudeCodeSettings returns model "glm-5.1".
    expect(await screen.findByDisplayValue("glm-5.1")).toBeInTheDocument();
  });

  it("shows the advanced section with network safety toggle", async () => {
    renderSettingsView({ initialSection: "advanced" });

    expect(await screen.findByText("Web safety")).toBeInTheDocument();
    // The hardcoded stub returns specific defaults — verify the toggle renders.
    expect(screen.getByRole("switch", { name: "Local services" })).toBeInTheDocument();
  });
});
