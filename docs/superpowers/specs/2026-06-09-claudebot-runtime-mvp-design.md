# Claudebot Runtime MVP Design

## Purpose

Rebuild `/home/yaotutu/code/nanobot` as a Bun/TypeScript project in `/home/yaotutu/code/claudbot-refactor`.

The new `claudebot` is a local personal AI assistant runtime. One running instance represents one agent with its own home directory, workspace, identity files, memory, sessions, scheduler, media, WebUI state, and native tools.

This MVP focuses on the runtime required by the WebUI. CLI chat, multi-channel delivery, pairing, document parsing, built-in skill migration, and MCP preset management are out of scope for this first spec.

## Confirmed Requirements

- Use Bun and TypeScript.
- Project/package/command name is `claudebot`.
- Default home directory is `~/.claudebot`.
- A config file can specify `home`, allowing multiple independent instances.
- Default workspace is `<home>/workspace`.
- All local storage uses JSON or Markdown files.
- Do not migrate old Python data, but continue using the `~/.claudebot` default location.
- Use Claude Agent SDK.
- Default Claude permission mode is `bypassPermissions`.
- Use Claude Agent SDK in-process SDK MCP server for native tools.
- Do not implement prompt-simulated tools.
- Do not implement a separate MCP subprocess for claudebot native tools.
- Do not implement WebUI tool confirmation prompts in MVP.
- Default native tool permission is `allow`; config supports future `allow`, `deny`, and `confirm`.
- Scheduler is an instance-level native tool.
- Scheduler supports cron expressions only.
- Scheduler includes `schedule_run_now`.
- Scheduler failures are not retried automatically, but are persisted and reported to the user.
- Scheduler results are delivered to a stable `Claudebot Inbox` SDK session.
- `lastActiveSessionId` records the user's foreground session only; it is not the scheduler delivery target.
- Scheduled turns are one-off Claude turns that inherit the current agent files, memory, workspace, and tools.
- Scheduled turns do not become normal sessions.
- Schedule run history stores final result or error, not full transcripts.
- Agent files are `user.md`, `soul.md`, and `memory.json`.
- WebUI can edit all three agent files.
- Claude can modify all three agent files through native tools.
- Memory uses JSON.
- WebUI first version can edit memory as raw JSON.
- No built-in skills are migrated in MVP.
- Claude Agent SDK handles its own skills and MCP support.
- Existing React WebUI is migrated enough to provide the MVP user experience.

## Explicitly Out Of Scope

- CLI chat mode.
- Telegram, Discord, WeChat, or other channel implementations.
- Pairing codes.
- PDF/docx/xlsx/pptx text extraction.
- Built-in `SKILL.md` migration.
- WebUI MCP preset management.
- CLI app attachments.
- WebUI native-tool confirmation dialogs.
- Old Python config/session/scheduler migration.
- External database storage.

## Instance Layout

```text
<home>/
  config.json
  workspace/
  agent/
    user.md
    soul.md
    memory.json
  sessions/
    *.json
  scheduler/
    schedules.json
    runs.json
  webui/
    runtime_state.json
    sidebar.json
  media/
  logs/
  audit/
    tools.jsonl
```

`home` resolution:

1. If a launch config is provided and contains `home`, use that.
2. Otherwise use `~/.claudebot`.

`workspace.path` resolution:

1. If config contains `workspace.path`, use that.
2. Otherwise use `<home>/workspace`.

## High-Level Architecture

```text
WebUI
  -> HTTP/WS Gateway
    -> Session Store
    -> Runtime State Store
    -> Claude Runner
      -> Prompt Builder
      -> Claude Agent SDK
        -> SDK MCP Server: claudebot native tools
          -> Tool Registry
            -> Scheduler Service
            -> Memory Store
            -> Agent File Store
```

## Runtime Services

The server composes a single `ServiceContainer` per running claudebot instance.

Services:

