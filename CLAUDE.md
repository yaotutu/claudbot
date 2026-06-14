# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`claudebot` — a local, single-user AI assistant runtime, written in Bun/TypeScript. A running instance owns one home directory (`~/.claudebot` by default), one workspace, one agent identity, a session store, a scheduler, and a React WebUI. Claude is the model; `claude-agent-sdk` is the transport.

It is a clean-room rebuild of `/home/yaotutu/code/nanobot` (do not modify nanobot). The design source-of-truth is `docs/superpowers/specs/2026-06-09-claudebot-runtime-mvp-design.md` and the phased plan at `docs/superpowers/plans/2026-06-09-claudebot-runtime-mvp.md`.

## Commands

All commands are run from the repo root unless noted.

Server (Bun runtime, ESM, strict TS):

```bash
bun install              # server deps
bun run dev              # gateway (:18790) + WebUI (:5173) concurrently
bun run dev:server       # bun --watch src/server.ts (gateway only, on :18790)
bun run dev:webui        # Vite WebUI only (:5173)
bun run start            # production
bun run test             # bun test, backend/runtime tests only
bunx tsc --noEmit        # typecheck
```

WebUI (Vite + React 18, lives at `webui/`):

```bash
cd webui
bun install              # (or npm install)
bun run dev              # vite dev server on :5173, proxies to gateway
bun run build            # tsc + vite build → webui/dist/  (gateway serves this)
bun run test             # vitest
bun run lint             # eslint src --max-warnings 0
```

`webui/vite.config.ts` proxies `/api`, `/webui`, `/auth`, and `/ws` to the gateway. The default target is `http://127.0.0.1:18790`; override with `CLAUDEBOT_API_URL=…`.

To run a single server test: `bun test tests/sessions.test.ts` (or any other test file). To run a single vitest: `cd webui && bun run test -- -t "pattern"`.

Production flow: `cd webui && bun run build` then `bun run start` from root. `src/server.ts` serves `webui/dist/index.html` and `webui/dist/assets/*` directly off the same port as the API.

## Configuration & env

Config is Zod-validated (`src/config/schema.ts`) and loaded in this order:

1. `CLAUDEBOT_CONFIG` — explicit path to a JSON file. If set but the file is missing, a warning is logged and the runtime falls through.
2. `$CLAUDEBOT_HOME/config.json` (default `~/.claudebot/config.json`) — auto-discovered. The common setup: edit this file, restart, done.
3. Schema defaults — if neither is found, the runtime starts with built-in defaults and prints a warning to stderr.

The startup banner shows which one was used (`config:` line).

Env-var overrides for individual fields:

- `CLAUDEBOT_HOME` → `home` (default `~/.claudebot`)
- `CLAUDEBOT_HOST` → `gateway.host` (default `0.0.0.0` — LAN-friendly, no auth)
- `CLAUDEBOT_PORT` → `gateway.port` (default `18790`)
- `gateway` section: `host`, `port`
- `claudeCode` section: `model` (default `glm-5.1`), `permissionMode` (default `bypassPermissions`), `maxTurns` (default `200`), `baseUrl`, `apiKey`
- `tools.permissions`: `{ default: "allow", overrides: { toolName: "deny" } }` (`confirm` is accepted but treated as `deny` with a clear message)

## Server architecture

```
WebUI ──HTTP/WS──▶ src/server.ts (Bun.serve)
                   ├─ /ws          → src/gateway/websocket.ts
                   ├─ static       → webui/dist
                   └─ /api, /webui → src/gateway/http.ts
                                   │
                                   ▼
                   src/runtime/services.ts (ServiceContainer)
                       ├─ sdkSessionStore  (SdkJsonlSessionStore — SDK SessionStore adapter)
                       ├─ sessions      (ClaudebotSessionService — JSONL read model/actions)
                       ├─ runtimeState  (lastActiveSessionId — SDK session UUID)
                       ├─ profile       (user.md / soul.md / memory.json)
                       ├─ memory        (MemoryStore)
                       ├─ notificationStore (WebUI task/result notifications)
                       ├─ schedulerStore + storeOps  (CRUD)
                       ├─ notifier      (ScheduleNotifier — WebUI notification bridge)
                       ├─ trigger       (SchedulerTrigger — cron loop + execution)
                       ├─ toolRegistry  (ToolRegistry)
                       └─ makeRunner()  (ClaudeRunner)
                                          │
                                          ▼
                          @anthropic-ai/claude-agent-sdk
                              + in-process SDK MCP server
                                  (createSdkMcpServer)
                                          │
                                          ▼
                          tools/builtin/{scheduler,memory,agent-files}.ts
```

Key boundaries:

- **`src/runtime/services.ts`** — wires a `ServiceContainer` per process. Assembly is linear (no cycles): Store → StoreOps → Registry → queryFactory → Trigger. The trigger's executor needs `queryFactory`, which needs the registry, which only needs `storeOps` + a lazy `getTrigger()` getter. The `ScheduleNotifier` starts as a no-op and is wired to real WebUI notification delivery in `server.ts` after WS handlers are created.
- **`src/agent/runner.ts`** — thin wrapper over the SDK's `query()`. Normalizes SDK messages into gateway events (`text_delta`, `thinking_delta`, `tool_start`, `tool_result`, `status`, `turn_done`, `error`).
- **`src/gateway/websocket.ts`** — incoming `chat.send` triggers `runUserTurn`, which forwards every `NormalizedEvent` as claudebot-native frames (`run.delta`, `run.tool`, `run.completed`, etc.). The WebSocket handler uses an **explicit `.catch`** on `handleClientMessage` (not `void …`) — Bun treats unhandled rejections as fatal.
- **`src/tools/sdk-mcp-server.ts`** — wraps the `ToolRegistry` in `createSdkMcpServer` (in-process MCP). Tools are validated, authorized, audited, then executed. Do not introduce a separate subprocess MCP server.
- **`src/utils/fs.ts`** — every JSON/text write goes through `writeJsonAtomic` / `writeTextAtomic`. The temp filename includes `pid.counter.timestamp.random` to prevent the millisecond-collision race that bit `setLastActiveSession` under concurrent writes.
- **`src/agent/profile.ts`** — `user.md`, `soul.md`, `memory.json` use SHA256 version stamps. `updateFile` returns 409 (well, throws — the HTTP layer maps it) if `expectedVersion` is stale.

