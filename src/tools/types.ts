import type { z } from "zod/v4";

export type ToolPolicy = "allow" | "deny" | "confirm";
export type ToolSource = "user_turn" | "schedule_turn";

export type ToolContext = {
  source: ToolSource;
  home: string;
  workspacePath: string;
  timezone: string;
  sessionId?: string;
  scheduleRunId?: string;
  services: unknown;
};

export type NativeTool<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  execute(input: Input, context: ToolContext): Promise<Output>;
};
