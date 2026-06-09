import { z } from "zod/v4";
import type { ToolRegistry } from "../registry.ts";
import type { MemoryStore } from "../../memory/store.ts";

const MemoryWriteInput = z.object({
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  source: z.string().default("conversation"),
  confidence: z.number().min(0).max(1).default(1),
});

export function registerMemoryTools(registry: ToolRegistry, deps: { memory: MemoryStore }): void {
  const { memory } = deps;

  registry.register({
    name: "memory_read",
    description: "Read a memory entry by id.",
    inputSchema: z.object({ id: z.string().min(1) }),
    execute: async (input) => memory.get(input.id),
  });

  registry.register({
    name: "memory_create",
    description: "Create a new memory entry.",
    inputSchema: MemoryWriteInput,
    execute: async (input) => memory.create(input),
  });

  registry.register({
    name: "memory_update",
    description: "Update an existing memory entry by id.",
    inputSchema: z.object({
      id: z.string().min(1),
      content: z.string().min(1).optional(),
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
    execute: async (input) => {
      const { id, ...patch } = input;
      return memory.update(id, patch);
    },
  });

  registry.register({
    name: "memory_delete",
    description: "Delete a memory entry by id.",
    inputSchema: z.object({ id: z.string().min(1) }),
    execute: async (input) => { await memory.delete(input.id); return { deleted: input.id }; },
  });

  registry.register({
    name: "memory_search",
    description: "Search memory entries by content or tag substring.",
    inputSchema: z.object({ query: z.string().min(1) }),
    execute: async (input) => memory.search(input.query),
  });
}