## Session storage model

Session messages are owned entirely by the Claude Agent SDK; the app layer does **not** store message content. The `SdkJsonlSessionStore` adapter (`src/sessions/sdk-jsonl-store.ts`) implements SDK's `SessionStore` interface and mirrors every transcript write from the SDK subprocess into claudebot's home. Business reads and actions go through `ClaudebotSessionService` (`src/sessions/session-service.ts`) and its JSONL read model.

Layout under the home directory:

```
~/.claudebot/
  config.json
  sdk-config/                 # SDK's local working copy (CLAUDE_CONFIG_DIR)
    projects/<dir-hash>/
      <sdkSessionId>/
        main.jsonl
        subagents/...
  sessions/                  # adapter mirror — what the app layer reads from
    <sdkSessionId>/
      main.jsonl
      subagents/
        agent-<id>.jsonl
```

`sessionId` is **the SDK's UUID** — there is no separate app-layer session id. `runtimeState.lastActiveSessionId` is a SDK UUID (or empty when the user has no active persisted session). The SDK session store is the transcript writer; the gateway reads back summaries and messages through `session-read-model.ts` and `parseJsonlToUIMessages()`.

Notes on the implementation:

- **Message count for the session list** (`/webui/bootstrap`) is computed by counting non-empty lines in `main.jsonl`. Don't read the file into memory; `Bun.file(...).text().split("\n")` is fine for current sizes but revisit if session transcripts grow large.
- **`MIRROR_FLUSH_SETTLE_MS = 50`** in `src/gateway/websocket.ts` is a settle delay between `turn_done` and the WS ack, so the adapter mirror has time to flush under `sessionStoreFlush: 'batched'`. If the SDK exposes a flush signal, replace this with that.
- The old metadata-only `SessionStore` has been removed. Do not reintroduce an app-layer message/session JSON store; use `services.sessions` for business session actions and `services.sdkSessionStore` only as the SDK adapter.

## WebUI architecture

The WebUI is a Vite + React 18 + Tailwind 3 app using claudebot-native data, not nanobot adapter shapes.

- **`webui/src/lib/claudebot-api.ts`** — HTTP client for `/webui/bootstrap`, sessions, runtime, schedules, schedule runs, and notifications.
- **`webui/src/lib/claudebot-ws.ts`** — WebSocket client for claudebot-native frames (`session.created`, `run.delta`, `message.appended`, `notification.created`, etc.).
- **`webui/src/hooks/useClaudebotSessions.ts`** — session list, draft session creation, active session, rename/delete, and draft-to-SDK-session replacement.
- **`webui/src/hooks/useClaudebotThread.ts`** — thread history fetch, optimistic user message, streaming assistant deltas, final message replacement, and run errors.
- **`webui/src/App.tsx`** — top-level composition for bootstrap, WS lifecycle, sidebar, thread, settings/search/skills panels, and task notifications. Keep future feature work from growing this file; prefer focused components/hooks.

`pickWsUrl` is Vite-dev-aware: in `:5173` it points the WS at the configured gateway port, otherwise it uses the same origin.

## Operational gotchas

- **No auth.** The gateway binds `0.0.0.0` by default; the WebUI has no token, no login. This is intentional for MVP testing. If you need auth, the spec calls for `token`/`tokenIssueSecret` in config — not implemented yet.
- **Scheduler is a real executor.** `runScheduledTurn` in `src/runtime/services.ts` dispatches a real `ClaudeRunner.run()` call in a **new one-off session** (no `resumeSessionId`). After execution, the result is delivered via `ScheduleNotifier` into WebUI notifications (`notifications.json`) and broadcast as `notification.created` / `schedule.run.completed`. Background task results should not be appended into normal chat sessions.
- **The webui `README.md` is stale.** It describes a Python/pip packaging flow that no longer applies (claudebot is Bun/TypeScript, not Python). The "just want to use the WebUI?" section is misleading. The accurate boot steps are the ones in this file's Commands section.
- **`src/spikes/`** — diagnostic scripts from the SDK spike phase. Not part of the runtime; safe to delete if you need a cleanup.
- **Live Claude SDK verification is blocked** in this environment (no working Anthropic auth for some endpoints). Mocked tests cover the runner, gateway, and stream hook paths. The `maybeChunk` chunker exists specifically to make the BigModel/glm-5.1 endpoint feel streaming; verify any change to it against a live call before shipping.

# 以下规则为用户手动添加，禁止AI修改：
- 优先使用函数式编程范式，避免使用类和面向对象的设计。
- 当前项目与 https://github.com/HKUDS/nanobot 这个项目的用户群体高度相似，遇见不确定的设计决策时，优先参考 nanobot 的实现。
- 当前项目与 https://github.com/openclaw/openclaw 这个项目的用户群体高度相似，遇见不确定的设计决策时，优先参考 openclaw 的实现。
- 指定任务的同时必须制定对应的测试用例，并且实际操作页面去测试，确认功能的正确性。然后关闭后台进程，通知用户去手动测试，确认功能的正确性。  
