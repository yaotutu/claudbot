import { z } from "zod/v4";
import type { ToolRegistry } from "../registry.ts";
import type { AgentProfileStore, AgentFileName } from "../../agent/profile.ts";

const ALLOWED: AgentFileName[] = ["user.md", "soul.md"];

function assertAllowed(name: string): asserts name is AgentFileName {
  if (!ALLOWED.includes(name as AgentFileName)) {
    throw new Error(`agent file not allowed: ${name}`);
  }
}

export function registerAgentFileTools(registry: ToolRegistry, deps: { profile: AgentProfileStore }): void {
  const { profile } = deps;

  registry.register({
    name: "agent_file_read",
    description: "Read an agent profile file (user.md or soul.md). Returns content and a version hash for optimistic concurrency.",
    prompt: {
      section: "Agent profile files",
      priority: 30,
      content: [
        "Use agent_file_read and agent_file_update to inspect or edit user.md or soul.md.",
        "agent_file_update requires an expected version hash; read the target file first and pass the returned hash.",
        "agent_file_update replaces the entire target file. Before calling it, start from the full content returned by agent_file_read and preserve all existing content that should remain.",
        "Do not send a partial patch or excerpt to agent_file_update; its content field must be the complete new file content.",
        "For user.md and soul.md, make the smallest necessary whole-file rewrite and keep the user's existing structure, wording, and manually written details unless the user asked to change them.",
        "Use memory tools for long-term facts and project context that do not belong in user.md or soul.md.",
      ].join("\n"),
    },
    inputSchema: z.object({ name: z.string().min(1) }),
    execute: async (input) => {
      assertAllowed(input.name);
      return profile.readFile(input.name);
    },
  });

  registry.register({
    name: "agent_file_update",
    description: "Replace the entire content of an agent file. Requires the expected version hash from agent_file_read; content must be the complete new file, not a patch or excerpt.",
    inputSchema: z.object({
      name: z.string().min(1),
      content: z.string(),
      expectedVersion: z.string().min(1),
    }),
    execute: async (input) => {
      assertAllowed(input.name);
      return profile.updateFile(input.name, input.content, input.expectedVersion);
    },
  });
}
