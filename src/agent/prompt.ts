// Prompt builder for Claude runs.
// Per spec, inject: time, timezone, home, workspace, session key, source marker,
// user.md, soul.md, and tool instructions.

import { readFile } from "node:fs/promises";

export type PromptInputs = {
  home: string;
  workspacePath: string;
  timezone: string;
  source: "user_turn" | "schedule_turn";
  sessionId?: string;
  scheduleRunId?: string;
  userFile: string;
  soulFile: string;
  now?: Date;
};

const TOOL_INSTRUCTIONS = `You have access to claudebot native tools. Use them to remember user preferences and to schedule recurring work.

- memory_create / memory_read / memory_update / memory_delete / memory_search: persistent user preferences and notes. Write concise, durable facts; never store transient or session-specific details.
- schedule_create / schedule_list / schedule_update / schedule_delete / schedule_set_enabled / schedule_run_now: cron-driven one-off Claude turns. Each schedule runs as its own isolated Claude turn, not as a chat.
- agent_file_read / agent_file_update: edit user.md, soul.md, or memory.json. agent_file_update requires an expected version hash; you must agent_file_read first to obtain it.`;

export async function buildSystemPrompt(inputs: PromptInputs): Promise<string> {
  const now = inputs.now ?? new Date();
  const userContent = await safeRead(inputs.userFile);
  const soulContent = await safeRead(inputs.soulFile);

  const parts: string[] = [];
  parts.push(`# Claudebot runtime context`);
  parts.push(`- Current time: ${now.toISOString()}`);
  parts.push(`- Timezone: ${inputs.timezone}`);
  parts.push(`- Home: ${inputs.home}`);
  parts.push(`- Workspace: ${inputs.workspacePath}`);
  parts.push(`- Source: ${inputs.source}`);
  if (inputs.sessionId) parts.push(`- Session: ${inputs.sessionId}`);
  if (inputs.scheduleRunId) parts.push(`- Schedule run: ${inputs.scheduleRunId}`);

  parts.push("");
  parts.push(`# Tools`);
  parts.push(TOOL_INSTRUCTIONS);

  if (userContent) {
    parts.push("");
    parts.push(`# User profile (user.md)`);
    parts.push(userContent);
  }

  if (soulContent) {
    parts.push("");
    parts.push(`# Soul (soul.md)`);
    parts.push(soulContent);
  }

  return parts.join("\n");
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
