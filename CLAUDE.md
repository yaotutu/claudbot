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
bun run dev              # bun --watch src/server.ts
bun run start            # production
bun test                 # bun test, runs tests/*.test.ts
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

Config is Zod-validated (`src/config/schema.ts`), loaded from a JSON file passed via `CLAUDEBOT_CONFIG`, then resolved:

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
                       ├─ sessions      (SessionStore)
                       ├─ runtimeState  (lastActiveSessionId)
                       ├─ profile       (user.md / soul.md / memory.json)
                       ├─ memory        (MemoryStore)
                       ├─ scheduler     (SchedulerService)
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

- **`src/runtime/services.ts`** — wires a `ServiceContainer` per process. There is a real cycle between `SchedulerService` and `ToolRegistry` (the registry holds the scheduler; the scheduler's executor closes over the queryFactory, which closes over the registry). It is broken with a placeholder scheduler that is swapped to the real one after wiring. If you touch this file, preserve the swap.
- **`src/agent/runner.ts`** — thin wrapper over the SDK's `query()`. Normalizes SDK messages into the gateway wire events (`text_delta`, `thinking_delta`, `tool_start`, `tool_result`, `status`, `turn_done`, `error`). Critically, non-Anthropic endpoints (e.g. BigModel's `glm-5.1`) return the whole assistant content in one block — `maybeChunk` slices `text_delta` and `thinking_delta` into ~6-char chunks with a 12ms pause so the UI streams instead of flashing the final answer. If streaming looks broken, check this first.
- **`src/gateway/websocket.ts`** — incoming `chat.user_message` triggers `runUserTurn`, which forwards every `NormalizedEvent` to the client via `forward()`. The WebSocket handler uses an **explicit `.catch`** on `handleClientMessage` (not `void …`) — Bun treats unhandled rejections as fatal. Do not refactor to `void` here.
- **`src/tools/sdk-adapter.ts`** — wraps the `ToolRegistry` in `createSdkMcpServer` (in-process MCP). Tools are validated, authorized, audited, then executed. Do not introduce a separate subprocess MCP server.
- **`src/utils/fs.ts`** — every JSON/text write goes through `writeJsonAtomic` / `writeTextAtomic`. The temp filename includes `pid.counter.timestamp.random` to prevent the millisecond-collision race that bit `setLastActiveSession` under concurrent writes.
- **`src/agent/profile.ts`** — `user.md`, `soul.md`, `memory.json` use SHA256 version stamps. `updateFile` returns 409 (well, throws — the HTTP layer maps it) if `expectedVersion` is stale.

## WebUI architecture

The WebUI is a Vite + React 18 + Tailwind 3 + shadcn/ui app. The components under `webui/src/components/` (Sidebar, MessageBubble, the `thread/*` shell) are **copied from nanobot** and expect nanobot-shaped data (sessions with `key: "channel:chatId"`, an `InboundEvent` stream, etc.). Three adapter modules translate the claudebot wire shapes into those:

- **`webui/src/lib/bootstrap.ts`** — `fetchBootstrap` calls `GET /webui/bootstrap` and synthesizes the nanobot `BootstrapResponse` shape (token is `""`, no auth).
- **`webui/src/lib/api.ts`** — REST adapter. Maps claudebot's `{role, content, createdAt, metadata}` to nanobot's `UIMessage`. Stubs features claudebot doesn't have (skills, workspaces, settings, slash commands, file previews) with safe no-ops / 501 errors.
- **`webui/src/lib/claudebot-client.ts`** — the WS client. Speaks claudebot's `WsClientMessage`/`WsServerMessage` and emits `InboundEvent` to the copied hooks. It tracks `currentChatId` locally and **fans `agent.*` events out by that**, not by `sessionId` on the wire — because the wire's `sessionId` is the *Claude* session UUID, not the claudebot session id. If routing looks wrong, check this fan-out first.

The big consumer is **`webui/src/hooks/useClaudebotStream.ts`** (~1100 lines). It receives `InboundEvent`s and renders user/assistant/system bubbles with a streaming cursor (`buffer.current`, `activeAssistantRef`, `closedAssistantStreamIdsRef`). On `send()` it **pre-pends a placeholder assistant bubble with `isStreaming: true`**, so `MessageBubble` renders the `TypingDots` indicator immediately and the user sees activity before the first delta lands. It also drops user-role `message.appended` echoes (the server echoes the user message back; the client adds it optimistically on send — re-dispatching would double-render it).

Two non-obvious things in the boot path (`webui/src/App.tsx`):

- The copied Sidebar renders chrome (Skills, Settings, project controls) that claudebot doesn't implement. The handlers are passed `noop`; clicking does nothing. The header comment explains this.
- `pickWsUrl` is Vite-dev-aware: in `:5173` it points the WS at the configured gateway port, otherwise it uses the same origin.

## Operational gotchas

- **No auth.** The gateway binds `0.0.0.0` by default; the WebUI has no token, no login. This is intentional for MVP testing. If you need auth, the spec calls for `token`/`tokenIssueSecret` in config — not implemented yet.
- **Scheduler is a stub executor.** `runScheduledTurn` in `src/runtime/services.ts` writes a synthetic `[schedule id] message` to the last active session instead of actually running a Claude turn. A real implementation would dispatch `ClaudeRunner.run()` against the same `queryFactory`. The plumbing is there; only the body is stubbed.
- **The webui `README.md` is stale.** It describes a Python/pip packaging flow that no longer applies (claudebot is Bun/TypeScript, not Python). The "just want to use the WebUI?" section is misleading. The accurate boot steps are the ones in this file's Commands section.
- **`src/spikes/`** — diagnostic scripts from the SDK spike phase. Not part of the runtime; safe to delete if you need a cleanup.
- **Live Claude SDK verification is blocked** in this environment (no working Anthropic auth for some endpoints). Mocked tests cover the runner, gateway, and stream hook paths. The `maybeChunk` chunker exists specifically to make the BigModel/glm-5.1 endpoint feel streaming; verify any change to it against a live call before shipping.
