// Schedule notification — bridge between trigger execution and delivery channels.
// Owns the JSONL fallback (append to last active session) and delegates to
// whatever broadcast mechanism server.ts wires in via the mutable notifier.

import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ScheduleDeliveryPayload = {
  scheduleId: string;
  scheduleName: string;
  status: "succeeded" | "failed";
  result: string;
};

export type ScheduleNotifier = {
  deliver: (payload: ScheduleDeliveryPayload) => Promise<void>;
};

/** Create a no-op notifier. server.ts replaces `deliver` after WS handlers are ready. */
export function createNoopNotifier(): ScheduleNotifier {
  return { deliver: async () => {} };
}

/**
 * Append a schedule result as an assistant message to a session's main.jsonl.
 * The entry format matches what jsonl-parser.ts expects:
 *   { type, uuid, timestamp, message: { role, content: [{type,text}] } }
 */
export async function appendScheduleResult(
  sessionsDir: string,
  sessionId: string,
  payload: ScheduleDeliveryPayload,
): Promise<void> {
  const entry = {
    type: "assistant",
    uuid: `sched-${payload.scheduleId}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[定时任务 ${payload.scheduleName}] ${payload.result}`,
        },
      ],
    },
  };

  const filePath = join(sessionsDir, sessionId, "main.jsonl");
  // Ensure directory exists (session dir may not exist yet)
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
}
