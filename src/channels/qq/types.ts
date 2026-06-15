import type { RuntimeConfig } from "../../config/schema.ts";

export type QqConfig = RuntimeConfig["channels"]["qq"];

export type QqMessageEvent = {
  type: "c2c" | "group" | "guild" | "dm";
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  attachments?: unknown[];
  metadata?: Record<string, unknown>;
};

export type QqSendResult = {
  success: boolean;
  messageId?: string;
  timestamp?: string;
  error?: string;
  streamMsgId?: string;
};

export type QqClient = {
  start: () => Promise<void>;
  stop: () => void | Promise<void>;
  onMessage: (handler: (event: QqMessageEvent) => void | Promise<void>) => void;
  reply: (event: QqMessageEvent, content: string) => Promise<QqSendResult>;
  sendPrivateMessageProactive: (openid: string, content: string) => Promise<QqSendResult>;
  sendGroupMessageProactive: (groupOpenid: string, content: string) => Promise<QqSendResult>;
};
