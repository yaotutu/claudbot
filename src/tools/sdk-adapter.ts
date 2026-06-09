import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { ToolContext } from "./types.ts";
import type { ToolRegistry } from "./registry.ts";

export function createClaudebotSdkMcpServer(registry: ToolRegistry, context: ToolContext) {
  return createSdkMcpServer({
    name: "claudebot",
    version: "0.1.0",
    alwaysLoad: true,
    instructions: "Claudebot native tools for this personal assistant instance. Use memory_* for user preferences, schedule_* for cron reminders, agent_file_* to read or update user.md/soul.md/memory.json.",
    tools: registry.list().map((nativeTool) =>
      sdkTool(nativeTool.name, nativeTool.description, nativeTool.inputSchema as any, async (args: any) => {
        try {
          const result = await registry.execute(nativeTool.name, args, context);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `error: ${msg}` }],
            isError: true,
          };
        }
      }),
    ),
  });
}
