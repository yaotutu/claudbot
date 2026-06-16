import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeCodeModel, RuntimeConfig } from "../config/schema.ts";

export type SdkMcpServerMap = Record<string, McpServerConfig>;

const providerModelEnvByAlias: Record<ClaudeCodeModel, string> = {
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
};

function envDefault(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function buildProviderModelEnv(config: RuntimeConfig): Record<string, string> {
  const providerModel = config.claudeCode.providerModel.trim();
  if (providerModel.length === 0) return {};
  return {
    [providerModelEnvByAlias[config.claudeCode.model]]: providerModel,
  };
}

function buildCustomBaseUrlEnv(config: RuntimeConfig): Record<string, string> {
  if (config.claudeCode.baseUrl.length === 0) return {};
  return {
    API_TIMEOUT_MS: envDefault("API_TIMEOUT_MS", "3000000"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: envDefault("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: envDefault("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1"),
    ENABLE_TOOL_SEARCH: envDefault("ENABLE_TOOL_SEARCH", "0"),
  };
}

export function buildSdkEnv(config: RuntimeConfig, sdkConfigDir: string): Record<string, string | undefined> {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: sdkConfigDir,
    ...buildCustomBaseUrlEnv(config),
    ...buildProviderModelEnv(config),
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
