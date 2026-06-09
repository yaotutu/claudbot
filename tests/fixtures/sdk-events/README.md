# Claude Agent SDK Event Fixtures

Captured from a live `bun run src/spikes/sdk-native-tool-spike.ts` against
`ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic`, model `glm-5.1`,
with a single in-process SDK MCP tool `claudebot_echo` registered via
`createSdkMcpServer`.

All UUIDs and tool_use IDs sanitized to `<uuid>` placeholders.

## Files

| File | Type | Notes |
|------|------|-------|
| `01-init.json` | `system` / `init` | session_id, tools list, mcp_servers, model. **The `session_id` here is the resume key.** |
| `02-thinking-assistant.json` | `assistant` with `content[0].type=thinking` | raw thinking block + `signature` field |
| `03-tool-use-assistant.json` | `assistant` with `content[0].type=tool_use` | tool call with `id`, `name=mcp__claudebot_spike__claudebot_echo`, `input` |
| `04-tool-result-user.json` | `user` with `content[0].type=tool_result` | **Note: tool result comes back as a `user` role message**, linked by `tool_use_id` |
| `05-text-assistant.json` | `assistant` with `content[0].type=text` | final assistant text |
| `06-thinking-tokens-system.json` | `system` / `thinking_tokens` | rolling token estimate stream (skipped in MVP normalization) |
| `07-result-success.json` | `result` / `success` | terminal event with `is_error`, `num_turns`, `result` text, `total_cost_usd`, `usage`. **Also carries the `session_id` to capture for resume.** |

## Key findings driving implementation

1. **Tool registration**: `mcpServers: { claudebot_spike: server }` registers an in-process MCP server. The model sees tools with the prefix `mcp__<server_name>__<tool_name>`.
2. **In-process execution works**: tool_use → tool_result round-trip succeeded in 13.3s end-to-end.
3. **Resume API**: `query({ options: { resume: sessionId } })` continues a previous session. `session_id` is on both `init` and `result` events.
4. **Event types observed**: `system/{init,hook_started,hook_response,thinking_tokens}`, `assistant`, `user` (for tool_result echo), `result`.
5. **Normalized event mapping** (per design spec):
   - `assistant.content[type=text]` → `text_delta` (one event per text block; the model emits them in chunks at the assistant-message level, not character-level)
   - `assistant.content[type=thinking]` → `thinking_delta`
   - `assistant.content[type=tool_use]` → `tool_start`
   - `user.content[type=tool_result]` → `tool_result`
   - `result` → `turn_done` (capture `session_id` for resume)
   - `system.thinking_tokens` → ignored or emitted as `status`
6. **Hooks fire automatically**: `SessionStart:startup` hook events from the SDK's internal Claude Code hook system show up in every query. We can ignore them; the runner should filter on event `type` and ignore `subtype in {hook_started, hook_response}`.

## Resume proof

`spike-resume.txt` shows a second query with `options.resume = <init.session_id>` returned `num_turns=1` and the model correctly recalled the previous tool name and return value — confirming session resume semantics.
