export type RuntimeInfo = {
  home: string;
  workspace: string;
  gateway: { host: string; port: number };
  model: string;
  permissionMode: string;
};

export type SessionSummary = {
  id: string;
  title: string;
  preview: string;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  status: "persisted";
};

export type DraftSession = {
  id: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  status: "draft";
};

export type ThreadMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type WebuiBootstrap = {
  runtime: RuntimeInfo;
  ws: { path: string };
  sessions: SessionSummary[];
  activeSessionId: string | null;
};

export type ScheduleKind = "at" | "every" | "cron";

export type ScheduleRecord = {
  id: string;
  name: string;
  enabled: boolean;
  kind: ScheduleKind;
  cronExpr: string;
  at: string | null;
  everyMs: number | null;
  timezone: string;
  message: string;
  deleteAfterRun: boolean;
  state: {
    nextRunAt: string;
    lastRunAt: string | null;
    lastStatus: string | null;
    lastError: string | null;
    runCount: number;
    running: boolean;
    runningStartedAt: string | null;
    lastSkippedReason: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type ScheduleRunRecord = {
  id: string;
  scheduleId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "succeeded" | "failed" | "skipped_running";
  result: string;
  error: string;
};

export type DeliveryChannel =
  | { type: "webui_inbox"; scope: "global" | "agent"; agentId?: string }
  | { type: "telegram"; chatId: string }
  | { type: "session"; sessionId: string };

export type NotificationRecord = {
  id: string;
  source: "schedule";
  title: string;
  content: string;
  status: "succeeded" | "failed";
  scheduleId: string;
  runId: string;
  delivery: DeliveryChannel;
  createdAt: string;
  readAt: string | null;
};

export type CreateSchedulePayload = {
  name: string;
  message: string;
  cronExpr?: string;
  at?: string;
  everyMs?: number;
  timezone?: string;
};

export type UpdateSchedulePayload = Partial<CreateSchedulePayload> & { enabled?: boolean };

export type ClientFrame =
  | { type: "session.activate"; sessionId: string | null }
  | { type: "chat.send"; sessionId?: string; draftId?: string; content: string }
  | { type: "chat.cancel"; sessionId: string };

export type ServerFrame =
  | { type: "session.activated"; sessionId: string | null }
  | { type: "session.created"; draftId?: string; session: SessionSummary }
  | { type: "session.updated"; session: SessionSummary }
  | { type: "message.appended"; sessionId: string; message: ThreadMessage }
  | { type: "run.started"; sessionId: string; runId: string }
  | { type: "run.delta"; sessionId: string; runId: string; text: string }
  | { type: "run.thinking"; sessionId: string; runId: string; text: string }
  | { type: "run.tool"; sessionId: string; runId: string; tool: Record<string, unknown> }
  | { type: "run.completed"; sessionId: string; runId: string; isError: boolean; result?: string; totalCostUsd?: number }
  | { type: "run.error"; sessionId?: string; runId?: string; message: string }
  | { type: "schedule.updated"; schedule: ScheduleRecord }
  | { type: "schedule.deleted"; scheduleId: string }
  | { type: "notification.created"; notification: NotificationRecord }
  | { type: "schedule.run.completed"; scheduleId: string; runId: string; status: "succeeded" | "failed" };
