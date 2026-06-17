export type ChannelId = "telegram" | "feishu" | "qq";

export type ChannelMetadata = Record<string, unknown>;

export type ChannelInboundMessage = {
  channel: ChannelId;
  chatId: string;
  senderId?: string;
  content: string;
  media?: string[];
  metadata?: ChannelMetadata;
  sessionKey?: string;
};

export type ChannelOutboundMessage = {
  channel: ChannelId;
  chatId: string;
  content: string;
  isError: boolean;
  replyTo?: string;
  media: string[];
  metadata: ChannelMetadata;
  buttons?: string[][];
};

export type ChannelRunResult = {
  sessionId: string | null;
  runId: string;
  isError: boolean;
  outbound: ChannelOutboundMessage;
};

export type ChannelSessionBinding = {
  channel: ChannelId;
  externalChatId: string;
  externalUserId?: string;
  claudebotSessionId: string;
  createdAt: string;
  updatedAt: string;
};

export type UpsertChannelSessionBindingInput = {
  channel: ChannelId;
  externalChatId: string;
  externalUserId?: string;
  claudebotSessionId: string;
};

export function channelSessionKey(inbound: Pick<ChannelInboundMessage, "channel" | "chatId" | "sessionKey">): string {
  return inbound.sessionKey ?? `${inbound.channel}:${inbound.chatId}`;
}
