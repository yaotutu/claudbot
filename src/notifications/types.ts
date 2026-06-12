export type DeliveryChannel =
  | { type: "webui_inbox"; scope: "global" | "agent"; agentId?: string }
  | { type: "telegram"; chatId: string }
  | { type: "session"; sessionId: string };

export type NotificationSource = "schedule";

export type NotificationRecord = {
  id: string;
  source: NotificationSource;
  title: string;
  content: string;
  status: "succeeded" | "failed";
  scheduleId: string;
  runId: string;
  delivery: DeliveryChannel;
  createdAt: string;
  readAt: string | null;
};

export type CreateNotificationInput = Omit<NotificationRecord, "id" | "createdAt" | "readAt">;
