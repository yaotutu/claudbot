import type { ServiceContainer } from "../runtime/services.ts";
import type { ChannelAdapter } from "./adapter.ts";
import { runChannelTurn } from "./runtime.ts";
import type { ChannelInboundMessage, ChannelOutboundMessage, ChannelRunResult } from "./types.ts";

export type ChannelManager = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  handleHttp: (req: Request, url: URL) => Promise<Response | null>;
  dispatchInbound: (message: ChannelInboundMessage) => Promise<ChannelRunResult>;
  dispatchOutbound: (message: ChannelOutboundMessage) => Promise<void>;
};

export type ChannelManagerDeps = {
  adapters?: ChannelAdapter[];
  retryDelaysMs?: number[];
};

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

export function createChannelManager(services: ServiceContainer, deps: ChannelManagerDeps = {}): ChannelManager {
  const adapters = deps.adapters ?? [];
  const adaptersByName = new Map(adapters.map((adapter) => [adapter.name, adapter]));
  const retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  const dispatchOutbound = async (message: ChannelOutboundMessage): Promise<void> => {
    const adapter = adaptersByName.get(message.channel);
    if (!adapter) return;
    await sendWithRetry(services, adapter, message, retryDelaysMs);
  };

  return {
    async start() {
      for (const adapter of adapters) await adapter.start();
    },
    async stop() {
      for (const adapter of adapters.slice().reverse()) await adapter.stop();
    },
    async handleHttp(req, url) {
      for (const adapter of adapters) {
        const response = await adapter.handleHttp?.(req, url);
        if (response) return response;
      }
      return null;
    },
    async dispatchInbound(message) {
      const result = await runChannelTurn(services, message);
      await dispatchOutbound(result.outbound);
      return result;
    },
    dispatchOutbound,
  };
}

async function sendWithRetry(
  services: ServiceContainer,
  adapter: ChannelAdapter,
  message: ChannelOutboundMessage,
  retryDelaysMs: number[],
): Promise<void> {
  const maxAttempts = resolveSendMaxRetries(services.config.channels);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await sendOnce(adapter, message);
      return;
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
      await sleep(retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 0);
    }
  }
}

async function sendOnce(adapter: ChannelAdapter, message: ChannelOutboundMessage): Promise<void> {
  if (message.metadata._reasoning_end) {
    await adapter.sendReasoningEnd?.(message.chatId, message.metadata);
    return;
  }
  if (message.metadata._reasoning_delta) {
    await adapter.sendReasoningDelta?.(message.chatId, message.content, message.metadata);
    return;
  }
  if (message.metadata._stream_delta || message.metadata._stream_end) {
    if (adapter.sendDelta) {
      await adapter.sendDelta(message.chatId, message.content, message.metadata);
      return;
    }
  }
  await adapter.send(message);
}

function resolveSendMaxRetries(channelsConfig: unknown): number {
  const value = typeof channelsConfig === "object" && channelsConfig !== null
    ? (channelsConfig as { sendMaxRetries?: unknown }).sendMaxRetries
    : undefined;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 3;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
