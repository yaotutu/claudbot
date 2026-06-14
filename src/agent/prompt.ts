// Prompt builder for Claude runs.
// Per spec, inject: time, timezone, home, workspace, session key, source marker,
// user.md, soul.md, and tool instructions.

import { readFile } from "node:fs/promises";
import type { ToolPrompt } from "../tools/types.ts";

export type PromptInputs = {
  home: string;
  workspacePath: string;
  timezone: string;
  source: "user_turn" | "schedule_turn";
  sessionId?: string;
  scheduleRunId?: string;
  userFile: string;
  soulFile: string;
  toolPrompts?: ToolPrompt[];
  now?: Date;
};

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
  parts.push(renderToolPrompts(inputs.toolPrompts ?? []));

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

function renderToolPrompts(toolPrompts: ToolPrompt[]): string {
  if (toolPrompts.length === 0) return "No native tools are currently available.";

  const parts = ["You have access to claudebot native tools. Follow each tool schema and the guidance below."];
  for (const prompt of toolPrompts) {
    parts.push("");
    parts.push(`## ${prompt.section}`);
    parts.push(prompt.content);
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
