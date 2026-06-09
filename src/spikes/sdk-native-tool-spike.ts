import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

const server = createSdkMcpServer({
  name: "claudebot_spike",
  version: "0.0.0",
  alwaysLoad: true,
  tools: [
    tool(
      "claudebot_echo",
      "Echo text back from the claudebot in-process native tool runtime.",
      { text: z.string() },
      async ({ text }) => ({
        content: [{ type: "text", text: `echo:${text}` }],
      }),
    ),
  ],
});

const prompt = "Call the claudebot_echo tool with text 'ok', then summarize the result.";

const model = process.env.CLAUDEBOT_MODEL || "glm-5.1";

console.error(`[spike] using model=${model} baseUrl=${process.env.ANTHROPIC_BASE_URL}`);

for await (const message of query({
  prompt,
  options: {
    model,
    mcpServers: {
      claudebot_spike: server,
    },
    permissionMode: "bypassPermissions",
    maxTurns: 5,
  },
})) {
  console.log(JSON.stringify(message));
}
