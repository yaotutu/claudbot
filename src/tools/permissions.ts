import type { ToolPolicy } from "./types.ts";

export type ToolPermissionConfig = {
  defaultPolicy: ToolPolicy;
  overrides: Record<string, ToolPolicy>;
};

export function resolveToolPolicy(config: ToolPermissionConfig, toolName: string): ToolPolicy {
  return config.overrides[toolName] || config.defaultPolicy;
}
