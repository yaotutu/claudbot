// Server entrypoint: compose services, start HTTP+WS gateway.

import { join } from "node:path";
import { buildServices } from "./runtime/services.ts";
import { handleHttp } from "./gateway/http.ts";
import { makeWsHandlers, type WsData } from "./gateway/websocket.ts";
import { resolveRuntimeConfig } from "./config/loader.ts";
import { runtimePaths } from "./config/paths.ts";

const config = await resolveRuntimeConfig({
  ...(await readOptionalConfig(process.env.CLAUDEBOT_CONFIG)),
}, { homeEnv: process.env.CLAUDEBOT_HOME || "" });
const paths = runtimePaths(config);
const services = await buildServices({ config, paths });

const handlers = makeWsHandlers(services);

// Static webui directory (built by `cd webui && bun run build`).
// Resolved relative to this file so it works in dev and after bundling.
const WEBUI_DIST = join(import.meta.dir, "..", "webui", "dist");
const INDEX_HTML_PATH = join(WEBUI_DIST, "index.html");

const server = Bun.serve({
  port: config.gateway.port,
  hostname: config.gateway.host,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const data: WsData = { sessionId: "inbox", services, send: () => {} };
      const ok = (srv as unknown as { upgrade: (r: Request, o: { data: WsData }) => boolean }).upgrade(req, { data });
      if (ok) return undefined;
      return new Response("upgrade required", { status: 426 });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const f = Bun.file(INDEX_HTML_PATH);
      if (await f.exists()) return new Response(f, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/brand/") || url.pathname === "/favicon.ico") {
      const f = Bun.file(join(WEBUI_DIST, url.pathname));
      if (await f.exists()) return new Response(f);
    }
    return handleHttp(req, url, services);
  },
  websocket: {
    open: (ws) => handlers.open(ws as unknown as Parameters<typeof handlers.open>[0]),
    message: (ws, raw) => handlers.message(ws as unknown as Parameters<typeof handlers.message>[0], raw),
    close: (ws) => handlers.close(ws as unknown as Parameters<typeof handlers.close>[0]),
  },
});

console.log(`claudebot runtime listening on http://${config.gateway.host}:${config.gateway.port}`);

async function readOptionalConfig(path: string | undefined): Promise<Record<string, unknown>> {
  if (!path) return {};
  try {
    return await Bun.file(path).json();
  } catch {
    return {};
  }
}

