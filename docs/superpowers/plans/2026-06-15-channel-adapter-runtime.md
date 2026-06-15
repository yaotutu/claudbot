# Channel Adapter Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a platform-neutral channel runtime so Telegram, QQ, Feishu, and WebUI can share inbound/outbound semantics while keeping platform SDK details inside adapters.

**Architecture:** Add a `src/channels/runtime.ts` layer that accepts normalized inbound messages, resolves channel session bindings, calls `runUserTurn`, and returns normalized outbound text. Keep rich WebUI streaming on `runUserTurn`; external adapters use the channel runtime first and can opt into richer outbound capabilities later.

**Tech Stack:** Bun, TypeScript ESM, `bun:test`, existing Claudebot service container, `pure-qqbot` for QQ SDK integration.

---

### Task 1: Channel Runtime

**Files:**
- Modify: `src/channels/types.ts`
- Create: `src/channels/runtime.ts`
- Test: `tests/channels-runtime.test.ts`

- [ ] **Step 1: Write failing tests**

Cover first-message binding creation, resume through an existing binding, and reply text aggregation from `runUserTurn` events.

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test tests/channels-runtime.test.ts --timeout 30000`

Expected: fail because `runChannelTurn` does not exist.

- [ ] **Step 3: Implement runtime types and `runChannelTurn`**

Add `ChannelInboundMessage`, `ChannelOutboundMessage`, `ChannelRunResult`, and `runChannelTurn(services, inbound)`.

- [ ] **Step 4: Run tests and verify pass**

Run: `bun test tests/channels-runtime.test.ts --timeout 30000`

Expected: pass.

### Task 2: Telegram Adapter Migration

**Files:**
- Modify: `src/channels/telegram/adapter.ts`
- Test: `tests/telegram-webhook.test.ts`

- [ ] **Step 1: Update tests to assert runtime behavior through adapter**

Keep existing webhook security and allow-list tests; ensure the happy path still writes a `telegram` binding and sends one reply.

- [ ] **Step 2: Replace duplicated binding/run aggregation logic**

Change Telegram adapter to normalize update into `ChannelInboundMessage`, call `runChannelTurn`, and send `result.replyText`.

- [ ] **Step 3: Run adapter tests**

Run: `bun test tests/telegram-webhook.test.ts tests/channels-runtime.test.ts --timeout 30000`

Expected: pass.

### Task 3: QQ Adapter Foundation

**Files:**
- Modify: `package.json`
- Modify: `src/config/schema.ts`
- Modify: `src/config/paths.ts`
- Modify: `src/channels/registry.ts`
- Create: `src/channels/qq/types.ts`
- Create: `src/channels/qq/client.ts`
- Create: `src/channels/qq/adapter.ts`
- Test: `tests/config.test.ts`
- Test: `tests/qq-adapter.test.ts`

- [ ] **Step 1: Write failing QQ adapter and config tests**

Cover default disabled QQ config, explicit QQ config parsing, private/group message normalization, allow-list filtering, binding creation, reply, and proactive fallback when passive reply fails.

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test tests/config.test.ts tests/qq-adapter.test.ts --timeout 30000`

Expected: fail because QQ config and adapter do not exist.

- [ ] **Step 3: Add `pure-qqbot` dependency and QQ config**

Run `bun add pure-qqbot`, add `channels.qq`, and add `qqSessionDir` under runtime paths.

- [ ] **Step 4: Implement QQ client boundary and adapter**

Expose a small testable `QqClient` interface, create a production client using `QQBotClient`, and keep pure QQ fields inside `src/channels/qq/*`.

- [ ] **Step 5: Wire registry lifecycle**

Register QQ when `channels.qq.enabled` is true. `start()` starts the client; `stop()` stops it; `handleHttp()` returns `null`.

- [ ] **Step 6: Run QQ tests**

Run: `bun test tests/config.test.ts tests/qq-adapter.test.ts tests/channels-registry.test.ts --timeout 30000`

Expected: pass.

### Task 4: Full Verification

**Files:**
- No new source files.

- [ ] **Step 1: Run backend verification**

Run: `bun run test` and `bun run typecheck`.

- [ ] **Step 2: Run WebUI verification**

Run: `cd webui && bun run test && bun run build && bun run lint`.

- [ ] **Step 3: CDP click verification**

Start the app and verify existing WebUI still works: page load, Settings/Search/Skills feedback, New chat draft, send a short message, remap/error state. This refactor should not change visible Web behavior.

