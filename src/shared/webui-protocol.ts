import type { NotificationRecord } from "../notifications/types.ts";
import type { ScheduleRecord, ScheduleRunRecord } from "../scheduler/types.ts";

export const WEBUI_PROTOCOL_VERSION = 1;

export type RuntimeInfo = {
  home: string;
  workspace: string;
  gateway: { host: string; port: number };
  model: string;
  providerModel: string;
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

export type WebuiMcpServerConfig = {
  name: string;
  type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  timeout?: number;
  alwaysLoad?: boolean;
  envKeys?: string[];
  headerKeys?: string[];
};

export type WebuiMcpConfig = {
  strict: boolean;
  servers: WebuiMcpServerConfig[];
};

export type RuntimeMcpServerStatus = {
  name: string;
  status: string;
  [key: string]: unknown;
};

export type WebuiMcpSessionStatus = {
  sessionId: string;
  runtimeStatus: "idle" | "running" | "cancelling" | "failed" | "closed" | "not_started";
  servers: RuntimeMcpServerStatus[];
};

export type ThreadActivityStatus = "running" | "complete" | "error";

export type ThreadActivity =
  | {
      id: string;
      kind: "thinking";
      runId: string;
      text: string;
      status: ThreadActivityStatus;
      createdAt: string;
      updatedAt: string;
    }
  | {
      id: string;
      kind: "tool";
      runId: string;
      toolId: string;
      name: string;
      phase: ToolFrame["phase"];
      input?: unknown;
      output?: unknown;
      isError?: boolean;
      status: ThreadActivityStatus;
      createdAt: string;
      updatedAt: string;
    }
  | {
      id: string;
      kind: "status";
      runId: string;
      text: string;
      status: ThreadActivityStatus;
      mcpServers?: RuntimeMcpServerStatus[];
      createdAt: string;
      updatedAt: string;
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
  | {
      type: "run.status";
      sessionId?: string;
      runId?: string;
      status: string;
      mcpServers?: RuntimeMcpServerStatus[];
      message?: string;
      retryAttempt?: number;
      maxRetries?: number;
      retryInMs?: number;
    }
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
