import type { NativeTool, ToolContext } from "./types.ts";
import { resolveToolPolicy, type ToolPermissionConfig } from "./permissions.ts";
import { ToolAuditLog } from "./audit.ts";

export class ToolRegistry {
  private readonly tools = new Map<string, NativeTool<any, any>>();
  private readonly audit: ToolAuditLog | null;

  constructor(
    private readonly permissions: ToolPermissionConfig,
    auditPath?: string,
  ) {
    this.audit = auditPath ? new ToolAuditLog(auditPath) : null;
  }

  register(tool: NativeTool<any, any>): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  list(): NativeTool<any, any>[] {
    return [...this.tools.values()];
  }

  async execute(name: string, rawInput: unknown, context: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
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
      await this.audit?.append({ ...baseRecord, status: "failed", error: `unknown tool: ${name}` });
      throw new Error(`unknown tool: ${name}`);
    }
    const policy = resolveToolPolicy(this.permissions, name);
    if (policy === "deny") {
      await this.audit?.append({ ...baseRecord, status: "denied", error: "denied by policy" });
      throw new Error(`tool denied: ${name}`);
    }
    if (policy === "confirm") {
      await this.audit?.append({ ...baseRecord, status: "denied", error: "confirmation UI not implemented in MVP" });
      throw new Error(`tool denied: ${name} (confirmation UI not implemented in MVP)`);
    }
    let input: unknown;
    try {
      input = tool.inputSchema.parse(rawInput);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.audit?.append({ ...baseRecord, status: "failed", error: `validation: ${msg}` });
      throw new Error(`tool input validation failed for ${name}: ${msg}`);
    }
    try {
      const result = await tool.execute(input as never, context);
      await this.audit?.append({ ...baseRecord, status: "succeeded" });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.audit?.append({ ...baseRecord, status: "failed", error: msg });
      throw err;
    }
  }
}

function safeInputSummary(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 500 ? s.slice(0, 500) + "..." : s;
  } catch {
    return "<unserializable>";
  }
}
