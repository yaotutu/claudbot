import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { ToolContext, ToolContextRef } from "./types.ts";
import type { ToolRegistry } from "./registry.ts";

type ToolContextSource = ToolContext | ToolContextRef;

function resolveContext(source: ToolContextSource): ToolContext {
  return "current" in source ? source.current : source;
}

export function createClaudebotSdkMcpServer(registry: ToolRegistry, contextSource: ToolContextSource) {
  return createSdkMcpServer({
    name: "claudebot",
    version: "0.1.0",
    alwaysLoad: true,
    instructions: "Claudebot native tools. Follow the system prompt tool instructions and each tool schema.",
    tools: registry.list().map((nativeTool) =>
      sdkTool(nativeTool.name, nativeTool.description, nativeTool.inputSchema as any, async (args: any) => {
        try {
          const result = await registry.execute(nativeTool.name, args, resolveContext(contextSource));
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
