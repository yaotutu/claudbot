// HTTP API client for claudebot WebUI.

export type Session = {
  id: string;
  title: string;
  preview: string;
  claudeSessionId: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
};

export type SessionMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type Bootstrap = {
  config: { gateway: { host: string; port: number }; claudeCode: { model: string; permissionMode: string } };
  lastActiveSessionId: string;
  sessions: Array<{ id: string; title: string; preview: string; updatedAt: string; messageCount: number }>;
};

export type AgentFile = { content: string; version: string };

async function ok<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  bootstrap: () => fetch("/webui/bootstrap").then(ok<Bootstrap>),

  listSessions: () => fetch("/api/sessions").then(ok<Session[]>),
  createSession: (title?: string) => fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
  }).then(ok<Session>),
  getSession: (id: string) => fetch(`/api/sessions/${id}`).then(ok<Session>),
  patchSession: (id: string, body: { title?: string }) => fetch(`/api/sessions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(ok<Session>),
  deleteSession: (id: string) => fetch(`/api/sessions/${id}`, { method: "DELETE" }).then(ok<{ deleted: string }>),
  activateSession: (id: string) => fetch(`/api/sessions/${id}/activate`, { method: "POST" }).then(ok<{ lastActiveSessionId: string }>),
  getMessages: (id: string) => fetch(`/api/sessions/${id}/messages`).then(ok<SessionMessage[]>),

  readAgentFile: (name: string) => fetch(`/api/agent/files/${encodeURIComponent(name)}`).then(ok<AgentFile>),
  writeAgentFile: (name: string, content: string, expectedVersion: string) => fetch(`/api/agent/files/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, expectedVersion }),
  }).then(async (res) => {
    if (res.status === 409) throw new Error("Version conflict — please reload.");
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json() as Promise<AgentFile>;
  }),

  listSchedules: () => fetch("/api/schedules").then(ok<{ id: string; name: string; cronExpr: string; timezone: string; state: { nextRunAt: string; lastStatus: string | null } }[]>),
  runScheduleNow: (id: string) => fetch(`/api/schedules/${id}/run-now`, { method: "POST" }).then(ok<{ status: string; result: string; error: string }>),
};
