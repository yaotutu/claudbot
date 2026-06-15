import { z } from "zod/v4";
import type { ToolRegistry } from "../registry.ts";
import {
  appendMemoryEvent,
  readMemoryFile,
  searchMemoryText,
} from "../../memory/markdown-store.ts";
import { runMemoryDream } from "../../memory/dream.ts";
import { listMemoryCommits, revertMemoryCommit, showMemoryCommitDiff } from "../../memory/git-store.ts";
import type { MemoryMarkdownPaths, MemoryReadableFile, MemorySearchScope } from "../../memory/types.ts";

const MemoryReadablePathSchema = z.enum(["user.md", "soul.md", "memory/MEMORY.md"]);
const MemorySearchScopeSchema = z.enum(["all", "profile", "long_term", "events"]);

export function registerMemoryTools(registry: ToolRegistry, deps: { memoryPaths: MemoryMarkdownPaths }): void {
  const { memoryPaths } = deps;

  registry.register({
    name: "memory_read",
    description: "Read a controlled memory file: user.md, soul.md, or memory/MEMORY.md.",
    prompt: {
      section: "Memory",
      priority: 10,
      content: [
        "Use memory tools only for durable facts, stable preferences, and long-term project context.",
        "The original conversation transcript is stored only in sessions/<sessionId>/main.jsonl; memory tools must not create a second chat log.",
        "Route personal user facts to user.md, assistant behavior rules to soul.md, and project context to memory/MEMORY.md.",
        "Do not store transient chat details, guesses, public knowledge, or sensitive secrets unless the user explicitly asks.",
        "Search existing memory before appending candidates. Prefer correcting stale facts over duplicating them.",
        "Use memory_dream to consolidate candidates into long-term files; do not bypass Dream for broad rewrites.",
      ].join("\n"),
    },
    inputSchema: z.object({
      path: MemoryReadablePathSchema,
    }),
    execute: async (input) => readMemoryFile(memoryPaths, input.path as MemoryReadableFile),
  });

  registry.register({
    name: "memory_search",
    description: "Search profile files, long-term memory, and memory event records by substring.",
    inputSchema: z.object({
      query: z.string().min(1),
      maxResults: z.number().int().min(1).max(100).optional(),
      scope: MemorySearchScopeSchema.optional(),
    }),
    execute: async (input) => searchMemoryText(memoryPaths, input.query, {
      maxResults: input.maxResults,
      scope: input.scope as MemorySearchScope | undefined,
    }),
  });

  registry.register({
    name: "memory_append_note",
    description: "Append a candidate memory event for later Dream consolidation. Does not update MEMORY.md directly.",
    inputSchema: z.object({
      content: z.string().min(1),
    }),
    execute: async (input, context) => {
      const record = {
        type: "candidate",
        id: `cand_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        sessionId: context.sessionId ?? "global",
        content: input.content,
        createdAt: new Date().toISOString(),
      };
      await appendMemoryEvent(memoryPaths, record);
      return { appended: true, record };
    },
  });

  registry.register({
    name: "memory_dream",
    description: "Run memory Dream consolidation from pending candidate events into MEMORY.md with Git audit commits.",
    inputSchema: z.object({
      dryRun: z.boolean().default(false),
    }),
    execute: async (input) => runMemoryDream(memoryPaths, { dryRun: input.dryRun }),
  });

  registry.register({
    name: "memory_log",
    description: "List recent memory Git audit commits.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20),
    }),
    execute: async (input) => listMemoryCommits(memoryPaths, input.limit),
  });

  registry.register({
    name: "memory_diff",
    description: "Show the Git diff for a memory audit commit.",
    inputSchema: z.object({ sha: z.string().min(1) }),
    execute: async (input) => ({ diff: await showMemoryCommitDiff(memoryPaths, input.sha) }),
  });

  registry.register({
    name: "memory_revert",
    description: "Revert a memory audit commit and create a new revert commit.",
    inputSchema: z.object({ sha: z.string().min(1) }),
    execute: async (input) => revertMemoryCommit(memoryPaths, input.sha),
  });
}
