// Schedule notification — bridge between trigger execution and delivery channels.
// Owns the JSONL fallback (append to last active session) and delegates to
// whatever broadcast mechanism server.ts wires in via the mutable notifier.

import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServiceContainer } from "../runtime/services.ts";
import type { WsServerMessage } from "../gateway/protocol.ts";
import { sessionExists } from "../sessions/adapter.ts";

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

export type ScheduleDeliveryTarget = {
  sessionId: string;
  message: WsServerMessage;
};

export async function deliverScheduleResultToActiveSession(
  services: ServiceContainer,
  payload: ScheduleDeliveryPayload,
  broadcast: (message: WsServerMessage) => void,
): Promise<ScheduleDeliveryTarget | null> {
  const sessionId = await resolveScheduleDeliverySessionId(services);
  if (!sessionId) return null;

  await appendScheduleResult(services.paths.sessionsDir, sessionId, payload);
  const message: WsServerMessage = {
    type: "message.appended",
    sessionId,
    message: {
      id: `sched-${payload.scheduleId}-${Date.now()}`,
      role: "assistant",
      content: `[定时任务 ${payload.scheduleName}] ${payload.result}`,
      createdAt: new Date().toISOString(),
      metadata: { source: "schedule", scheduleId: payload.scheduleId },
    },
  };
  broadcast(message);
  return { sessionId, message };
}

async function resolveScheduleDeliverySessionId(
  services: ServiceContainer,
): Promise<string | null> {
  const state = await services.runtimeState.get();
  if (state.lastActiveSessionId) {
    const exists = await sessionExists(services.paths.sessionsDir, state.lastActiveSessionId);
    if (exists) return state.lastActiveSessionId;
    await services.runtimeState.setLastActiveSession("", "schedule_delivery_stale_reset");
  }

  const [latest] = await services.sdkSessions.list("claudebot");
  if (!latest?.sessionId) return null;
  await services.runtimeState.setLastActiveSession(latest.sessionId, "schedule_delivery_fallback");
  return latest.sessionId;
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
