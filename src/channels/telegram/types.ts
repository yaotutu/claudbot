export type TelegramConfig = {
  enabled: boolean;
  mode: "webhook" | "polling";
  botToken: string;
  webhookPath: string;
  secretToken: string;
  allowedChatIds: string[];
};

export type TelegramClient = {
  sendMessage: (chatId: string, text: string) => Promise<void>;
};

export type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id?: number | string; type?: string };
    from?: { id?: number | string; is_bot?: boolean; first_name?: string };
    text?: string;
  };
};
