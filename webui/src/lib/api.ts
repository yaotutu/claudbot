// HTTP API client adapter: claudebot exposes a smaller REST surface than
// nanobot. The hooks/views copied from nanobot still call into this module,
// so we keep their full call shape and translate to claudebot's endpoints
// here, stubbing features claudebot doesn't have.

import type {
  ChatSummary,
  ClaudeCodeHealthPayload,
  ClaudeCodeSettingsPayload,
  ClaudeCodeSettingsUpdate,
  FilePreviewPayload,
  NetworkSafetySettingsUpdate,
  SessionAutomationsPayload,
  SettingsPayload,
  SettingsUpdate,
  SidebarStatePayload,
  SkillDetail,
  SkillsPayload,
  SlashCommand,
  WebuiThreadPersistedPayload,
  WorkspaceScopePayload,
  WorkspacesPayload,
} from "./types";

const API_READ_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function request<T>(
  url: string,
  init?: RequestInit,
  timeoutMs: number = 0,
): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...(init ?? {}),
      signal: controller.signal,
      credentials: "same-origin",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || `HTTP ${res.status}`);
    }
    const contentType = res.headers?.get?.("content-type") ?? "";
    if (contentType && !contentType.toLowerCase().includes("application/json")) {
      const text = await res.text();
      const isHtml = text.trimStart().toLowerCase().startsWith("<!doctype");
      throw new ApiError(
        res.status,
        isHtml
          ? "Gateway returned WebUI HTML instead of JSON. Restart claudebot gateway and try again."
          : "Gateway returned a non-JSON response.",
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

function splitKey(key: string): { channel: string; chatId: string } {
  const idx = key.indexOf(":");
  if (idx === -1) return { channel: "websocket", chatId: key };
  return { channel: key.slice(0, idx), chatId: key.slice(idx + 1) };
}

/** GET /api/sessions → ChatSummary[] */
export async function listSessions(
  _token: string = "",
  base: string = "",
): Promise<ChatSummary[]> {
  type Row = {
    id: string;
    title?: string;
    preview?: string;
    createdAt?: string;
    updatedAt?: string;
    messages?: Array<{ content?: string }>;
  };
  const body = await request<{ sessions: Row[] }>(
    `${base}/api/sessions`,
    undefined,
    API_READ_TIMEOUT_MS,
  );
  return body.sessions.map((s) => {
    const key = `websocket:${s.id}`;
    const createdAt = s.createdAt ?? null;
    const updatedAt = s.updatedAt ?? null;
    return {
      key,
      ...splitKey(key),
      createdAt,
      updatedAt,
      title: s.title ?? "",
      preview: s.preview ?? "",
      runStartedAt: null,
      workspaceScope: null,
    };
  });
}

/**
 * GET /api/sessions/:id/messages → WebuiThreadPersistedPayload
 *
 * Synthesizes the shape nanobot's useSessionHistory expects. Claudebot's
 * message format is `{role, content, createdAt, metadata}`; we map into
 * nanobot's UIMessage shape, attaching a stable id and a createdAt epoch.
 */
export async function fetchWebuiThread(
  _token: string = "",
  key: string,
  base: string = "",
): Promise<WebuiThreadPersistedPayload | null> {
  const chatId = splitKey(key).chatId;
  try {
    const body = await request<{ messages: Array<{ id?: string; role: string; content: string; createdAt: string; metadata?: Record<string, unknown> }> }>(
      `${base}/api/sessions/${encodeURIComponent(chatId)}/messages`,
      undefined,
      API_READ_TIMEOUT_MS,
    );
    const messages = (body.messages ?? []).map((m, idx) => {
      const createdAtEpoch = Date.parse(m.createdAt) || Date.now();
      return {
        id: m.id ?? `hist-${idx}`,
        role: m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "system",
        content: m.content,
        createdAt: createdAtEpoch,
        kind: "message" as const,
        isStreaming: false,
        turnPhase: (m.role === "user" ? "user" : "complete") as "user" | "complete",
      };
    });
    return {
      schemaVersion: 1,
      sessionKey: key,
      savedAt: new Date().toISOString(),
      messages: messages as unknown as WebuiThreadPersistedPayload["messages"],
    };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export async function fetchFilePreview(
  _token: string,
  _key: string,
  _path: string,
  _base: string = "",
): Promise<FilePreviewPayload> {
  throw new ApiError(501, "File preview not supported in claudebot MVP");
}

export async function fetchSessionAutomations(
  _token: string,
  _key: string,
  _base: string = "",
): Promise<SessionAutomationsPayload> {
  return { jobs: [] };
}

export async function fetchSkills(
  _token: string,
  _base: string = "",
): Promise<SkillsPayload> {
  return { skills: [] };
}

export async function fetchSkillDetail(
  _token: string,
  _name: string,
  _base: string = "",
): Promise<SkillDetail> {
  throw new ApiError(404, "skills not supported in claudebot MVP");
}

export async function deleteSession(
  _token: string,
  key: string,
  base: string = "",
): Promise<boolean> {
  const chatId = splitKey(key).chatId;
  const body = await request<{ deleted: boolean }>(
    `${base}/api/sessions/${encodeURIComponent(chatId)}`,
    { method: "DELETE" },
  );
  return body.deleted;
}

/** PATCH /api/sessions/:id (rename, etc.) */
export async function patchSession(
  _token: string,
  key: string,
  body: { title?: string },
  base: string = "",
): Promise<void> {
  const chatId = splitKey(key).chatId;
  await request(
    `${base}/api/sessions/${encodeURIComponent(chatId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/** POST /api/sessions/:id/activate */
export async function activateSession(
  _token: string,
  key: string,
  base: string = "",
): Promise<{ lastActiveSessionId: string }> {
  const chatId = splitKey(key).chatId;
  return request<{ lastActiveSessionId: string }>(
    `${base}/api/sessions/${encodeURIComponent(chatId)}/activate`,
    { method: "POST" },
  );
}

/** POST /api/sessions */
export async function createSessionHttp(
  _token: string,
  title: string | undefined,
  base: string = "",
): Promise<{ id: string; title: string; preview: string; createdAt: string; updatedAt: string; messages: unknown[] }> {
  return request(
    `${base}/api/sessions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(title ? { title } : {}),
    },
  );
}

/** Minimal SettingsPayload so Settings view (if it ever opens) doesn't crash. */
const EMPTY_SETTINGS: SettingsPayload = {
  agent: {
    model: "glm-5.1",
    has_api_key: true,
    max_tokens: 8192,
    context_window_tokens: 200000,
    temperature: 1,
    reasoning_effort: null,
    timezone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC",
    bot_name: "claudebot",
    bot_icon: "",
    tool_hint_max_length: 200,
  },
  runtime: {
    config_path: "",
    workspace_path: "",
    gateway_host: "127.0.0.1",
    gateway_port: 18790,
    heartbeat: { enabled: false, interval_s: 0, keep_recent_messages: 0 },
    dream: { schedule: "" },
    unified_session: true,
  },
  advanced: {
    restrict_to_workspace: true,
    ssrf_whitelist_count: 0,
    webui_allow_local_service_access: true,
    webui_default_access_mode: "default",
    private_service_protection_enabled: false,
    mcp_server_count: 0,
    exec_enabled: false,
    exec_path_append_set: false,
  },
  requires_restart: false,
};

export async function fetchSettings(
  _token: string,
  _base: string = "",
): Promise<SettingsPayload> {
  return EMPTY_SETTINGS;
}

export async function fetchSettingsUsage(
  _token: string,
  _base: string = "",
): Promise<SettingsPayload> {
  return EMPTY_SETTINGS;
}

export async function fetchClaudeCodeSettings(
  _token: string,
  _base: string = "",
): Promise<ClaudeCodeSettingsPayload> {
  return {
    claudeCode: {
      baseUrl: "",
      authMode: "api_key",
      apiKey: "",
      model: "glm-5.1",
      permissionMode: "bypassPermissions",
      enableGatewayModelDiscovery: false,
      maxTurns: 0,
    },
    health: { sdkRuntime: true, modelsEndpointReachable: true, lastError: "" },
  };
}

export async function fetchClaudeCodeHealth(
  _token: string,
  _base: string = "",
): Promise<{ health: ClaudeCodeHealthPayload }> {
  return { health: { sdkRuntime: true, modelsEndpointReachable: true, lastError: "" } };
}

export async function updateClaudeCodeSettings(
  _token: string,
  _body: ClaudeCodeSettingsUpdate,
  _base: string = "",
): Promise<ClaudeCodeSettingsPayload> {
  return fetchClaudeCodeSettings(_token, _base);
}

export async function fetchWorkspaces(
  _token: string,
  _base: string = "",
): Promise<WorkspacesPayload> {
  return {
    schema_version: 1,
    default_access_mode: "default",
    default_scope: {
      project_path: "",
      project_name: "",
      access_mode: "restricted",
      restrict_to_workspace: true,
    },
    controls: { can_change_project: false, can_use_full_access: false },
  };
}

export async function listSlashCommands(
  _token: string,
  _base: string = "",
): Promise<SlashCommand[]> {
  return [];
}

export async function fetchSidebarState(
  _token: string,
  _base: string = "",
): Promise<SidebarStatePayload> {
  return {
    schema_version: 1,
    pinned_keys: [],
    archived_keys: [],
    title_overrides: {},
    project_name_overrides: {},
    tags_by_key: {},
    collapsed_groups: {},
    view: {
      density: "comfortable",
      show_previews: true,
      show_timestamps: true,
      show_archived: false,
      sort: "updated_desc",
    },
    updated_at: null,
  };
}

export async function updateSidebarState(
  _token: string,
  _body: Partial<SidebarStatePayload>,
  _base: string = "",
): Promise<SidebarStatePayload> {
  return fetchSidebarState(_token, _base);
}

export async function updateSettings(
  _token: string,
  _body: SettingsUpdate,
  _base: string = "",
): Promise<SettingsPayload> {
  return EMPTY_SETTINGS;
}

export async function updateNetworkSafetySettings(
  _token: string,
  _body: NetworkSafetySettingsUpdate,
  _base: string = "",
): Promise<SettingsPayload> {
  return EMPTY_SETTINGS;
}

/* eslint-disable @typescript-eslint/no-unused-vars */
export type { WorkspaceScopePayload };
