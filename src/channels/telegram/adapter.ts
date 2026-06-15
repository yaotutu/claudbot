import type { ServiceContainer } from "../../runtime/services.ts";
import { runUserTurn } from "../../conversation/run-user-turn.ts";
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

      const existing = await services.channelBindings.find("telegram", inbound.chatId);
      let assistantText = "";
      let completedText = "";
      let erroredText = "";

      const result = await runUserTurn(
        services,
        { source: "telegram", sessionId: existing?.claudebotSessionId ?? null, content: inbound.text },
        {
          send: async (event) => {
            if (event.type === "session.created") {
              await services.channelBindings.upsert({
                channel: "telegram",
                externalConversationId: inbound.chatId,
                externalUserId: inbound.userId,
                claudebotSessionId: event.session.id,
              });
            }
            if (event.type === "message.appended") assistantText = event.message.content;
            if (event.type === "run.completed" && event.result) completedText = event.result;
            if (event.type === "run.error") erroredText = event.message;
          },
        },
      );

      if (!existing && result.sessionId) {
        await services.channelBindings.upsert({
          channel: "telegram",
          externalConversationId: inbound.chatId,
          externalUserId: inbound.userId,
          claudebotSessionId: result.sessionId,
        });
      }

      const reply = assistantText || completedText || erroredText || "(no response)";
      await client.sendMessage(inbound.chatId, reply);
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
