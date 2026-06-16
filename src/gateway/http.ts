// HTTP API: REST endpoints for sessions, agent files, schedules, media, health, bootstrap.

import type { ServiceContainer } from "../runtime/services.ts";
import type { AgentFileName } from "../agent/profile.ts";
import type { ChannelRegistry } from "../channels/registry.ts";

export type HttpResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export async function handleHttp(
  req: Request,
  url: URL,
  services: ServiceContainer,
  channelRegistry?: Pick<ChannelRegistry, "handleHttp">,
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  try {
    const channelResponse = await channelRegistry?.handleHttp(req, url);
    if (channelResponse) return channelResponse;

    if (path === "/health" && method === "GET") {
      return json(200, { status: "ok" });
    }

    if (path === "/webui/bootstrap" && method === "GET") {
      const summaries = await services.sessions.listSummaries();
      return json(200, {
        config: {
          gateway: services.config.gateway,
          claudeCode: {
            model: services.config.claudeCode.model,
            providerModel: services.config.claudeCode.providerModel,
            permissionMode: services.config.claudeCode.permissionMode,
          },
          workspace: { path: services.paths.workspace },
          home: services.paths.home,
        },
        runtime: runtimeInfo(services),
        ws: { path: "/ws" },
        activeSessionId: await services.sessions.getActiveSessionId(),
        sessions: summaries,
      });
    }

    if (path === "/api/runtime" && method === "GET") {
      return json(200, runtimeInfo(services));
    }

    if (path === "/api/notifications" && method === "GET") {
      const notifications = await services.notificationStore.list();
      return json(200, notifications.slice().reverse());
    }

    if (path === "/api/notifications/read-all" && method === "POST") {
      const updated = await services.notificationStore.markAllRead();
      return json(200, { updated });
    }

    if (path === "/api/sessions" && method === "GET") {
      return json(200, await services.sessions.listSummaries());
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const sub = sessionMatch[2] || "";
      if (sub === "" && method === "DELETE") {
        await services.sessions.remove(id);
        return json(200, { deleted: id });
      }
      if (sub === "" && method === "PATCH") {
        const body = await safeJson(req) as { title?: string } | null;
        if (!body?.title) return json(400, { error: "title required" });
        await services.sessions.rename(id, body.title);
        return json(200, { id, title: body.title });
      }
      if (sub === "/messages" && method === "GET") {
        return json(200, await services.sessions.readMessages(id));
      }
      if (sub === "/activate" && method === "POST") {
        const activeId = await services.sessions.activate(id);
        return json(200, { activeSessionId: activeId });
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
        const started = await services.trigger.startRunNow(id);
        return json(200, started);
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

function runtimeInfo(services: ServiceContainer) {
  return {
    home: services.paths.home,
    workspace: services.paths.workspace,
    gateway: services.config.gateway,
    model: services.config.claudeCode.model,
    providerModel: services.config.claudeCode.providerModel,
    permissionMode: services.config.claudeCode.permissionMode,
  };
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
