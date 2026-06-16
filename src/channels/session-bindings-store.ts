import { readJson, writeJsonAtomic } from "../utils/fs.ts";
import type { ChannelId, ChannelSessionBinding, UpsertChannelSessionBindingInput } from "./types.ts";

type ChannelBindingsFile = { bindings: ChannelSessionBinding[] };

export type ChannelSessionBindingStore = {
  list: () => Promise<ChannelSessionBinding[]>;
  find: (channel: ChannelId, externalConversationId: string) => Promise<ChannelSessionBinding | null>;
  upsert: (input: UpsertChannelSessionBindingInput) => Promise<ChannelSessionBinding>;
  delete: (channel: ChannelId, externalConversationId: string) => Promise<boolean>;
};

export function createChannelSessionBindingStore(path: string): ChannelSessionBindingStore {
  const list = async (): Promise<ChannelSessionBinding[]> => {
    const file = await readJson<ChannelBindingsFile>(path, { bindings: [] });
    return file.bindings;
  };

  const find = async (channel: ChannelId, externalConversationId: string): Promise<ChannelSessionBinding | null> => {
    const bindings = await list();
    return bindings.find((binding) => binding.channel === channel && binding.externalConversationId === externalConversationId) ?? null;
  };

  const upsert = async (input: UpsertChannelSessionBindingInput): Promise<ChannelSessionBinding> => {
    const bindings = await list();
    const now = new Date().toISOString();
    const existing = bindings.find((binding) => binding.channel === input.channel && binding.externalConversationId === input.externalConversationId);
    const nextBinding: ChannelSessionBinding = existing
      ? { ...existing, ...input, updatedAt: now }
      : { ...input, createdAt: now, updatedAt: now };
    const nextBindings = existing
      ? bindings.map((binding) => binding === existing ? nextBinding : binding)
      : [...bindings, nextBinding];
    await writeJsonAtomic(path, { bindings: nextBindings });
    return nextBinding;
  };

  const deleteBinding = async (channel: ChannelId, externalConversationId: string): Promise<boolean> => {
    const bindings = await list();
    const nextBindings = bindings.filter((binding) => !(binding.channel === channel && binding.externalConversationId === externalConversationId));
    if (nextBindings.length === bindings.length) return false;
    await writeJsonAtomic(path, { bindings: nextBindings });
    return true;
  };

  return { list, find, upsert, delete: deleteBinding };
}
