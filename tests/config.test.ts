import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
    expect(config.claudeCode.model).toBe("sonnet");
    expect(config.claudeCode.providerModel).toBe("");
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
    expect(config.channels.qq).toMatchObject({
      enabled: false,
      appId: "",
      clientSecret: "",
      sessionDir: "",
      typingKeepAlive: true,
      parseFaceEmoji: true,
      allowedConversationIds: [],
      allowedUserIds: [],
      allowedGroupOpenids: [],
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
        qq: {
          enabled: true,
          appId: "qq-app",
          clientSecret: "qq-secret",
          sessionDir: "/tmp/qq-session",
          typingKeepAlive: false,
          parseFaceEmoji: false,
          allowedConversationIds: ["c2c:user-a"],
          allowedUserIds: ["user-a"],
          allowedGroupOpenids: ["group-a"],
        },
      },
    }, { homeEnv: "", configDir: "/tmp/cfg" });

    expect(config.channels.webui.enabled).toBe(false);
    expect(config.channels.telegram).toMatchObject({ enabled: true, mode: "polling", botToken: "tg-token", allowedChatIds: ["123"] });
    expect(config.channels.feishu).toMatchObject({ enabled: true, appId: "app-id", allowedChatIds: ["chat-a"] });
    expect(config.channels.qq).toMatchObject({
      enabled: true,
      appId: "qq-app",
      clientSecret: "qq-secret",
      sessionDir: "/tmp/qq-session",
      typingKeepAlive: false,
      parseFaceEmoji: false,
      allowedConversationIds: ["c2c:user-a"],
      allowedUserIds: ["user-a"],
      allowedGroupOpenids: ["group-a"],
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

  test("accepts stdio, sse, and http MCP server config", () => {
    const config = resolveRuntimeConfig(
      {
        home: "/tmp/bot",
        mcp: {
          strict: true,
          servers: {
            filesystem: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
              env: { NODE_ENV: "test" },
              timeout: 30000,
              alwaysLoad: false,
            },
            search: {
              type: "sse",
              url: "http://127.0.0.1:3001/sse",
              headers: { Authorization: "Bearer token" },
              timeout: 10000,
              alwaysLoad: true,
            },
            docs: {
              type: "http",
              url: "http://127.0.0.1:3002/mcp",
              headers: {},
              timeout: 10000,
              alwaysLoad: false,
            },
          },
        },
      },
      {},
    );

    expect(config.mcp.strict).toBe(true);
    expect(config.mcp.servers.filesystem.type).toBe("stdio");
    expect(config.mcp.servers.search.type).toBe("sse");
    expect(config.mcp.servers.docs.type).toBe("http");
  });

  test("defaults MCP config to strict with no external servers", () => {
    const config = resolveRuntimeConfig({ home: "/tmp/bot" }, {});
    expect(config.mcp).toEqual({ strict: true, servers: {} });
  });

  test("rejects external MCP server named claudebot", () => {
    expect(() => resolveRuntimeConfig(
      {
        home: "/tmp/bot",
        mcp: {
          servers: {
            claudebot: { type: "stdio", command: "node", args: ["server.js"] },
          },
        },
      },
      {},
    )).toThrow(/claudebot/i);
  });

  test("rejects provider model names passed directly as claudeCode.model", () => {
    const invalidInput = {
      home: "/tmp/bot",
      claudeCode: {
        model: "glm-5.1",
        providerModel: "glm-5.1",
      },
    } as unknown as Parameters<typeof resolveRuntimeConfig>[0];

    expect(() => resolveRuntimeConfig(
      invalidInput,
      {},
    )).toThrow(/haiku|sonnet|opus/);
  });

  test("accepts a single provider model mapped from the selected Claude Code alias", () => {
    const config = resolveRuntimeConfig(
      {
        home: "/tmp/bot",
        claudeCode: {
          model: "sonnet",
          providerModel: "glm-4.7",
        },
      },
      {},
    );

    expect(config.claudeCode.model).toBe("sonnet");
    expect(config.claudeCode.providerModel).toBe("glm-4.7");
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

  test("creates an editable config when env var points at a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-env-missing-"));
    const cfgPath = join(dir, "nested", "config.json");
    try {
      const loaded = await loadConfig({
        envPath: cfgPath,
        homeEnv: join(dir, "home"),
      });
      expect(loaded.source).toEqual({ kind: "created", path: cfgPath });
      expect(loaded.config.gateway.host).toBe("127.0.0.1");
      expect(loaded.config.claudeCode.apiKey).toBe("");

      const written = JSON.parse(await readFile(cfgPath, "utf8")) as { gateway?: { host?: string }; claudeCode?: { model?: string; providerModel?: string } };
      expect(written.gateway?.host).toBe("127.0.0.1");
      expect(written.claudeCode?.model).toBe("sonnet");
      expect(written.claudeCode?.providerModel).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("auto-discovers <home>/config.json when env var is unset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-home-"));
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ gateway: { host: "127.0.0.1", port: 18790 }, claudeCode: { model: "sonnet", providerModel: "glm-4.7" } }),
    );
    try {
      const loaded = await loadConfig({ homeEnv: dir });
      expect(loaded.source.kind).toBe("home");
      expect(loaded.source.kind === "home" && loaded.source.path).toBe(join(dir, "config.json"));
      expect(loaded.config.gateway.host).toBe("127.0.0.1");
      expect(loaded.config.claudeCode.model).toBe("sonnet");
      expect(loaded.config.claudeCode.providerModel).toBe("glm-4.7");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates an editable home config when neither env var nor home config exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-empty-"));
    try {
      const loaded = await loadConfig({ homeEnv: dir });
      const configPath = join(dir, "config.json");
      expect(loaded.source).toEqual({ kind: "created", path: configPath });
      expect(loaded.config.home).toBe(dir);
      expect(loaded.config.workspace.path).toBe(join(dir, "workspace"));
      expect(loaded.config.gateway.host).toBe("127.0.0.1");
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        home: dir,
        workspace: { path: join(dir, "workspace") },
        gateway: { host: "127.0.0.1", port: 18790 },
      });
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
        expect(await readFile(join(dir, "config.json"), "utf8")).toBe("{ this is not json");
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
    expect(formatConfigSource({ kind: "defaults" })).toBe("schema defaults (no usable config file)");
  });
  test("created", () => {
    expect(formatConfigSource({ kind: "created", path: "/h/config.json" })).toBe("/h/config.json (created from defaults; edit this file)");
  });
});
