import type { ServiceContainer } from "../runtime/services.ts";
import { createQqAdapter } from "./qq/adapter.ts";
import type { QqClient } from "./qq/types.ts";
import { createTelegramAdapter } from "./telegram/adapter.ts";
import type { TelegramClient } from "./telegram/types.ts";

export type ChannelRegistry = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  handleHttp: (req: Request, url: URL) => Promise<Response | null>;
};

export type ChannelRegistryDeps = {
  telegram?: TelegramClient;
  qq?: QqClient;
};

export function createChannelRegistry(services: ServiceContainer, deps: ChannelRegistryDeps = {}): ChannelRegistry {
  const adapters: ChannelRegistry[] = [];
  if (services.config.channels.telegram.enabled) {
    adapters.push(createTelegramAdapter(services, services.config.channels.telegram, deps.telegram));
  }
  if (services.config.channels.qq.enabled) {
    adapters.push(createQqAdapter(services, services.config.channels.qq, deps.qq));
  }

  return {
    async start() {
      for (const adapter of adapters) await adapter.start();
    },
    async stop() {
      for (const adapter of adapters.slice().reverse()) await adapter.stop();
    },
    async handleHttp(req, url) {
      for (const adapter of adapters) {
        const response = await adapter.handleHttp(req, url);
        if (response) return response;
      }
      return null;
    },
  };
}

export function createEmptyChannelRegistry(): ChannelRegistry {
  return {
    start: async () => {},
    stop: async () => {},
    handleHttp: async () => null,
  };
}
