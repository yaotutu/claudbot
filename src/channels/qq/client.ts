import { QQBotClient } from "pure-qqbot";
import type { MessageEvent } from "pure-qqbot";
import type { QqClient, QqConfig, QqMessageEvent } from "./types.ts";

export function createQqClient(config: QqConfig, defaultSessionDir: string): QqClient {
  const client = new QQBotClient({
    appId: config.appId,
    clientSecret: config.clientSecret,
    sessionDir: config.sessionDir || defaultSessionDir,
    typingKeepAlive: config.typingKeepAlive,
    parseFaceEmoji: config.parseFaceEmoji,
    logger: {
      info: (message) => console.info(`[qq] ${message}`),
      error: (message) => console.error(`[qq] ${message}`),
      debug: () => {},
    },
  });

  return {
    start: () => client.start(),
    stop: () => client.stop(),
    onMessage: (handler) => client.onMessage((event) => handler(event as QqMessageEvent)),
    reply: (event, content) => client.reply(event as MessageEvent, content),
    sendPrivateMessageProactive: (openid, content) => client.sendPrivateMessageProactive(openid, content),
    sendGroupMessageProactive: (groupOpenid, content) => client.sendGroupMessageProactive(groupOpenid, content),
  };
}
