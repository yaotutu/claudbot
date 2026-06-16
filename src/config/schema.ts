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

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAliases(input: unknown, aliases: Record<string, string>): UnknownRecord {
  const result = isRecord(input) ? { ...input } : {};
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (result[canonical] === undefined && result[alias] !== undefined) {
      result[canonical] = result[alias];
    }
  }
  return result;
}

function appendStringArray(values: string[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string" && !values.includes(item)) values.push(item);
  }
}

function normalizeChannelAliases(
  input: unknown,
  aliases: Record<string, string>,
  allowFromAliases: string[] = [],
): UnknownRecord {
  const result = normalizeAliases(input, { ...aliases, allow_from: "allowFrom" });
  const allowFrom: string[] = [];
  appendStringArray(allowFrom, result.allowFrom);
  for (const alias of allowFromAliases) appendStringArray(allowFrom, result[alias]);
  if (allowFrom.length > 0) result.allowFrom = allowFrom;
  return result;
}

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

const WebuiChannelSchema = z.preprocess(
  (input) => normalizeAliases(input, {}),
  z.object({
    enabled: z.boolean().default(true),
  }),
).default(DefaultWebuiChannel);

const TelegramChannelSchema = z.preprocess(
  (input) => normalizeChannelAliases(input, {
    bot_token: "botToken",
    webhook_path: "webhookPath",
    secret_token: "secretToken",
  }, ["allowedChatIds", "allowed_chat_ids"]),
  z.object({
    ...commonChannelFields(false),
    mode: z.enum(["webhook", "polling"]).default("webhook"),
    botToken: z.string().default(""),
    webhookPath: z.string().default("/channels/telegram/webhook"),
    secretToken: z.string().default(""),
  }),
).default(DefaultTelegramChannel);

const FeishuChannelSchema = z.preprocess(
  (input) => normalizeChannelAliases(input, {
    app_id: "appId",
    app_secret: "appSecret",
    verification_token: "verificationToken",
    encrypt_key: "encryptKey",
    webhook_path: "webhookPath",
  }, ["allowedChatIds", "allowed_chat_ids"]),
  z.object({
    ...commonChannelFields(false),
    appId: z.string().default(""),
    appSecret: z.string().default(""),
    verificationToken: z.string().default(""),
    encryptKey: z.string().default(""),
    webhookPath: z.string().default("/channels/feishu/events"),
  }),
).default(DefaultFeishuChannel);

const QqChannelSchema = z.preprocess(
  (input) => normalizeChannelAliases(input, {
    app_id: "appId",
    client_secret: "clientSecret",
    session_dir: "sessionDir",
    typing_keep_alive: "typingKeepAlive",
    parse_face_emoji: "parseFaceEmoji",
  }, [
    "allowedConversationIds",
    "allowed_conversation_ids",
    "allowedUserIds",
    "allowed_user_ids",
    "allowedGroupOpenids",
    "allowed_group_openids",
  ]),
  z.object({
    ...commonChannelFields(false),
    appId: z.string().default(""),
    clientSecret: z.string().default(""),
    sessionDir: z.string().default(""),
    typingKeepAlive: z.boolean().default(true),
    parseFaceEmoji: z.boolean().default(true),
  }),
).default(DefaultQqChannel);

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

const ChannelsSchema = z.preprocess((input) => normalizeAliases(input, {
  send_progress: "sendProgress",
  send_tool_hints: "sendToolHints",
  show_reasoning: "showReasoning",
  send_max_retries: "sendMaxRetries",
}), z.object({
  sendProgress: z.boolean().default(true),
  sendToolHints: z.boolean().default(false),
  showReasoning: z.boolean().default(true),
  sendMaxRetries: z.number().int().min(1).default(3),
  webui: WebuiChannelSchema,
  telegram: TelegramChannelSchema,
  feishu: FeishuChannelSchema,
  qq: QqChannelSchema,
})).default(DefaultChannels);

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
