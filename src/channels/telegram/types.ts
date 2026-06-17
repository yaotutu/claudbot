import type { RuntimeConfig } from "../../config/schema.ts";

export type TelegramConfig = RuntimeConfig["channels"]["telegram"];

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
