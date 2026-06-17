import type { RuntimeConfig } from "../config/schema.ts";
import type { WebuiMcpConfig, WebuiMcpServerConfig } from "../shared/webui-protocol.ts";

export type SanitizedMcpServerConfig = WebuiMcpServerConfig;

export type SanitizedMcpConfig = WebuiMcpConfig;

export function summarizeMcpConfig(config: RuntimeConfig): SanitizedMcpConfig {
  return {
    strict: config.mcp.strict,
    servers: Object.entries(config.mcp.servers)
      .map(([name, server]) => sanitizeServer(name, server))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function hasConfiguredMcpServer(config: RuntimeConfig, serverName: string): boolean {
  return Object.prototype.hasOwnProperty.call(config.mcp.servers, serverName);
}

function sanitizeServer(name: string, server: RuntimeConfig["mcp"]["servers"][string]): SanitizedMcpServerConfig {
  const base = {
    name,
    type: server.type,
    ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
    ...(server.alwaysLoad === undefined ? {} : { alwaysLoad: server.alwaysLoad }),
  };

  if (server.type === "stdio") {
    return {
      ...base,
      command: server.command,
      ...(server.args === undefined ? {} : { args: server.args }),
      ...(server.env === undefined ? {} : { envKeys: Object.keys(server.env).sort() }),
    };
  }

  return {
    ...base,
    url: server.url,
    ...(server.headers === undefined ? {} : { headerKeys: Object.keys(server.headers).sort() }),
  };
}
