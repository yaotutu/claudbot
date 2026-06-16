// Server entrypoint: compose services, start HTTP+WS gateway.

import { join } from "node:path";
import { buildServices } from "./runtime/services.ts";
import { handleHttp } from "./gateway/http.ts";
import { makeWsHandlers, type WsData } from "./gateway/websocket.ts";
import { formatConfigSource, loadConfig } from "./config/loader.ts";
import { runtimePaths } from "./config/paths.ts";
import { deliverScheduleResultToNotification } from "./scheduler/notify.ts";
import { createChannelRegistry } from "./channels/registry.ts";

const loaded = await loadConfig();
const config = loaded.config;
const paths = runtimePaths(config);
const services = await buildServices({ loaded, paths });

// Start the scheduler cron loop.
services.trigger.start(config.scheduler.tickIntervalMs);

const handlers = makeWsHandlers(services);
const channelRegistry = createChannelRegistry(services);
await channelRegistry.start();

// Wire schedule delivery to WebUI notifications. Scheduler results are product
// notifications, not chat session messages.
services.notifier.deliver = async (payload) => {
  await deliverScheduleResultToNotification(services, payload, handlers.broadcast);
};

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
      const data: WsData = { sessionId: "", services, send: () => {} };
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
    return handleHttp(req, url, services, channelRegistry);
  },
  websocket: {
    open: (ws) => handlers.open(ws as unknown as Parameters<typeof handlers.open>[0]),
    message: (ws, raw) => handlers.message(ws as unknown as Parameters<typeof handlers.message>[0], raw),
    close: (ws) => handlers.close(ws as unknown as Parameters<typeof handlers.close>[0]),
  },
});

// Startup banner — make it obvious where config came from and where things live.
const url = `http://${config.gateway.host}:${config.gateway.port}`;
console.log(`claudebot runtime listening on ${url}`);
console.log(`  config:  ${formatConfigSource(loaded.source)}`);
console.log(`  home:    ${config.home}`);
console.log(`  model:   ${config.claudeCode.model}${config.claudeCode.providerModel ? ` -> ${config.claudeCode.providerModel}` : ""}`);
if (loaded.source.kind === "defaults") {
  console.warn(`  ⚠️  No usable config file. Set CLAUDEBOT_CONFIG or fix/create ${config.home}/config.json.`);
}
if (loaded.source.kind === "created") {
  console.warn(`  ⚠️  Created starter config at ${loaded.source.path}`);
  console.warn("     Edit claudeCode.apiKey/baseUrl/providerModel there, then restart claudebot.");
  console.warn('     Keep claudeCode.model as "sonnet", "haiku", or "opus"; put GLM names in providerModel.');
}

// Graceful shutdown — stop scheduler and close server.
process.on("SIGINT", () => {
  void channelRegistry.stop();
  services.trigger.stop();
  server.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  void channelRegistry.stop();
  services.trigger.stop();
  server.stop();
  process.exit(0);
});
