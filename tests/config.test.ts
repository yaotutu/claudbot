import { describe, expect, test } from "bun:test";
import { resolveRuntimeConfig } from "../src/config/loader.ts";

describe("runtime config", () => {
  test("uses default home and workspace", () => {
    const config = resolveRuntimeConfig({}, { homeEnv: "", configDir: "/tmp/cfg" });
    expect(config.home.endsWith("/.claudebot")).toBe(true);
    expect(config.workspace.path.endsWith("/.claudebot/workspace")).toBe(true);
  });

  test("home overrides workspace default", () => {
    const config = resolveRuntimeConfig({ home: "/tmp/bot" }, { homeEnv: "", configDir: "/tmp/cfg" });
    expect(config.home).toBe("/tmp/bot");
    expect(config.workspace.path).toBe("/tmp/bot/workspace");
  });

  test("explicit workspace wins", () => {
    const config = resolveRuntimeConfig(
      { home: "/tmp/bot", workspace: { path: "/tmp/ws" } },
      { homeEnv: "", configDir: "/tmp/cfg" },
    );
    expect(config.workspace.path).toBe("/tmp/ws");
  });
});
