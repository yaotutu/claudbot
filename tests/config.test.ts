import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatConfigSource, loadConfig, resolveRuntimeConfig } from "../src/config/loader.ts";
import { runtimePaths } from "../src/config/paths.ts";

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

  test("channels default to webui enabled and external channels disabled", () => {
    const config = resolveRuntimeConfig({}, { homeEnv: "", configDir: "/tmp/cfg" });
    expect(config.channels.webui.enabled).toBe(true);
    expect(config.channels.telegram).toMatchObject({
      enabled: false,
      mode: "webhook",
      botToken: "",
      webhookPath: "/channels/telegram/webhook",
      secretToken: "",
      allowedChatIds: [],
    });
    expect(config.channels.feishu).toMatchObject({
      enabled: false,
      appId: "",
      appSecret: "",
      verificationToken: "",
      encryptKey: "",
      webhookPath: "/channels/feishu/events",
      allowedChatIds: [],
    });
  });

  test("explicit channel config wins", () => {
    const config = resolveRuntimeConfig({
      channels: {
        webui: { enabled: false },
        telegram: {
          enabled: true,
          mode: "polling",
          botToken: "tg-token",
          webhookPath: "/tg",
          secretToken: "tg-secret",
          allowedChatIds: ["123"],
        },
        feishu: {
          enabled: true,
          appId: "app-id",
          appSecret: "app-secret",
          verificationToken: "verify",
          encryptKey: "encrypt",
          webhookPath: "/fs",
          allowedChatIds: ["chat-a"],
        },
      },
    }, { homeEnv: "", configDir: "/tmp/cfg" });

    expect(config.channels.webui.enabled).toBe(false);
    expect(config.channels.telegram).toMatchObject({ enabled: true, mode: "polling", botToken: "tg-token", allowedChatIds: ["123"] });
    expect(config.channels.feishu).toMatchObject({ enabled: true, appId: "app-id", allowedChatIds: ["chat-a"] });
  });

  test("derives user-facing runtime directories from home", () => {
    const config = resolveRuntimeConfig({ home: "/tmp/bot" }, { homeEnv: "", configDir: "/tmp/cfg" });
    const paths = runtimePaths(config);

    expect(paths.configFile).toBe("/tmp/bot/config.json");
    expect(paths.workspace).toBe("/tmp/bot/workspace");
    expect(paths.profileDir).toBe("/tmp/bot/profile");
    expect(paths.userFile).toBe("/tmp/bot/profile/user.md");
    expect(paths.soulFile).toBe("/tmp/bot/profile/soul.md");
    expect(paths.memoryDir).toBe("/tmp/bot/memory");
    expect(paths.memoryFile).toBe("/tmp/bot/memory/memory.json");
    expect(paths.schedulesDir).toBe("/tmp/bot/schedules");
    expect(paths.schedulesFile).toBe("/tmp/bot/schedules/jobs.json");
    expect(paths.scheduleRunsDir).toBe("/tmp/bot/schedules/runs");
    expect(paths.logsDir).toBe("/tmp/bot/logs");
    expect(paths.claudeDir).toBe("/tmp/bot/claude");
    expect(paths.sdkConfigDir).toBe("/tmp/bot/claude/config");
  });
});

describe("loadConfig", () => {
  test("uses env var when CLAUDEBOT_CONFIG points at a real file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-cfg-"));
    const cfgPath = join(dir, "explicit.json");
    await writeFile(cfgPath, JSON.stringify({ gateway: { host: "10.0.0.1", port: 19999 } }));
    try {
      const loaded = await loadConfig({ envPath: cfgPath, homeEnv: "/nonexistent" });
      expect(loaded.source.kind).toBe("env");
      expect(loaded.source.kind === "env" && loaded.source.path).toBe(cfgPath);
      expect(loaded.config.gateway.host).toBe("10.0.0.1");
      expect(loaded.config.gateway.port).toBe(19999);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to defaults when env var points at a missing file", async () => {
    const loaded = await loadConfig({
      envPath: "/nonexistent/path/to/cfg.json",
      homeEnv: "/also-nonexistent",
    });
    expect(loaded.source.kind).toBe("defaults");
    expect(loaded.config.gateway.host).toBe("0.0.0.0");
  });

  test("auto-discovers <home>/config.json when env var is unset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-home-"));
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ gateway: { host: "127.0.0.1", port: 18790 }, claudeCode: { model: "glm-cn/glm-5.1" } }),
    );
    try {
      const loaded = await loadConfig({ homeEnv: dir });
      expect(loaded.source.kind).toBe("home");
      expect(loaded.source.kind === "home" && loaded.source.path).toBe(join(dir, "config.json"));
      expect(loaded.config.gateway.host).toBe("127.0.0.1");
      expect(loaded.config.claudeCode.model).toBe("glm-cn/glm-5.1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses defaults when neither env var nor home config exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-empty-"));
    try {
      const loaded = await loadConfig({ homeEnv: dir });
      expect(loaded.source.kind).toBe("defaults");
      expect(loaded.config.gateway.host).toBe("0.0.0.0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to defaults when home config.json is invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-bad-"));
    await writeFile(join(dir, "config.json"), "{ this is not json");
    try {
      // Capture stderr so the test output stays clean.
      const orig = console.warn;
      const warnings: string[] = [];
      console.warn = (msg: string) => { warnings.push(msg); };
      try {
        const loaded = await loadConfig({ homeEnv: dir });
        expect(loaded.source.kind).toBe("defaults");
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toContain("failed to parse");
      } finally {
        console.warn = orig;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("env var beats auto-discovered home config", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "claudebot-home-pri-"));
    const envDir = await mkdtemp(join(tmpdir(), "claudebot-env-pri-"));
    await writeFile(join(homeDir, "config.json"), JSON.stringify({ gateway: { host: "1.1.1.1" } }));
    const envPath = join(envDir, "override.json");
    await writeFile(envPath, JSON.stringify({ gateway: { host: "2.2.2.2" } }));
    try {
      const loaded = await loadConfig({ envPath, homeEnv: homeDir });
      expect(loaded.source.kind).toBe("env");
      expect(loaded.config.gateway.host).toBe("2.2.2.2");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(envDir, { recursive: true, force: true });
    }
  });
});

describe("formatConfigSource", () => {
  test("env", () => {
    expect(formatConfigSource({ kind: "env", path: "/tmp/x.json" })).toBe("/tmp/x.json (via CLAUDEBOT_CONFIG)");
  });
  test("home", () => {
    expect(formatConfigSource({ kind: "home", path: "/h/config.json" })).toBe("/h/config.json (auto-discovered)");
  });
  test("defaults", () => {
    expect(formatConfigSource({ kind: "defaults" })).toBe("schema defaults (no config file found)");
  });
});