- `ConfigService`: load, validate, and expose runtime config.
- `PathService`: resolve home, workspace, data paths.
- `SessionStore`: create, read, update, delete, and list WebUI sessions.
- `RuntimeStateStore`: persist `lastActiveSessionId`.
- `AgentProfileStore`: read/write `agent/user.md`, `agent/soul.md`, `agent/memory.json`.
- `MemoryStore`: structured operations over `memory.json`.
- `SchedulerService`: manage cron schedules and due execution.
- `ToolRegistry`: validate, authorize, audit, and execute native tools.
- `ClaudeRunner`: run user turns and scheduled one-off turns.
- `Gateway`: HTTP and WebSocket server.
- `MediaStore`: image/media persistence needed by WebUI.

## Claude Runner

The runner uses `@anthropic-ai/claude-agent-sdk`.

Each normal WebUI session stores a `claudeSessionId` when available. Future user turns resume that Claude session.

Each scheduled execution creates a one-off Claude turn. It does not reuse the last active session's Claude session ID. It reads current instance data and emits a final result into the stable `Claudebot Inbox` session so background work does not pollute the user's current conversation.

The runner injects:

- Current time and timezone.
- Current home and workspace.
- Current session key for normal user turns.
- Source marker: `user_turn` or `schedule_turn`.
- Contents of `agent/user.md`.
- Contents of `agent/soul.md`.
- Instructions for memory and scheduler tools.
- The in-process SDK MCP server containing claudebot native tools.

The runner normalizes SDK messages into gateway events:

- `text_delta`
- `thinking_delta`
- `tool_start`
- `tool_result`
- `status`
- `turn_done`
- `error`

## Native Tool Runtime

Claude native tools are exposed through Claude Agent SDK's in-process SDK MCP server:

```ts
createSdkMcpServer({
  name: "claudebot",
  instructions: "...",
  alwaysLoad: true,
  tools: [...]
})
```

The SDK adapter is only a transport layer. Business logic lives behind the internal `ToolRegistry`.

Tool execution flow:

```text
SDK tool handler
  -> ToolRegistry.execute(name, input, context)
    -> schema validation
    -> permission decision
    -> audit log start
    -> tool implementation
    -> audit log finish
    -> structured result
```

`ToolContext` includes:

- `home`
- `workspacePath`
- `timezone`
- `source`: `user_turn` or `schedule_turn`
- `sessionId` when present
- `scheduleRunId` when present
- `services`
- `logger`

Permission model:

```json
{
  "tools": {
    "permissions": {
      "default": "allow",
      "overrides": {
        "memory_delete": "allow",
        "schedule_delete": "allow"
      }
    }
  }
}
```

MVP supports `allow` and `deny`. `confirm` is accepted in config but treated as `deny` with a clear message until confirmation UI is implemented.

Audit log:

- Path: `<home>/audit/tools.jsonl`
- One JSON line per call.
- Records tool name, source, input summary, status, error if any, start time, end time.

## Built-In Native Tools

### Scheduler Tools

- `schedule_create`
- `schedule_list`
- `schedule_update`
- `schedule_delete`
- `schedule_set_enabled`
- `schedule_run_now`

`schedule_create` input:

```json
{
  "name": "Daily planning",
  "cronExpr": "0 9 * * *",
  "timezone": "Asia/Shanghai",
  "message": "Generate a planning reminder for the user."
}
```

Schedules are instance-level. They are not tied to the session where they were created.

### Memory Tools

- `memory_read`
- `memory_create`
- `memory_update`
- `memory_delete`
- `memory_search`

`memory.json` format:

```json
{
  "entries": [
    {
      "id": "mem_...",
      "content": "The user prefers Chinese for normal conversation.",
      "tags": ["preference"],
      "source": "conversation",
      "confidence": 1,
      "createdAt": "2026-06-09T00:00:00.000Z",
      "updatedAt": "2026-06-09T00:00:00.000Z"
    }
  ]
}
```

### Agent File Tools

