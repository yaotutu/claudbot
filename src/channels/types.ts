export type ChannelId = "telegram" | "feishu";

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
