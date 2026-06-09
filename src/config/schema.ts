import { z } from "zod/v4";

export const PermissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ToolPolicySchema = z.enum(["allow", "deny", "confirm"]);

const GatewaySchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(18790),
});

const ClaudeCodeSchema = z.object({
  baseUrl: z.string().default(""),
  apiKey: z.string().default(""),
  model: z.string().default("glm-5.1"),
  permissionMode: PermissionModeSchema.default("bypassPermissions"),
  maxTurns: z.number().int().min(1).default(200),
});

const ToolPermissionsSchema = z.object({
  default: ToolPolicySchema.default("allow"),
  overrides: z.record(z.string(), ToolPolicySchema).default({}),
});

const ToolsSchema = z.object({
  permissions: ToolPermissionsSchema,
});

export const RuntimeConfigSchema = z.object({
  home: z.string().optional(),
  workspace: z.object({ path: z.string().optional() }).default({ path: undefined }),
  gateway: GatewaySchema.default({ host: "127.0.0.1", port: 18790 }),
  claudeCode: ClaudeCodeSchema.default({
    baseUrl: "",
    apiKey: "",
    model: "glm-5.1",
    permissionMode: "bypassPermissions",
    maxTurns: 200,
  }),
  tools: ToolsSchema.default({ permissions: { default: "allow", overrides: {} } }),
});

export type RuntimeConfigInput = z.input<typeof RuntimeConfigSchema>;
export type RuntimeConfig = z.output<typeof RuntimeConfigSchema> & {
  home: string;
  workspace: { path: string };
};

