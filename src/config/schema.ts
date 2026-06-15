import { z } from "zod/v4";

export const PermissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ToolPolicySchema = z.enum(["allow", "deny", "confirm"]);

const GatewaySchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().min(1).max(65535).default(18790),
});

const ClaudeCodeSchema = z.object({
  baseUrl: z.string().default(""),
  apiKey: z.string().default(""),
  model: z.string().default("glm-5.1"),
  permissionMode: PermissionModeSchema.default("bypassPermissions"),
  maxTurns: z.number().int().min(1).default(200),
});

const SchedulerSchema = z.object({
  tickIntervalMs: z.number().int().min(1000).default(30_000),
}).default(() => ({ tickIntervalMs: 30_000 }));

const ToolPermissionsSchema = z.object({
  default: ToolPolicySchema.default("allow"),
  overrides: z.record(z.string(), ToolPolicySchema).default({}),
});

const ToolsSchema = z.object({
  permissions: ToolPermissionsSchema,
});

const McpServerNameSchema = z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/).refine((name) => name !== "claudebot", {
  message: "external MCP server name 'claudebot' is reserved for native tools",
});

const McpBaseSchema = z.object({
  timeout: z.number().int().min(1000).optional(),
  alwaysLoad: z.boolean().optional(),
});

const McpStdioServerSchema = McpBaseSchema.extend({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const McpRemoteServerSchema = McpBaseSchema.extend({
  type: z.enum(["sse", "http"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpServerSchema = z.discriminatedUnion("type", [
  McpStdioServerSchema,
  McpRemoteServerSchema,
]);

const McpSchema = z.object({
  strict: z.boolean().default(true),
  servers: z.record(McpServerNameSchema, McpServerSchema).default({}),
}).default({ strict: true, servers: {} });

export const RuntimeConfigSchema = z.object({
  home: z.string().optional(),
  workspace: z.object({ path: z.string().optional() }).default({ path: undefined }),
  gateway: GatewaySchema.default({ host: "0.0.0.0", port: 18790 }),
  claudeCode: ClaudeCodeSchema.default({
    baseUrl: "",
    apiKey: "",
    model: "glm-5.1",
    permissionMode: "bypassPermissions",
    maxTurns: 200,
  }),
  tools: ToolsSchema.default({ permissions: { default: "allow", overrides: {} } }),
  mcp: McpSchema,
  scheduler: SchedulerSchema,
});

export type RuntimeConfigInput = z.input<typeof RuntimeConfigSchema>;
export type RuntimeConfig = z.output<typeof RuntimeConfigSchema> & {
  home: string;
  workspace: { path: string };
};
