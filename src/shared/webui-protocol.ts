import type { NotificationRecord } from "../notifications/types.ts";
import type { ScheduleRecord, ScheduleRunRecord } from "../scheduler/types.ts";

export const WEBUI_PROTOCOL_VERSION = 1;

export type RuntimeInfo = {
  home: string;
  workspace: string;
  gateway: { host: string; port: number };
  model: string;
  permissionMode: string;
};

export type MemoryCommitSummary = {
  sha: string;
  message: string;
  createdAt: string;
};

export type MemoryStatus = {
  home: string;
  longTermFile: string;
  exists: boolean;
  sizeBytes: number;
  lastDreamAt: string | null;
  pendingCandidates: number;
  gitAudit: {
    available: boolean;
    reason?: string;
    latestCommit?: MemoryCommitSummary | null;
  };
};

export type MemoryDreamResult = {
  dryRun: boolean;
  applied: number;
  summary: string;
  commit?: string;
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

export type CreateSchedulePayload = {
  name: string;
  message: string;
  cronExpr?: string;
  at?: string;
  everyMs?: number;
  timezone?: string;
};

export type UpdateSchedulePayload = Partial<CreateSchedulePayload> & { enabled?: boolean };

export type ScheduleRunStartResult = {
  started: boolean;
  runId: string;
  scheduleId: string;
  status: ScheduleRunRecord["status"];
};

export type ClientFrame =
  | { type: "session.activate"; sessionId: string | null }
  | { type: "chat.send"; sessionId?: string; draftId?: string; content: string }
  | { type: "chat.cancel"; sessionId: string };

export type ToolFrame = {
  phase: "start" | "end" | "error";
  id: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
};

export type ServerFrame =
  | { type: "session.activated"; sessionId: string | null }
  | { type: "session.created"; draftId?: string; session: SessionSummary }
  | { type: "session.updated"; session: SessionSummary }
  | { type: "message.appended"; sessionId: string; message: ThreadMessage }
  | { type: "run.started"; sessionId: string; runId: string }
  | { type: "run.delta"; sessionId: string; runId: string; text: string }
  | { type: "run.thinking"; sessionId: string; runId: string; text: string }
  | { type: "run.tool"; sessionId: string; runId: string; tool: ToolFrame }
  | { type: "run.completed"; sessionId: string; runId: string; isError: boolean; result?: string; totalCostUsd?: number }
  | { type: "run.error"; sessionId?: string; runId?: string; message: string }
  | { type: "schedule.updated"; schedule: ScheduleRecord }
  | { type: "schedule.deleted"; scheduleId: string }
  | { type: "notification.created"; notification: NotificationRecord }
  | { type: "schedule.run.completed"; scheduleId: string; runId: string; status: "succeeded" | "failed" };

export type {
  DeliveryChannel,
  NotificationRecord,
} from "../notifications/types.ts";
export type {
  ScheduleKind,
  ScheduleRecord,
  ScheduleRunRecord,
} from "../scheduler/types.ts";
