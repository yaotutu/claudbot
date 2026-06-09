import { query } from "@anthropic-ai/claude-agent-sdk";

const resumeId = process.env.CLAUDEBOT_RESUME_ID;
if (!resumeId) {
  console.error("usage: CLAUDEBOT_RESUME_ID=<session_id> bun run src/spikes/sdk-resume-spike.ts");
  process.exit(2);
}

const prompt = "Without re-summarizing the previous turn, briefly: what was the tool name and its return value last time? Reply in one short sentence.";

for await (const message of query({
  prompt,
  options: {
    model: process.env.CLAUDEBOT_MODEL || "glm-5.1",
    resume: resumeId,
    permissionMode: "bypassPermissions",
    maxTurns: 1,
  },
})) {
  console.log(JSON.stringify(message));
}
