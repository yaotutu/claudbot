import type { ServiceContainer } from "../../runtime/services.ts";
import type { ChannelAdapter } from "../adapter.ts";
import { runChannelTurn } from "../runtime.ts";
import { createQqClient } from "./client.ts";
import type { QqClient, QqConfig, QqMessageEvent } from "./types.ts";

type NormalizedQqMessage = {
  chatId: string;
  senderId: string;
  groupOpenid?: string;
  content: string;
};

export function createQqAdapter(
  services: ServiceContainer,
  config: QqConfig,
  client: QqClient = createQqClient(config, services.paths.qqSessionDir),
): ChannelAdapter {
  return {
    name: "qq",
    displayName: "QQ",
    async start() {
      client.onMessage((event) => handleQqMessage(services, config, client, event));
      await client.start();
    },
    async stop() {
      await client.stop();
    },
    async send(msg) {
      await sendProactiveByChatId(client, msg.chatId, msg.content);
    },
    handleHttp: async () => null,
  };
}

async function handleQqMessage(
  services: ServiceContainer,
  config: QqConfig,
  client: QqClient,
  event: QqMessageEvent,
): Promise<void> {
  const inbound = normalizeQqMessage(event);
  if (!inbound) return;
  if (!isAllowed(config, inbound)) return;

  const result = await runChannelTurn(services, {
    channel: "qq",
    chatId: inbound.chatId,
    senderId: inbound.senderId,
    content: inbound.content,
    media: [],
    metadata: {
      messageId: event.messageId,
      qqType: event.type,
      groupOpenid: event.groupOpenid,
      guildId: event.guildId,
      channelId: event.channelId,
    },
  });

  const sent = await client.reply(event, result.outbound.content);
  if (!sent.success) await sendProactiveFallback(client, event, result.outbound.content);
}

function normalizeQqMessage(event: QqMessageEvent): NormalizedQqMessage | null {
  const content = event.content.trim();
  if (!content) return null;
  if (event.type === "group") {
    if (!event.groupOpenid) return null;
    return {
      chatId: `group:${event.groupOpenid}`,
      senderId: event.senderId,
      groupOpenid: event.groupOpenid,
      content,
    };
  }
  if (event.type === "guild") {
    if (!event.guildId || !event.channelId) return null;
    return { chatId: `guild:${event.guildId}:${event.channelId}`, senderId: event.senderId, content };
  }
  if (event.type === "dm") {
    if (!event.guildId) return null;
    return { chatId: `dm:${event.guildId}:${event.senderId}`, senderId: event.senderId, content };
  }
  return { chatId: `c2c:${event.senderId}`, senderId: event.senderId, content };
}

function isAllowed(config: QqConfig, inbound: NormalizedQqMessage): boolean {
  if (config.allowFrom.length === 0 || config.allowFrom.includes("*")) return true;
  return config.allowFrom.includes(inbound.chatId)
    || config.allowFrom.includes(inbound.senderId)
    || (inbound.groupOpenid !== undefined && config.allowFrom.includes(inbound.groupOpenid));
}

async function sendProactiveByChatId(client: QqClient, chatId: string, content: string): Promise<void> {
  if (chatId.startsWith("group:")) {
    await client.sendGroupMessageProactive(chatId.slice("group:".length), content);
    return;
  }
  if (chatId.startsWith("c2c:")) {
    await client.sendPrivateMessageProactive(chatId.slice("c2c:".length), content);
    return;
  }
  const lastSegment = chatId.split(":").at(-1);
  if (lastSegment) await client.sendPrivateMessageProactive(lastSegment, content);
}

async function sendProactiveFallback(client: QqClient, event: QqMessageEvent, content: string): Promise<void> {
  if (event.type === "group" && event.groupOpenid) {
    await client.sendGroupMessageProactive(event.groupOpenid, content);
    return;
  }
  await client.sendPrivateMessageProactive(event.senderId, content);
}
