import type { ServiceContainer } from "../../runtime/services.ts";
import type { ChannelAdapter } from "../adapter.ts";
import { runChannelTurn } from "../runtime.ts";
import type { TelegramClient, TelegramConfig, TelegramUpdate } from "./types.ts";
import { createTelegramClient } from "./client.ts";

export function createTelegramAdapter(
  services: ServiceContainer,
  config: TelegramConfig,
  client: TelegramClient = createTelegramClient(config.botToken),
): ChannelAdapter {
  return {
    name: "telegram",
    displayName: "Telegram",
    start: async () => {},
    stop: async () => {},
    send: async (msg) => {
      await client.sendMessage(msg.chatId, msg.content);
    },

    async handleHttp(req, url) {
      if (url.pathname !== config.webhookPath) return null;
      if (req.method !== "POST") return json(405, { error: "method not allowed" });
      if (config.secretToken && req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== config.secretToken) {
        return json(401, { error: "invalid telegram secret token" });
      }

      const update = await safeJson<TelegramUpdate>(req);
      const inbound = normalizeTextUpdate(update);
      if (!inbound) return json(200, { ok: true, ignored: true });
      if (!isAllowed(config.allowFrom, inbound.chatId)) {
        return json(200, { ok: true, ignored: true });
      }

      const result = await runChannelTurn(services, {
        channel: "telegram",
        chatId: inbound.chatId,
        senderId: inbound.userId,
        content: inbound.text,
        media: [],
        metadata: inbound.messageId ? { messageId: inbound.messageId } : {},
      });
      await this.send(result.outbound);
      return json(200, { ok: true });
    },
  };
}

function isAllowed(allowFrom: string[], chatId: string): boolean {
  return allowFrom.length === 0 || allowFrom.includes("*") || allowFrom.includes(chatId);
}

function normalizeTextUpdate(update: TelegramUpdate | null): {
  chatId: string;
  userId?: string;
  text: string;
  messageId?: string;
} | null {
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  if (chatId === undefined || typeof text !== "string" || text.trim() === "") return null;
  const userId = message?.from?.id === undefined ? undefined : String(message.from.id);
  const messageId = message?.message_id === undefined ? undefined : String(message.message_id);
  return { chatId: String(chatId), userId, text, messageId };
}

async function safeJson<T>(req: Request): Promise<T | null> {
  try { return await req.json() as T; } catch { return null; }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
