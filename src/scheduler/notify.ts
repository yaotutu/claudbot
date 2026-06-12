// Schedule notification bridge: turns completed background schedule runs into
// user-visible delivery records. Default delivery is WebUI notifications, not
// chat session messages.

import type { WsServerMessage } from "../gateway/protocol.ts";
import type { NotificationRecord } from "../notifications/types.ts";
import type { ServiceContainer } from "../runtime/services.ts";

export type ScheduleDeliveryPayload = {
  scheduleId: string;
  scheduleName: string;
  runId: string;
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

export async function deliverScheduleResultToNotification(
  services: ServiceContainer,
  payload: ScheduleDeliveryPayload,
  broadcast: (message: WsServerMessage) => void,
): Promise<NotificationRecord> {
  const notification = await services.notificationStore.create({
    source: "schedule",
    title: `定时任务 ${payload.scheduleName}`,
    content: payload.result,
    status: payload.status,
    scheduleId: payload.scheduleId,
    runId: payload.runId,
    delivery: { type: "webui_inbox", scope: "global" },
  });

  broadcast({ type: "notification.created", notification });
  broadcast({
    type: "schedule.run.completed",
    scheduleId: payload.scheduleId,
    runId: payload.runId,
    status: payload.status,
  });
  return notification;
}
