// HTTP API: REST endpoints for sessions, agent files, schedules, media, health, bootstrap.

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
      const sessions = await services.sessions.list();
      const state = await services.runtimeState.get();
      return json(200, {
        config: { gateway: services.config.gateway, claudeCode: { model: services.config.claudeCode.model, permissionMode: services.config.claudeCode.permissionMode } },
        lastActiveSessionId: state.lastActiveSessionId,
        sessions: sessions.map((s) => ({ id: s.id, title: s.title, preview: s.preview, updatedAt: s.updatedAt, messageCount: s.messages.length })),
      });
    }

    if (path === "/api/sessions" && method === "GET") {
      const list = await services.sessions.list();
      return json(200, list);
    }
    if (path === "/api/sessions" && method === "POST") {
      const body = await safeJson(req) as { title?: string } | null;
      const session = await services.sessions.create(body?.title || "New chat");
      return json(200, session);
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const sub = sessionMatch[2] || "";
      const record = await services.sessions.get(id);
      if (!record && sub === "") {
        return json(404, { error: "session not found" });
      }
      if (sub === "" && method === "GET") return json(200, record);
      if (sub === "" && method === "DELETE") {
        await services.sessions.delete(id);
        return json(200, { deleted: id });
      }
      if (sub === "" && method === "PATCH") {
        const body = await safeJson(req) as { title?: string } | null;
        if (!record) return json(404, { error: "session not found" });
        if (body?.title) record.title = body.title;
        await services.sessions.save(record);
        return json(200, record);
      }
      if (sub === "/messages" && method === "GET") {
        return json(200, record ? record.messages : []);
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
      return json(200, await services.scheduler.list());
    }
    const scheduleRunMatch = path.match(/^\/api\/schedules\/([A-Za-z0-9_-]+)\/run-now$/);
    if (scheduleRunMatch && method === "POST") {
      const id = scheduleRunMatch[1];
      try {
        const run = await services.scheduler.runNow(id);
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

function isAgentFile(name: string): name is AgentFileName {
  return name === "user.md" || name === "soul.md" || name === "memory.json";
}

async function safeJson(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return null; }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
