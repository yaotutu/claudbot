import type { TelegramClient } from "./types.ts";

export function createTelegramClient(botToken: string, fetchImpl: typeof fetch = fetch): TelegramClient {
  return {
    async sendMessage(chatId, text) {
      if (!botToken) throw new Error("telegram botToken is required");
      const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`telegram sendMessage failed: ${res.status}${detail ? ` ${detail}` : ""}`);
      }
    },
  };
}