- `agent_file_read`
- `agent_file_update`

Allowed files:

- `user.md`
- `soul.md`
- `memory.json`

`memory.json` can also be changed through memory tools. `agent_file_update` exists because the user explicitly wants Claude to be able to modify all three files.

## Scheduler

Storage:

- `<home>/scheduler/schedules.json`
- `<home>/scheduler/runs.json`

Schedule format:

```json
{
  "id": "sch_...",
  "name": "Daily planning",
  "enabled": true,
  "cronExpr": "0 9 * * *",
  "timezone": "Asia/Shanghai",
  "message": "Generate a planning reminder for the user.",
  "state": {
    "nextRunAt": "2026-06-10T09:00:00.000+08:00",
    "lastRunAt": null,
    "lastStatus": null,
    "lastError": null,
    "runCount": 0,
    "running": false
  },
  "createdAt": "2026-06-09T00:00:00.000Z",
  "updatedAt": "2026-06-09T00:00:00.000Z"
}
```

Due schedule flow:

```text
timer tick
  -> find enabled schedules whose nextRunAt <= now
  -> skip if running
  -> mark running
  -> create run record
  -> execute one-off Claude turn
  -> append final result or failure notice to last active session
  -> update run record
  -> compute nextRunAt
  -> clear running
```

Failure behavior:

- No automatic retry.
- Persist failure in schedule state and run record.
- Append a failure message to the last active session.
- Continue to next cron occurrence.

Re-entry behavior:

- If a schedule is already running when another occurrence is due, skip the occurrence.
- Persist a skipped run with status `skipped_running`.
- `schedule_run_now` also respects the running lock.

## Sessions

Session metadata is stored as a small JSON file (id, title, preview, claudeSessionId, createdAt, updatedAt). Message content is **not** stored in this file — it is owned by the Claude Agent SDK and mirrored into per-session `.jsonl` files via the `ClaudebotSessionStore` adapter (`src/sessions/adapter.ts`). The SDK's `session_id` is the canonical session identifier; `claudeSessionId` is preserved for compatibility with the metadata file but is set to the same value.

Layout under the home directory:

```
~/.claudebot/
  sessions/<sdkSessionId>/
    main.jsonl
    subagents/
      agent-<id>.jsonl
```

The `main.jsonl` file is written by the SDK (via the adapter); the gateway reads it back through `parseJsonlToUIMessages` (`src/sessions/jsonl-parser.ts`) when WebUI requests history. There is no `inbox` magic id — the first user message creates a new SDK session, and `runtimeState.lastActiveSessionId` is set to the resulting UUID.

Message JSON:

```json
{
  "id": "msg_...",
  "role": "user",
  "content": "Hello",
  "createdAt": "2026-06-09T00:00:00.000Z",
  "metadata": {}
}
```

Assistant messages may include metadata for tool events, thinking, schedule delivery, and errors.

`lastActiveSessionId` update rules:

- Update when the user opens a session.
- Update when the user switches sessions.
- Update when the user sends a message.
- Do not update when the assistant or scheduler appends a message.

If no active session exists, the gateway lets the SDK create one (the resulting `session_id` is written to `runtimeState.lastActiveSessionId`). There is no `inbox` magic id.

## Gateway HTTP API

MVP endpoints:

- `GET /health`
- `GET /webui/bootstrap`
- `GET /api/sessions`
- `PATCH /api/sessions/:id`
- `DELETE /api/sessions/:id`
- `GET /api/sessions/:id/messages`
- `POST /api/sessions/:id/activate`
- `GET /api/agent/files`
- `GET /api/agent/files/:name`
- `PUT /api/agent/files/:name`
- `GET /api/schedules`
- `POST /api/schedules/:id/run-now`
- `GET /api/media/:id`

The WebUI may use additional static routes for the bundled React app.

## Gateway WebSocket Protocol

Incoming client messages:

- `session.activate`
- `chat.user_message`
- `chat.cancel`

