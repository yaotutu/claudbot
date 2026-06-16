import { join } from "node:path";
import { homedir } from "node:os";
import { RuntimeConfigSchema, type RuntimeConfig, type RuntimeConfigInput } from "./schema.ts";
import { expandPath, readJson, writeJsonAtomic } from "../utils/fs.ts";

export type { RuntimeConfig } from "./schema.ts";

type ResolveEnv = {
  homeEnv?: string;
  configDir?: string;
};

/**
 * Where the active config came from. Surfaced in the startup banner and tests
 * so we can warn loudly when the runtime is silently using schema defaults.
 */
export type ConfigSource =
  | { kind: "env"; path: string } // CLAUDEBOT_CONFIG pointed at a file
  | { kind: "home"; path: string } // auto-discovered <home>/config.json
  | { kind: "created"; path: string } // no config existed; a starter file was created
  | { kind: "defaults" }; // no file found, schema defaults

export type LoadedConfig = {
  config: RuntimeConfig;
  source: ConfigSource;
};

export function defaultHome(): string {
  return join(homedir(), ".claudebot");
}

export function resolveRuntimeConfig(input: RuntimeConfigInput, env: ResolveEnv = {}): RuntimeConfig {
  const parsed = RuntimeConfigSchema.parse(input);
  const rawHome = parsed.home || env.homeEnv || defaultHome();
  const home = expandPath(rawHome);
  const workspacePath = expandPath(parsed.workspace.path || join(home, "workspace"));
  // Env vars override parsed config (handy for `CLAUDEBOT_HOST=0.0.0.0 bun run ...`).
  const envHost = process.env.CLAUDEBOT_HOST;
  const envPort = process.env.CLAUDEBOT_PORT;
  const host = envHost && envHost.length > 0 ? envHost : parsed.gateway.host;
  const port = envPort && envPort.length > 0 ? Number(envPort) : parsed.gateway.port;
  return {
    ...parsed,
    home,
    workspace: { path: workspacePath },
    gateway: { host, port },
  };
}

/**
 * Resolve a home directory from `homeEnv` or fall back to the default.
 * Pure-ish (no I/O) — used by both `loadConfig` and `defaultHome` consumers.
 */
function resolveHome(homeEnv: string | undefined): string {
  return expandPath(homeEnv && homeEnv.length > 0 ? homeEnv : defaultHome());
}

function starterConfig(home: string): RuntimeConfigInput {
  return {
    home,
    workspace: { path: join(home, "workspace") },
    gateway: { host: "127.0.0.1", port: 18790 },
    claudeCode: {
      baseUrl: "",
      apiKey: "",
      model: "sonnet",
      providerModel: "",
      permissionMode: "bypassPermissions",
      maxTurns: 200,
    },
    channels: {
      webui: { enabled: true },
      telegram: {
        enabled: false,
        mode: "webhook",
        botToken: "",
        webhookPath: "/channels/telegram/webhook",
        secretToken: "",
        allowedChatIds: [],
      },
      feishu: {
        enabled: false,
        appId: "",
        appSecret: "",
        verificationToken: "",
        encryptKey: "",
        webhookPath: "/channels/feishu/events",
        allowedChatIds: [],
      },
      qq: {
        enabled: false,
        appId: "",
        clientSecret: "",
        sessionDir: "",
        typingKeepAlive: true,
        parseFaceEmoji: true,
        allowedConversationIds: [],
        allowedUserIds: [],
        allowedGroupOpenids: [],
      },
    },
    tools: { permissions: { default: "allow", overrides: {} } },
    mcp: { strict: true, servers: {} },
    scheduler: { tickIntervalMs: 30_000 },
  };
}

async function createStarterConfig(path: string, home: string): Promise<LoadedConfig> {
  const data = starterConfig(home);
  await writeJsonAtomic(path, data);
  const config = resolveRuntimeConfig(data, { homeEnv: home });
  return { config, source: { kind: "created", path } };
}

/**
 * Load runtime config with sensible defaults.
 *
 * Resolution order:
 *   1. `CLAUDEBOT_CONFIG` env var, if set (explicit override)
 *   2. `<home>/config.json`, if it exists (auto-discovered)
 *   3. Schema defaults
 *
 * Returns the config plus a `source` descriptor for logging.
 */
export async function loadConfig(opts: {
  envPath?: string;
  homeEnv?: string;
} = {}): Promise<LoadedConfig> {
  const envPath = opts.envPath ?? process.env.CLAUDEBOT_CONFIG;
  const home = resolveHome(opts.homeEnv ?? process.env.CLAUDEBOT_HOME);

  // 1. Explicit env var wins — but only if the file actually exists.
  // A missing file with `source.kind: "env"` would be misleading.
  if (envPath && envPath.length > 0) {
    const expanded = expandPath(envPath);
    const file = Bun.file(expanded);
    if (!(await file.exists())) {
      console.warn(`[claudebot] CLAUDEBOT_CONFIG=${envPath} points to a missing file. Creating a starter config there.`);
      try {
        return await createStarterConfig(expanded, home);
      } catch (err) {
        console.warn(`[claudebot] failed to create starter config at ${expanded}: ${err instanceof Error ? err.message : String(err)}. Falling back to schema defaults.`);
        const config = resolveRuntimeConfig({}, { homeEnv: home });
        return { config, source: { kind: "defaults" } };
      }
    }
    const data = await readJson<RuntimeConfigInput>(expanded, {});
    const config = resolveRuntimeConfig(data, { homeEnv: home });
    return { config, source: { kind: "env", path: expanded } };
  }

  // 2. Auto-discover <home>/config.json.
  const candidatePath = join(home, "config.json");
  const candidateFile = Bun.file(candidatePath);
  if (await candidateFile.exists()) {
    try {
      const data = await readJson<RuntimeConfigInput>(candidatePath, {});
      const config = resolveRuntimeConfig(data, { homeEnv: home });
      return { config, source: { kind: "home", path: candidatePath } };
    } catch (err) {
      // Invalid JSON in the auto-discovered file is a common footgun — fall
      // through to defaults and warn so the user notices.
      console.warn(`[claudebot] failed to parse ${candidatePath}: ${err instanceof Error ? err.message : String(err)}. Falling back to schema defaults.`);
      const config = resolveRuntimeConfig({}, { homeEnv: home });
      return { config, source: { kind: "defaults" } };
    }
  }

  // 3. No file → create a starter config, then use it for this run.
  try {
    return await createStarterConfig(candidatePath, home);
  } catch (err) {
    console.warn(`[claudebot] failed to create starter config at ${candidatePath}: ${err instanceof Error ? err.message : String(err)}. Falling back to schema defaults.`);
    const config = resolveRuntimeConfig({}, { homeEnv: home });
    return { config, source: { kind: "defaults" } };
  }
}

/**
 * Human-readable description of where the active config came from.
 */
export function formatConfigSource(source: ConfigSource): string {
  switch (source.kind) {
    case "env":
      return `${source.path} (via CLAUDEBOT_CONFIG)`;
    case "home":
      return `${source.path} (auto-discovered)`;
    case "created":
      return `${source.path} (created from defaults; edit this file)`;
    case "defaults":
      return "schema defaults (no usable config file)";
  }
}
