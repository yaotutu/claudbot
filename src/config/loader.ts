import { join } from "node:path";
import { homedir } from "node:os";
import { RuntimeConfigSchema, type RuntimeConfig, type RuntimeConfigInput } from "./schema.ts";
import { expandPath, readJson } from "../utils/fs.ts";

export type { RuntimeConfig } from "./schema.ts";

type ResolveEnv = {
  homeEnv?: string;
  configDir?: string;
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

export async function loadConfig(configPath?: string): Promise<RuntimeConfig> {
  const data = configPath ? await readJson<RuntimeConfigInput>(expandPath(configPath), {}) : {};
  return resolveRuntimeConfig(data, { homeEnv: process.env.CLAUDEBOT_HOME || "" });
}
