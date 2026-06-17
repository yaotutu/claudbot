import { z } from "zod/v4";

export const PermissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ClaudeCodeModelSchema = z.enum(["haiku", "sonnet", "opus"]);
export type ClaudeCodeModel = z.infer<typeof ClaudeCodeModelSchema>;

export const ToolPolicySchema = z.enum(["allow", "deny", "confirm"]);

const GatewaySchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().min(1).max(65535).default(18790),
});

const ClaudeCodeSchema = z.object({
  baseUrl: z.string().default(""),
  apiKey: z.string().default(""),
  model: ClaudeCodeModelSchema.default("sonnet"),
  providerModel: z.string().default(""),
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

function commonChannelFields(enabledDefault: boolean) {
  return {
    enabled: z.boolean().default(enabledDefault),
    allowFrom: z.array(z.string()).default([]),
    streaming: z.boolean().default(false),
  };
}

const DefaultWebuiChannel = { enabled: true };

const DefaultTelegramChannel = {
  enabled: false,
  mode: "webhook" as const,
  botToken: "",
  webhookPath: "/channels/telegram/webhook",
  secretToken: "",
  allowFrom: [] as string[],
  streaming: false,
};

// Feishu channel config is a placeholder — there is no adapter implementation yet.
const DefaultFeishuChannel = {
  enabled: false,
  appId: "",
  appSecret: "",
  verificationToken: "",
  encryptKey: "",
  webhookPath: "/channels/feishu/events",
  allowFrom: [] as string[],
  streaming: false,
};

const DefaultQqChannel = {
  enabled: false,
  appId: "",
  clientSecret: "",
  sessionDir: "",
  typingKeepAlive: true,
  parseFaceEmoji: true,
  allowFrom: [] as string[],
  streaming: false,
};

const WebuiChannelSchema = z.object({
  enabled: z.boolean().default(true),
}).default(DefaultWebuiChannel);

const TelegramChannelSchema = z.object({
  ...commonChannelFields(false),
  mode: z.enum(["webhook", "polling"]).default("webhook"),
  botToken: z.string().default(""),
  webhookPath: z.string().default("/channels/telegram/webhook"),
  secretToken: z.string().default(""),
}).default(DefaultTelegramChannel);

// Feishu channel config is a placeholder — there is no adapter implementation yet.
const FeishuChannelSchema = z.object({
  ...commonChannelFields(false),
  appId: z.string().default(""),
  appSecret: z.string().default(""),
  verificationToken: z.string().default(""),
  encryptKey: z.string().default(""),
  webhookPath: z.string().default("/channels/feishu/events"),
}).default(DefaultFeishuChannel);

const QqChannelSchema = z.object({
  ...commonChannelFields(false),
  appId: z.string().default(""),
  clientSecret: z.string().default(""),
  sessionDir: z.string().default(""),
  typingKeepAlive: z.boolean().default(true),
  parseFaceEmoji: z.boolean().default(true),
}).default(DefaultQqChannel);

const DefaultChannels = {
  sendProgress: true,
  sendToolHints: false,
  showReasoning: true,
  sendMaxRetries: 3,
  webui: DefaultWebuiChannel,
  telegram: DefaultTelegramChannel,
  feishu: DefaultFeishuChannel,
  qq: DefaultQqChannel,
};

const ChannelsSchema = z.object({
  sendProgress: z.boolean().default(true),
  sendToolHints: z.boolean().default(false),
  showReasoning: z.boolean().default(true),
  sendMaxRetries: z.number().int().min(1).default(3),
  webui: WebuiChannelSchema,
  telegram: TelegramChannelSchema,
  feishu: FeishuChannelSchema,
  qq: QqChannelSchema,
}).default(DefaultChannels);

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
    model: "sonnet",
    providerModel: "",
    permissionMode: "bypassPermissions",
    maxTurns: 200,
  }),
  channels: ChannelsSchema,
  tools: ToolsSchema.default({ permissions: { default: "allow", overrides: {} } }),
  mcp: McpSchema,
  scheduler: SchedulerSchema,
});

export type RuntimeConfigInput = z.input<typeof RuntimeConfigSchema>;
export type RuntimeConfig = z.output<typeof RuntimeConfigSchema> & {
  home: string;
  workspace: { path: string };
};
