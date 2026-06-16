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
    expect(config.channels).toMatchObject({
      sendProgress: true,
      sendToolHints: false,
      showReasoning: true,
      sendMaxRetries: 3,
    });
    expect(config.channels.webui.enabled).toBe(true);
    expect(config.channels.telegram).toMatchObject({
      enabled: false,
      mode: "webhook",
      botToken: "",
      webhookPath: "/channels/telegram/webhook",
      secretToken: "",
      allowFrom: [],
      streaming: false,
    });
    expect(config.channels.feishu).toMatchObject({
      enabled: false,
      appId: "",
      appSecret: "",
      verificationToken: "",
      encryptKey: "",
      webhookPath: "/channels/feishu/events",
      allowFrom: [],
      streaming: false,
    });
    expect(config.channels.qq).toMatchObject({
      enabled: false,
      appId: "",
      clientSecret: "",
      sessionDir: "",
      typingKeepAlive: true,
      parseFaceEmoji: true,
      allowFrom: [],
      streaming: false,
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
          allowFrom: ["123"],
          streaming: true,
        },
        feishu: {
          enabled: true,
          appId: "app-id",
          appSecret: "app-secret",
          verificationToken: "verify",
          encryptKey: "encrypt",
          webhookPath: "/fs",
          allowFrom: ["chat-a"],
          streaming: true,
        },
        qq: {
          enabled: true,
          appId: "qq-app",
          clientSecret: "qq-secret",
          sessionDir: "/tmp/qq-session",
          typingKeepAlive: false,
          parseFaceEmoji: false,
          allowFrom: ["c2c:user-a", "user-a", "group-a"],
          streaming: true,
        },
      },
    }, { homeEnv: "", configDir: "/tmp/cfg" });

    expect(config.channels.webui.enabled).toBe(false);
    expect(config.channels.telegram).toMatchObject({
      enabled: true,
      mode: "polling",
      botToken: "tg-token",
      allowFrom: ["123"],
      streaming: true,
    });
    expect(config.channels.feishu).toMatchObject({ enabled: true, appId: "app-id", allowFrom: ["chat-a"], streaming: true });
    expect(config.channels.qq).toMatchObject({
      enabled: true,
      appId: "qq-app",
      clientSecret: "qq-secret",
      sessionDir: "/tmp/qq-session",
      typingKeepAlive: false,
      parseFaceEmoji: false,
      allowFrom: ["c2c:user-a", "user-a", "group-a"],
      streaming: true,
    });
  });

  test("accepts Nanobot-style snake_case channel aliases", () => {
    const config = resolveRuntimeConfig({
      channels: {
        send_progress: false,
        send_tool_hints: true,
        show_reasoning: false,
        send_max_retries: 5,
        telegram: {
          enabled: true,
          bot_token: "tg-token",
          webhook_path: "/tg-alias",
          secret_token: "tg-secret",
          allow_from: ["123"],
          streaming: true,
        },
        qq: {
          enabled: true,
          app_id: "qq-app",
          client_secret: "qq-secret",
          session_dir: "/tmp/qq",
          typing_keep_alive: false,
          parse_face_emoji: false,
          allow_from: ["c2c:user-a"],
          streaming: true,
        },
      },
    } as never, { homeEnv: "", configDir: "/tmp/cfg" });

    expect(config.channels).toMatchObject({
      sendProgress: false,
      sendToolHints: true,
      showReasoning: false,
      sendMaxRetries: 5,
    });
    expect(config.channels.telegram).toMatchObject({
      enabled: true,
      botToken: "tg-token",
      webhookPath: "/tg-alias",
      secretToken: "tg-secret",
      allowFrom: ["123"],
      streaming: true,
    });
    expect(config.channels.qq).toMatchObject({
      enabled: true,
      appId: "qq-app",
      clientSecret: "qq-secret",
      sessionDir: "/tmp/qq",
      typingKeepAlive: false,
      parseFaceEmoji: false,
      allowFrom: ["c2c:user-a"],
      streaming: true,
    });
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
    expect(paths.channelBindingsFile).toBe("/tmp/bot/channels/channel-bindings.json");
    expect(paths.qqSessionDir).toBe("/tmp/bot/channels/qq");
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
