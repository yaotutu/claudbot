import type { RuntimeConfig } from "../config/schema.ts";

export type SdkMcpServerMap = Record<string, unknown>;

export function buildSdkEnv(config: RuntimeConfig, sdkConfigDir: string): Record<string, string | undefined> {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: sdkConfigDir,
    ...(config.claudeCode.baseUrl ? { ANTHROPIC_BASE_URL: config.claudeCode.baseUrl } : {}),
    ...(config.claudeCode.apiKey
      ? {
          ANTHROPIC_API_KEY: config.claudeCode.apiKey,
          ANTHROPIC_AUTH_TOKEN: config.claudeCode.apiKey,
        }
      : {}),
  };
}

export function buildSdkMcpServers(config: RuntimeConfig, nativeServer: unknown): SdkMcpServerMap {
  return {
    claudebot: nativeServer,
    ...config.mcp.servers,
  };
}

export function buildBaseSdkOptions(config: RuntimeConfig, sdkConfigDir: string, nativeServer: unknown) {
  return {
    model: config.claudeCode.model,
    permissionMode: config.claudeCode.permissionMode,
    maxTurns: config.claudeCode.maxTurns,
    env: buildSdkEnv(config, sdkConfigDir),
    mcpServers: buildSdkMcpServers(config, nativeServer),
    strictMcpConfig: config.mcp.strict,
  };
}
