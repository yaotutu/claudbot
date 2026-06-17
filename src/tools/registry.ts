import type { NativeTool, ToolContext, ToolPrompt } from "./types.ts";
import { resolveToolPolicy, type ToolPermissionConfig } from "./permissions.ts";
import { createToolAuditLog } from "./audit.ts";

export type ToolRegistry = {
  register(tool: NativeTool<any, any>): void;
  list(): NativeTool<any, any>[];
  getPromptSections(): ToolPrompt[];
  execute(name: string, rawInput: unknown, context: ToolContext): Promise<unknown>;
};

export function createToolRegistry(permissions: ToolPermissionConfig, auditPath?: string): ToolRegistry {
  const tools = new Map<string, NativeTool<any, any>>();
  const audit = auditPath ? createToolAuditLog(auditPath) : null;

  return {
    register(tool: NativeTool<any, any>): void {
      if (tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
      tools.set(tool.name, tool);
    },

    list(): NativeTool<any, any>[] {
      return [...tools.values()];
    },

    getPromptSections(): ToolPrompt[] {
      return [...tools.values()]
        .flatMap((tool) => tool.prompt ? [tool.prompt] : [])
        .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    },

    async execute(name: string, rawInput: unknown, context: ToolContext): Promise<unknown> {
      const tool = tools.get(name);
      const at = new Date().toISOString();
      const baseRecord = {
        toolName: name,
        source: context.source,
        at,
        sessionId: context.sessionId,
        scheduleRunId: context.scheduleRunId,
        inputSummary: safeInputSummary(rawInput),
      };
      if (!tool) {
        await audit?.append({ ...baseRecord, status: "failed", error: `unknown tool: ${name}` });
        throw new Error(`unknown tool: ${name}`);
      }
      const policy = resolveToolPolicy(permissions, name);
      if (policy === "deny") {
        await audit?.append({ ...baseRecord, status: "denied", error: "denied by policy" });
        throw new Error(`tool denied: ${name}`);
      }
      if (policy === "confirm") {
        await audit?.append({ ...baseRecord, status: "denied", error: "confirmation UI not implemented in MVP" });
        throw new Error(`tool denied: ${name} (confirmation UI not implemented in MVP)`);
      }
      let input: unknown;
      try {
        input = tool.inputSchema.parse(rawInput);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await audit?.append({ ...baseRecord, status: "failed", error: `validation: ${msg}` });
        throw new Error(`tool input validation failed for ${name}: ${msg}`);
      }
      try {
        const result = await tool.execute(input as never, context);
        await audit?.append({ ...baseRecord, status: "succeeded" });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await audit?.append({ ...baseRecord, status: "failed", error: msg });
        throw err;
      }
    },
  };
}

function safeInputSummary(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 500 ? s.slice(0, 500) + "..." : s;
  } catch {
    return "<unserializable>";
  }
}
