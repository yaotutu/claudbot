import type { ServiceContainer } from "../../runtime/services.ts";
import { runChannelTurn } from "../runtime.ts";
import type { ChannelRegistry } from "../registry.ts";
import { createQqClient } from "./client.ts";
import type { QqClient, QqConfig, QqMessageEvent } from "./types.ts";

type NormalizedQqMessage = {
  conversationId: string;
  senderId: string;
  groupOpenid?: string;
  content: string;
};

export function createQqAdapter(
  services: ServiceContainer,
  config: QqConfig,
  client: QqClient = createQqClient(config, services.paths.qqSessionDir),
): ChannelRegistry {
  return {
    async start() {
      client.onMessage((event) => handleQqMessage(services, config, client, event));
      await client.start();
    },
    async stop() {
      await client.stop();
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
    conversationId: inbound.conversationId,
    senderId: inbound.senderId,
    content: inbound.content,
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
      conversationId: `group:${event.groupOpenid}`,
      senderId: event.senderId,
      groupOpenid: event.groupOpenid,
      content,
    };
  }
  if (event.type === "guild") {
    if (!event.guildId || !event.channelId) return null;
    return { conversationId: `guild:${event.guildId}:${event.channelId}`, senderId: event.senderId, content };
  }
  if (event.type === "dm") {
    if (!event.guildId) return null;
    return { conversationId: `dm:${event.guildId}:${event.senderId}`, senderId: event.senderId, content };
  }
  return { conversationId: `c2c:${event.senderId}`, senderId: event.senderId, content };
}

function isAllowed(config: QqConfig, inbound: NormalizedQqMessage): boolean {
  const hasAnyAllowList = config.allowedConversationIds.length > 0
    || config.allowedUserIds.length > 0
    || config.allowedGroupOpenids.length > 0;
  if (!hasAnyAllowList) return true;
  if (config.allowedConversationIds.includes(inbound.conversationId)) return true;
  if (config.allowedUserIds.includes(inbound.senderId)) return true;
  if (inbound.groupOpenid && config.allowedGroupOpenids.includes(inbound.groupOpenid)) return true;
  return false;
}

async function sendProactiveFallback(client: QqClient, event: QqMessageEvent, content: string): Promise<void> {
  if (event.type === "group" && event.groupOpenid) {
    await client.sendGroupMessageProactive(event.groupOpenid, content);
    return;
  }
  await client.sendPrivateMessageProactive(event.senderId, content);
}
