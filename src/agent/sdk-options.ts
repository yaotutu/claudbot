import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeConfig } from "../config/schema.ts";

export type SdkMcpServerMap = Record<string, McpServerConfig>;

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

export function buildSdkMcpServers(config: RuntimeConfig, nativeServer: McpServerConfig): SdkMcpServerMap {
  return {
    claudebot: nativeServer,
    ...(config.mcp.servers as SdkMcpServerMap),
  };
}

export function buildBaseSdkOptions(config: RuntimeConfig, sdkConfigDir: string, nativeServer: McpServerConfig) {
  return {
    model: config.claudeCode.model,
    permissionMode: config.claudeCode.permissionMode,
    maxTurns: config.claudeCode.maxTurns,
    env: buildSdkEnv(config, sdkConfigDir),
    mcpServers: buildSdkMcpServers(config, nativeServer),
    strictMcpConfig: config.mcp.strict,
  };
}
