import { z } from "zod/v4";
import type { ToolRegistry } from "../registry.ts";
import type { AgentProfileStore, AgentFileName } from "../../agent/profile.ts";

const ALLOWED: AgentFileName[] = ["user.md", "soul.md", "memory.json"];
const NameSchema = z.enum(ALLOWED);

function assertAllowed(name: string): asserts name is AgentFileName {
  if (!ALLOWED.includes(name as AgentFileName)) {
    throw new Error(`agent file not allowed: ${name}`);
  }
}

export function registerAgentFileTools(registry: ToolRegistry, deps: { profile: AgentProfileStore }): void {
  const { profile } = deps;

  registry.register({
    name: "agent_file_read",
    description: "Read an agent file (user.md, soul.md, or memory.json). Returns content and a version hash for optimistic concurrency.",
    prompt: {
      section: "Agent profile files",
      priority: 30,
      content: [
        "Use agent_file_read and agent_file_update to inspect or edit user.md, soul.md, or memory.json.",
        "agent_file_update requires an expected version hash; read the target file first and pass the returned hash.",
        "Prefer memory tools for small durable facts. Use profile files for larger user-controlled profile or assistant behavior text.",
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
    description: "Update an agent file. Requires the expected version hash for optimistic concurrency (returns version conflict on mismatch).",
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
