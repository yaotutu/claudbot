import type { ServiceContainer } from "../../runtime/services.ts";
import { runChannelTurn } from "../runtime.ts";
import type { ChannelRegistry } from "../registry.ts";
import type { TelegramClient, TelegramConfig, TelegramUpdate } from "./types.ts";
import { createTelegramClient } from "./client.ts";

export function createTelegramAdapter(
  services: ServiceContainer,
  config: TelegramConfig,
  client: TelegramClient = createTelegramClient(config.botToken),
): ChannelRegistry {
  return {
    start: async () => {},
    stop: async () => {},

    async handleHttp(req, url) {
      if (url.pathname !== config.webhookPath) return null;
      if (req.method !== "POST") return json(405, { error: "method not allowed" });
      if (config.secretToken && req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== config.secretToken) {
        return json(401, { error: "invalid telegram secret token" });
      }

      const update = await safeJson<TelegramUpdate>(req);
      const inbound = normalizeTextUpdate(update);
      if (!inbound) return json(200, { ok: true, ignored: true });
      if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(inbound.chatId)) {
        return json(200, { ok: true, ignored: true });
      }

      const result = await runChannelTurn(services, {
        channel: "telegram",
        conversationId: inbound.chatId,
        senderId: inbound.userId,
        content: inbound.text,
      });
      await client.sendMessage(inbound.chatId, result.outbound.content);
      return json(200, { ok: true });
    },
  };
}

function normalizeTextUpdate(update: TelegramUpdate | null): { chatId: string; userId?: string; text: string } | null {
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  if (chatId === undefined || typeof text !== "string" || text.trim() === "") return null;
  const userId = message?.from?.id === undefined ? undefined : String(message.from.id);
  return { chatId: String(chatId), userId, text };
}

async function safeJson<T>(req: Request): Promise<T | null> {
  try { return await req.json() as T; } catch { return null; }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