Outgoing server messages:

- `session.updated`
- `message.appended`
- `agent.text_delta`
- `agent.thinking_delta`
- `agent.tool_start`
- `agent.tool_result`
- `agent.status`
- `agent.turn_done`
- `agent.error`
- `schedule.delivered`

The exact JSON envelope can be adjusted during implementation to minimize React migration work, but the behavior above is fixed.

## WebUI MVP

MVP keeps the existing React app where practical but removes or hides unused features.

Required UI:

- Chat page.
- Session list.
- Create, rename, delete, search, and switch sessions.
- Streaming assistant messages.
- Markdown and code rendering.
- Tool activity rendering.
- Thinking rendering if provided.
- Cancel current turn.
- Image/media upload and preview.
- Agent page for editing:
  - `user.md`
  - `soul.md`
  - `memory.json`
- Basic settings/status display.
- Display schedule results and failures as normal assistant/system messages in the last active session.

Removed or hidden UI:

- MCP preset management.
- Pairing.
- Document parsing UI for PDF/docx/xlsx/pptx.
- Built-in skills browser.
- CLI app attachment UI.
- Multi-channel settings.

## Concurrency And File Safety

All JSON and Markdown writes are atomic:

1. Write a temporary file in the same directory.
2. Rename it over the target.

WebUI editable files use optimistic versions:

- Read response includes `version`.
- Save request includes `version`.
- If target changed, return HTTP 409.

Scheduler running locks are persisted in schedule state and also guarded in memory while the process is alive.

## Error Handling

- Invalid config: server fails fast with a clear startup error.
- Invalid agent file JSON: endpoint returns validation error; server does not overwrite automatically.
- Invalid schedule cron expression: tool/API returns validation error.
- Claude SDK error during user turn: append visible error to current session.
- Claude SDK error during schedule turn: append visible failure notice to last active session and persist run failure.
- Tool permission denied: return structured tool error.
- Tool validation failure: return structured tool error with field details.
- WebSocket disconnect: running turn continues unless explicitly cancelled by the user from another connected client.

## Testing Strategy

Use `bun test`.

Core unit tests:

- Config/home/workspace resolution.
- JSON atomic store read/write.
- Agent file store versions and 409 conflict logic.
- Memory create/update/delete/search.
- Scheduler cron next-run calculation.
- Scheduler running lock skip behavior.
- Schedule failure run record behavior.
- Session create/list/update/delete.
- Last active session update rules.
- Tool registry validation, permission, audit behavior.
- SDK adapter can create an in-process MCP server from registered tools.

Integration tests:

- Start gateway and call `/health`.
- Create session through HTTP.
- Activate session.
- Append user message through WebSocket with a mocked Claude runner.
- Execute `schedule_run_now` with mocked Claude runner and verify message lands in last active session.
- Execute failing schedule and verify failure message lands in last active session.

SDK spike:

- Before broad implementation, verify `@anthropic-ai/claude-agent-sdk` supports:
  - `query`
  - streaming events
  - session resume
  - `createSdkMcpServer`
  - `tool`
  - in-process tool execution under Bun

## Implementation Phases

1. SDK spike.
2. Bun/TS project skeleton.
3. Config, paths, JSON store.
4. Session and runtime state stores.
5. Native tool runtime, permissions, audit.
6. Agent files and memory tools.
7. Scheduler store, service, tools, runs.
8. Claude runner and prompt builder.
9. Gateway HTTP/WS.
10. WebUI migration and feature hiding.
11. End-to-end verification.

## Design Self-Review

- No placeholder requirements remain.
- Out-of-scope items are explicit.
- Scheduler is instance-level and delivery target is last active session.
- Scheduled turns do not pollute normal session transcripts.
- Native tools use the Claude Agent SDK in-process SDK MCP server, not a fallback protocol.
- Memory, agent files, and scheduler all have clear storage locations.
- WebUI MVP includes the features required by the user and excludes deferred modules.
