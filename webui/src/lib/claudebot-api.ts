import type {
  CreateSchedulePayload,
  NotificationRecord,
  RuntimeInfo,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleRunStartResult,
  SessionSummary,
  ThreadMessage,
  UpdateSchedulePayload,
  WebuiBootstrap,
} from "./claudebot-types";

export class ClaudebotApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ClaudebotApiError";
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...(init ?? {}),
    credentials: "same-origin",
    headers: {
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ClaudebotApiError(response.status, text || `HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new ClaudebotApiError(response.status, "Gateway returned a non-JSON response.");
  }
  return await response.json() as T;
}

export async function fetchBootstrap(base = ""): Promise<WebuiBootstrap> {
  const raw = await request<unknown>(`${base}/webui/bootstrap`);
  return normalizeBootstrap(raw);
}

export async function fetchRuntime(base = ""): Promise<RuntimeInfo> {
  return request<RuntimeInfo>(`${base}/api/runtime`);
}

export async function listSessions(base = ""): Promise<SessionSummary[]> {
  return request<SessionSummary[]>(`${base}/api/sessions`);
}

export async function fetchThreadMessages(sessionId: string, base = ""): Promise<ThreadMessage[]> {
  return request<ThreadMessage[]>(`${base}/api/sessions/${encodeURIComponent(sessionId)}/messages`);
}

export async function deleteSession(sessionId: string, base = ""): Promise<boolean> {
  const body = await request<{ deleted: boolean | string }>(`${base}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  return Boolean(body.deleted);
}

export async function renameSession(sessionId: string, title: string, base = ""): Promise<void> {
  await request(`${base}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function listSchedules(base = ""): Promise<ScheduleRecord[]> {
  return request<ScheduleRecord[]>(`${base}/api/schedules`);
}

export async function createSchedule(input: CreateSchedulePayload, base = ""): Promise<ScheduleRecord> {
  return request<ScheduleRecord>(`${base}/api/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateSchedule(scheduleId: string, patch: UpdateSchedulePayload, base = ""): Promise<ScheduleRecord> {
  return request<ScheduleRecord>(`${base}/api/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function deleteSchedule(scheduleId: string, base = ""): Promise<boolean> {
  const body = await request<{ deleted: string }>(`${base}/api/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
  return body.deleted === scheduleId;
}

export async function runScheduleNow(scheduleId: string, base = ""): Promise<ScheduleRunStartResult> {
  return request<ScheduleRunStartResult>(`${base}/api/schedules/${encodeURIComponent(scheduleId)}/run-now`, { method: "POST" });
}

export async function fetchScheduleRuns(scheduleId?: string, base = ""): Promise<ScheduleRunRecord[]> {
  const query = scheduleId ? `?scheduleId=${encodeURIComponent(scheduleId)}` : "";
  return request<ScheduleRunRecord[]>(`${base}/api/schedule-runs${query}`);
}

export async function fetchNotifications(base = ""): Promise<NotificationRecord[]> {
  return request<NotificationRecord[]>(`${base}/api/notifications`);
}

export async function markNotificationsRead(base = ""): Promise<number> {
  const body = await request<{ updated: number }>(`${base}/api/notifications/read-all`, { method: "POST" });
  return body.updated;
}

function normalizeBootstrap(raw: unknown): WebuiBootstrap {
  const body = isRecord(raw) ? raw : {};
  if (!isRuntimeInfo(body.runtime)) throw new Error("Invalid claudebot bootstrap runtime");
  if (!isRecord(body.ws) || typeof body.ws.path !== "string") throw new Error("Invalid claudebot bootstrap websocket path");
  return {
    runtime: body.runtime,
    ws: { path: body.ws.path },
    sessions: Array.isArray(body.sessions) ? body.sessions as SessionSummary[] : [],
    activeSessionId: normalizeSessionId(
      typeof body.activeSessionId === "string" ? body.activeSessionId : null,
    ),
  };
}

function normalizeSessionId(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const trimmed = sessionId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  if (!isRecord(value)) return false;
  return typeof value.home === "string"
    && typeof value.workspace === "string"
    && isRecord(value.gateway)
    && typeof value.gateway.host === "string"
    && typeof value.gateway.port === "number"
    && typeof value.model === "string"
    && typeof value.providerModel === "string"
    && typeof value.permissionMode === "string";
}
