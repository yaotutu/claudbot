export type ChannelId = "telegram" | "feishu" | "qq";

export type ChannelInboundMessage = {
  channel: ChannelId;
  conversationId: string;
  senderId?: string;
  content: string;
  media?: string[];
  metadata?: Record<string, unknown>;
  sessionKey?: string;
};

export type ChannelOutboundMessage = {
  channel: ChannelId;
  conversationId: string;
  content: string;
  isError: boolean;
  replyTo?: string;
  media?: string[];
  metadata?: Record<string, unknown>;
};

export type ChannelRunResult = {
  sessionId: string | null;
  runId: string;
  isError: boolean;
  outbound: ChannelOutboundMessage;
};

export type ChannelSessionBinding = {
  channel: ChannelId;
  externalConversationId: string;
  externalUserId?: string;
  claudebotSessionId: string;
  createdAt: string;
  updatedAt: string;
};

export type UpsertChannelSessionBindingInput = {
  channel: ChannelId;
  externalConversationId: string;
  externalUserId?: string;
  claudebotSessionId: string;
};
