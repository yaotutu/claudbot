import type { RuntimeInfo, SessionSummary, ThreadMessage, WebuiBootstrap } from "./claudebot-types";

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

function normalizeBootstrap(raw: unknown): WebuiBootstrap {
  const body = isRecord(raw) ? raw : {};
  const runtime = isRecord(body.runtime)
    ? body.runtime as RuntimeInfo
    : legacyRuntime(body);
  const ws = isRecord(body.ws)
    ? body.ws as { path: string }
    : { path: typeof body.ws_path === "string" ? body.ws_path : "/ws" };
  return {
    runtime,
    ws,
    sessions: Array.isArray(body.sessions) ? body.sessions as SessionSummary[] : [],
    activeSessionId: typeof body.activeSessionId === "string"
      ? body.activeSessionId
      : typeof body.lastActiveSessionId === "string"
        ? body.lastActiveSessionId
        : null,
  };
}

function legacyRuntime(body: Record<string, unknown>): RuntimeInfo {
  const config = isRecord(body.config) ? body.config : {};
  const gateway = isRecord(config.gateway) ? config.gateway as RuntimeInfo["gateway"] : { host: "127.0.0.1", port: 18790 };
  const claudeCode = isRecord(config.claudeCode) ? config.claudeCode : {};
  const workspace = isRecord(config.workspace) && typeof config.workspace.path === "string" ? config.workspace.path : "";
  return {
    home: typeof config.home === "string" ? config.home : "",
    workspace,
    gateway,
    model: typeof body.model_name === "string" ? body.model_name : typeof claudeCode.model === "string" ? claudeCode.model : "",
    permissionMode: typeof claudeCode.permissionMode === "string" ? claudeCode.permissionMode : "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
