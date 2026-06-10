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
      const list = await services.sdkSessions.list("claudebot");
      const summaries = await Promise.all(
        list.map(async (s) => {
          const info = await services.sdkSessions.info(s.sessionId);
          const mainFile = Bun.file(join(services.paths.sessionsDir, s.sessionId, "main.jsonl"));
          const messageCount = (await mainFile.exists())
            ? (await mainFile.text()).split("\n").filter((l) => l.length > 0).length
            : 0;
          return {
            id: s.sessionId,
            title: info?.customTitle ?? info?.summary ?? info?.firstPrompt ?? "(untitled)",
            preview: info?.firstPrompt ?? "",
            updatedAt: new Date(s.mtime).toISOString(),
            messageCount,
          };
        }),
      );
      const state = await services.runtimeState.get();
      return json(200, {
        config: { gateway: services.config.gateway, claudeCode: { model: services.config.claudeCode.model, permissionMode: services.config.claudeCode.permissionMode } },
        lastActiveSessionId: state.lastActiveSessionId,
        sessions: summaries,
      });
    }

    if (path === "/api/sessions" && method === "GET") {
      const list = await services.sdkSessions.list("claudebot");
      return json(200, list.map((s) => ({ id: s.sessionId, mtime: s.mtime })));
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
