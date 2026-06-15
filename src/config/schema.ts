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

const WebuiChannelSchema = z.object({
  enabled: z.boolean().default(true),
}).default({ enabled: true });

const TelegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["webhook", "polling"]).default("webhook"),
  botToken: z.string().default(""),
  webhookPath: z.string().default("/channels/telegram/webhook"),
  secretToken: z.string().default(""),
  allowedChatIds: z.array(z.string()).default([]),
}).default({
  enabled: false,
  mode: "webhook",
  botToken: "",
  webhookPath: "/channels/telegram/webhook",
  secretToken: "",
  allowedChatIds: [],
});

const FeishuChannelSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(""),
  appSecret: z.string().default(""),
  verificationToken: z.string().default(""),
  encryptKey: z.string().default(""),
  webhookPath: z.string().default("/channels/feishu/events"),
  allowedChatIds: z.array(z.string()).default([]),
}).default({
  enabled: false,
  appId: "",
  appSecret: "",
  verificationToken: "",
  encryptKey: "",
  webhookPath: "/channels/feishu/events",
  allowedChatIds: [],
});

const ChannelsSchema = z.object({
  webui: WebuiChannelSchema,
  telegram: TelegramChannelSchema,
  feishu: FeishuChannelSchema,
}).default({
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
});

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
  channels: ChannelsSchema,
  tools: ToolsSchema.default({ permissions: { default: "allow", overrides: {} } }),
  scheduler: SchedulerSchema,
});

export type RuntimeConfigInput = z.input<typeof RuntimeConfigSchema>;
export type RuntimeConfig = z.output<typeof RuntimeConfigSchema> & {
  home: string;
  workspace: { path: string };
};
