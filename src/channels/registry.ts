import type { ServiceContainer } from "../runtime/services.ts";
import type { ChannelAdapter } from "./adapter.ts";
import { createChannelManager, type ChannelManager } from "./manager.ts";
import { createQqAdapter } from "./qq/adapter.ts";
import type { QqClient } from "./qq/types.ts";
import { createTelegramAdapter } from "./telegram/adapter.ts";
import type { TelegramClient } from "./telegram/types.ts";

export type ChannelRegistry = ChannelManager;

export type ChannelRegistryDeps = {
  telegram?: TelegramClient;
  qq?: QqClient;
};

export function createChannelRegistry(services: ServiceContainer, deps: ChannelRegistryDeps = {}): ChannelRegistry {
  const adapters: ChannelAdapter[] = [];
  if (services.config.channels.telegram.enabled) {
    adapters.push(createTelegramAdapter(services, services.config.channels.telegram, deps.telegram));
  }
  if (services.config.channels.qq.enabled) {
    adapters.push(createQqAdapter(services, services.config.channels.qq, deps.qq));
  }

  return createChannelManager(services, { adapters });
}

export function createEmptyChannelRegistry(): ChannelRegistry {
  return {
    start: async () => {},
    stop: async () => {},
    handleHttp: async () => null,
    dispatchInbound: async () => {
      throw new Error("channel registry is not configured");
    },
    dispatchOutbound: async () => {},
  };
}
