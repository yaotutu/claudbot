// HTTP API: REST endpoints for sessions, agent files, schedules, media, health, bootstrap.

import { join } from "node:path";
import type { ServiceContainer } from "../runtime/services.ts";
import type { AgentFileName } from "../agent/profile.ts";

export type HttpResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export async function handleHttp(
  req: Request,
  url: URL,
  services: ServiceContainer,
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  try {
    if (path === "/health" && method === "GET") {
      return json(200, { status: "ok" });
    }

    if (path === "/webui/bootstrap" && method === "GET") {
      const summaries = await listSessionSummaries(services);
      const state = await services.runtimeState.get();
      return json(200, {
        config: {
          gateway: services.config.gateway,
          claudeCode: {
            model: services.config.claudeCode.model,
            permissionMode: services.config.claudeCode.permissionMode,
          },
          workspace: { path: services.paths.workspace },
          home: services.paths.home,
        },
        runtime: runtimeInfo(services),
        model_name: services.config.claudeCode.model,
        ws_path: "/ws",
        lastActiveSessionId: state.lastActiveSessionId,
        sessions: summaries,
      });
    }

    if (path === "/api/runtime" && method === "GET") {
      return json(200, runtimeInfo(services));
    }

    if (path === "/api/sessions" && method === "GET") {
      return json(200, await listSessionSummaries(services));
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const sub = sessionMatch[2] || "";
      if (sub === "" && method === "DELETE") {
        await services.sdkSessions.remove(id);
        return json(200, { deleted: id });
      }
      if (sub === "" && method === "PATCH") {
        const body = await safeJson(req) as { title?: string } | null;
        if (!body?.title) return json(400, { error: "title required" });
        await services.sdkSessions.rename(id, body.title);
        return json(200, { id, title: body.title });
      }
      if (sub === "/messages" && method === "GET") {
        const sessionDir = join(services.paths.sessionsDir, id, "main.jsonl");
        const file = Bun.file(sessionDir);
        if (!(await file.exists())) return json(200, []);
        const { parseJsonlToUIMessages } = await import("../sessions/jsonl-parser.ts");
        const messages = await parseJsonlToUIMessages(sessionDir);
        return json(200, messages);
      }
      if (sub === "/activate" && method === "POST") {
        await services.runtimeState.setLastActiveSession(id, "user_open");
        return json(200, { lastActiveSessionId: id });
      }
    }

    if (path === "/api/agent/files" && method === "GET") {
      const [user, soul, memory] = await Promise.all([
        services.profile.readFile("user.md"),
        services.profile.readFile("soul.md"),
        services.profile.readFile("memory.json"),
      ]);
      return json(200, { "user.md": user, "soul.md": soul, "memory.json": memory });
    }
    const agentFileMatch = path.match(/^\/api\/agent\/files\/([A-Za-z0-9._-]+)$/);
    if (agentFileMatch && method === "GET") {
      const name = decodeURIComponent(agentFileMatch[1]);
      if (!isAgentFile(name)) return json(400, { error: "invalid file name" });
      const r = await services.profile.readFile(name);
      return json(200, r);
    }
    if (agentFileMatch && method === "PUT") {
      const name = decodeURIComponent(agentFileMatch[1]);
      if (!isAgentFile(name)) return json(400, { error: "invalid file name" });
      const body = await safeJson(req) as { content?: string; expectedVersion?: string } | null;
      if (!body || typeof body.content !== "string" || typeof body.expectedVersion !== "string") {
        return json(400, { error: "content and expectedVersion required" });
      }
      try {
        const r = await services.profile.updateFile(name, body.content, body.expectedVersion);
        return json(200, r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("version conflict")) return json(409, { error: "version conflict" });
        return json(400, { error: msg });
      }
    }

    if (path === "/api/schedules" && method === "GET") {
      return json(200, await services.storeOps.list());
    }
    if (path === "/api/schedules" && method === "POST") {
      const body = await safeJson(req) as {
        name?: string;
        message?: string;
        cronExpr?: string;
        at?: string;
        everyMs?: number;
        timezone?: string;
      } | null;
      if (!body?.name || !body?.message) return json(400, { error: "name and message required" });
      try {
        const schedule = await services.storeOps.create({
          name: body.name,
          message: body.message,
          cronExpr: body.cronExpr,
          at: body.at,
          everyMs: body.everyMs,
          timezone: body.timezone,
        });
        return json(200, schedule);
      } catch (err) {
        return json(400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (path === "/api/schedule-runs" && method === "GET") {
      const scheduleId = url.searchParams.get("scheduleId");
      const runs = await services.schedulerStore.listRuns();
      const filtered = scheduleId ? runs.filter((run) => run.scheduleId === scheduleId) : runs;
      return json(200, filtered.slice().reverse());
    }
    const scheduleMatch = path.match(/^\/api\/schedules\/([A-Za-z0-9_-]+)$/);
    if (scheduleMatch && method === "PATCH") {
      const id = scheduleMatch[1];
      const body = await safeJson(req) as Record<string, unknown> | null;
      if (!body) return json(400, { error: "JSON body required" });
      try {
        let schedule = body.enabled === undefined
          ? undefined
          : await services.storeOps.setEnabled(id, Boolean(body.enabled));
        const patch: Record<string, unknown> = {};
        for (const key of ["name", "message", "cronExpr", "timezone", "everyMs", "at"] as const) {
          if (body[key] !== undefined) patch[key] = body[key];
        }
        if (Object.keys(patch).length > 0) {
          schedule = await services.storeOps.update(id, patch);
        }
        return json(200, schedule ?? await findSchedule(services, id));
      } catch (err) {
        return json(400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (scheduleMatch && method === "DELETE") {
      const id = scheduleMatch[1];
      try {
        await services.storeOps.delete(id);
        return json(200, { deleted: id });
      } catch (err) {
        return json(400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    const scheduleRunMatch = path.match(/^\/api\/schedules\/([A-Za-z0-9_-]+)\/run-now$/);
    if (scheduleRunMatch && method === "POST") {
      const id = scheduleRunMatch[1];
      try {
        const run = await services.trigger.runNow(id);
        return json(200, run);
      } catch (err) {
        return json(400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const mediaMatch = path.match(/^\/api\/media\/([A-Za-z0-9._-]+)$/);
    if (mediaMatch) {
      const name = mediaMatch[1];
      const path = `${services.paths.mediaDir}/${name}`;
      const file = Bun.file(path);
      if (!(await file.exists())) return json(404, { error: "not found" });
      return new Response(file);
    }

    return json(404, { error: "not found" });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function findSchedule(services: ServiceContainer, id: string) {
  const schedule = (await services.storeOps.list()).find((item) => item.id === id);
  if (!schedule) throw new Error(`schedule not found: ${id}`);
  return schedule;
}

type SessionLineInfo = {
  messageCount: number;
  firstTimestamp: string | null;
  firstUserText: string;
};

function runtimeInfo(services: ServiceContainer) {
  return {
    home: services.paths.home,
    workspace: services.paths.workspace,
    gateway: services.config.gateway,
    model: services.config.claudeCode.model,
    permissionMode: services.config.claudeCode.permissionMode,
  };
}

async function listSessionSummaries(services: ServiceContainer) {
  const list = await services.sdkSessions.list("claudebot");
  return Promise.all(list.map((s) => buildSessionSummary(services, s.sessionId, s.mtime)));
}

async function buildSessionSummary(services: ServiceContainer, sessionId: string, mtime: number) {
  const info = await services.sdkSessions.info(sessionId);
  const mainFile = Bun.file(join(services.paths.sessionsDir, sessionId, "main.jsonl"));
  const text = await mainFile.exists() ? await mainFile.text() : "";
  const lineInfo = summarizeSessionLines(text);
  const firstPrompt = info?.firstPrompt ?? lineInfo.firstUserText;
  const title = info?.customTitle ?? info?.summary ?? firstPrompt ?? "New chat";
  return {
    id: sessionId,
    title: title || "New chat",
    preview: firstPrompt || "",
    createdAt: lineInfo.firstTimestamp,
    updatedAt: new Date(mtime).toISOString(),
    messageCount: lineInfo.messageCount,
    status: "persisted" as const,
  };
}

function summarizeSessionLines(text: string): SessionLineInfo {
  const out: SessionLineInfo = { messageCount: 0, firstTimestamp: null, firstUserText: "" };
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    const type = typeof entry.type === "string" ? entry.type : "";
    if (type !== "user" && type !== "assistant" && type !== "system") continue;
    out.messageCount += 1;
    if (!out.firstTimestamp && typeof entry.timestamp === "string") {
      out.firstTimestamp = entry.timestamp;
    }
    if (!out.firstUserText && type === "user" && isRecord(entry.message)) {
      out.firstUserText = flattenWireContent(entry.message.content);
    }
  }
  return out;
}

function flattenWireContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAgentFile(name: string): name is AgentFileName {
  return name === "user.md" || name === "soul.md" || name === "memory.json";
}

async function safeJson(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return null; }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
