# Claudebot Channel Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `src/channels/` around a Nanobot-style TypeScript channel protocol using `chatId/sessionKey`, function adapters, and a shared manager.

**Architecture:** Keep Claudebot's existing `runUserTurn` and service container. Move platform lifecycle and outbound delivery into a shared channel manager, with platform adapters emitting normalized `ChannelInboundMessage` values and sending `ChannelOutboundMessage` values. Drop old `conversationId` naming and do not migrate old channel binding data.

**Tech Stack:** Bun, TypeScript ESM, `bun:test`, existing Claudebot service container, existing Telegram fetch client, existing `pure-qqbot` client boundary.

---

## File Structure

- Create `src/channels/protocol.ts`: canonical inbound/outbound/status metadata types and helper functions.
- Create `src/channels/adapter.ts`: function-based `ChannelAdapter` contract and adapter context helper.
- Create `src/channels/manager.ts`: enabled adapter creation, lifecycle, HTTP dispatch, inbound dispatch, send retry, metadata-aware outbound dispatch.
- Modify `src/channels/types.ts`: re-export protocol types and keep platform union types in one place.
- Modify `src/channels/runtime.ts`: consume `chatId/sessionKey` and return outbound `chatId`.
- Modify `src/channels/session-bindings-store.ts`: rename persisted external conversation field to `externalChatId`.
- Modify `src/channels/registry.ts`: either delegate to manager or become a compatibility export for `ChannelManager`.
- Modify `src/channels/telegram/adapter.ts`: return `ChannelAdapter`, emit normalized inbound messages, send through `send`.
- Modify `src/channels/telegram/types.ts`: align config with shared `allowFrom/streaming` fields while retaining Telegram-specific webhook fields.
- Modify `src/channels/qq/adapter.ts`: return `ChannelAdapter`, emit normalized inbound messages, keep proactive fallback in `send`.
- Modify `src/channels/qq/types.ts`: align config with shared `allowFrom/streaming` fields while retaining QQ-specific fields.
- Modify `src/config/schema.ts`: add shared channel settings and Nanobot-style aliases.
- Modify tests under `tests/`: update channel runtime, binding, manager/registry, Telegram, QQ, and config coverage.

---

### Task 1: Protocol Types and Runtime Binding

**Files:**
- Create: `src/channels/protocol.ts`
- Modify: `src/channels/types.ts`
- Modify: `src/channels/runtime.ts`
- Modify: `tests/channels-runtime.test.ts`

- [x] **Step 1: Write failing runtime tests for `chatId/sessionKey`**

Replace `conversationId` assertions in `tests/channels-runtime.test.ts` with `chatId`, and add one test proving `sessionKey` controls binding lookup:

```ts
const first = await runChannelTurn(services, {
  channel: "telegram",
  chatId: "topic-visible",
  senderId: "user-2",
  content: "first turn",
  sessionKey: "telegram:thread:42",
});
expect(first.outbound.chatId).toBe("topic-visible");
expect(await services.channelBindings.find("telegram", "telegram:thread:42")).toMatchObject({
  externalChatId: "telegram:thread:42",
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/channels-runtime.test.ts --timeout 30000`

Expected: TypeScript/runtime failures because `chatId`, `externalChatId`, and `sessionKey` binding semantics are not implemented yet.

- [x] **Step 3: Add protocol types**

Create `src/channels/protocol.ts`:

```ts
export type ChannelMetadata = Record<string, unknown>;

export type ChannelInboundMessage = {
  channel: ChannelId;
  senderId?: string;
  chatId: string;
  content: string;
  media: string[];
  metadata: ChannelMetadata;
  sessionKey?: string;
};

export type ChannelOutboundMessage = {
  channel: ChannelId;
  chatId: string;
  content: string;
  isError: boolean;
  replyTo?: string;
  media: string[];
  metadata: ChannelMetadata;
  buttons?: string[][];
};

export type ChannelRunResult = {
  sessionId: string | null;
  runId: string;
  isError: boolean;
  outbound: ChannelOutboundMessage;
};

export type ChannelSessionBinding = {
  channel: ChannelId;
  externalChatId: string;
  externalUserId?: string;
  claudebotSessionId: string;
  createdAt: string;
  updatedAt: string;
};

export type UpsertChannelSessionBindingInput = {
  channel: ChannelId;
  externalChatId: string;
  externalUserId?: string;
  claudebotSessionId: string;
};

export type ChannelId = "telegram" | "feishu" | "qq";

export function channelSessionKey(inbound: Pick<ChannelInboundMessage, "channel" | "chatId" | "sessionKey">): string {
  return inbound.sessionKey ?? `${inbound.channel}:${inbound.chatId}`;
}
```

Update `src/channels/types.ts` to re-export from `protocol.ts`.

- [x] **Step 4: Update `runChannelTurn`**

Change `src/channels/runtime.ts` to use `chatId` and `channelSessionKey(inbound)`:

```ts
const externalChatId = channelSessionKey(inbound);
const existing = await services.channelBindings.find(inbound.channel, externalChatId);
```

Upsert `externalChatId`, and return outbound `chatId: inbound.chatId`.

- [x] **Step 5: Run runtime tests**

Run: `bun test tests/channels-runtime.test.ts --timeout 30000`

Expected: PASS after binding store is updated in Task 2; before Task 2, failures should point only to `externalChatId` store shape.

- [x] **Step 6: Commit**

```bash
git add src/channels/protocol.ts src/channels/types.ts src/channels/runtime.ts tests/channels-runtime.test.ts
git commit -m "refactor(channels): define nanobot-style protocol"
```

---

### Task 2: Session Binding Store Rename

**Files:**
- Modify: `src/channels/session-bindings-store.ts`
- Modify: `tests/channels-session-bindings.test.ts`
- Modify: `tests/channels-runtime.test.ts`
- Modify: `tests/telegram-webhook.test.ts`
- Modify: `tests/qq-adapter.test.ts`

- [x] **Step 1: Write failing binding tests**

Update `tests/channels-session-bindings.test.ts` so every upsert uses `externalChatId`:

```ts
await store.upsert({
  channel: "telegram",
  externalChatId: "telegram:chat-1",
  externalUserId: "user-1",
  claudebotSessionId: "sess-1",
});

expect(await store.find("telegram", "telegram:chat-1")).toMatchObject({
  channel: "telegram",
  externalChatId: "telegram:chat-1",
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/channels-session-bindings.test.ts --timeout 30000`

Expected: FAIL because `externalChatId` is not accepted by the store yet.

- [x] **Step 3: Rename store fields**

In `src/channels/session-bindings-store.ts`, replace `externalConversationId` with `externalChatId` in `find`, `upsert`, `delete`, and matching predicates.

The `find` signature becomes:

```ts
find: (channel: ChannelId, externalChatId: string) => Promise<ChannelSessionBinding | null>;
```

- [x] **Step 4: Update remaining binding assertions**

Update all tests that inspect bindings to expect `externalChatId`, including Telegram and QQ adapter tests.

- [x] **Step 5: Run binding and runtime tests**

Run: `bun test tests/channels-session-bindings.test.ts tests/channels-runtime.test.ts tests/telegram-webhook.test.ts tests/qq-adapter.test.ts --timeout 30000`

Expected: PASS for binding/runtime tests after adapter tests are updated in later tasks; failures before Task 4 should point to old adapter inputs only.

- [x] **Step 6: Commit**

```bash
git add src/channels/session-bindings-store.ts tests/channels-session-bindings.test.ts tests/channels-runtime.test.ts tests/telegram-webhook.test.ts tests/qq-adapter.test.ts
git commit -m "refactor(channels): rename bindings to external chat ids"
```

---

### Task 3: Adapter Contract and Channel Manager

**Files:**
- Create: `src/channels/adapter.ts`
- Create: `src/channels/manager.ts`
- Modify: `src/channels/registry.ts`
- Modify: `src/gateway/http.ts`
- Modify: `src/server.ts`
- Modify: `tests/channels-registry.test.ts`

- [x] **Step 1: Write failing manager tests**

Update `tests/channels-registry.test.ts` to import `createChannelManager` from `src/channels/manager.ts`. Add a fake adapter test:

```ts
const inbound: ChannelInboundMessage[] = [];
const sent: ChannelOutboundMessage[] = [];
const manager = createChannelManager(services, {
  adapters: [{
    name: "telegram",
    displayName: "Telegram",
    start: async () => {},
    stop: async () => {},
    send: async (msg) => { sent.push(msg); },
    handleHttp: async () => new Response("handled", { status: 202 }),
  }],
});
```

Expected assertions:

```ts
expect((await manager.handleHttp(new Request("http://x/tg"), new URL("http://x/tg")))?.status).toBe(202);
await manager.start();
await manager.stop();
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/channels-registry.test.ts --timeout 30000`

Expected: FAIL because `createChannelManager` does not exist.

- [x] **Step 3: Add adapter contract**

Create `src/channels/adapter.ts`:

```ts
import type { ChannelInboundMessage, ChannelOutboundMessage, ChannelId } from "./protocol.ts";

export type ChannelStatus = {
  name: ChannelId;
  displayName: string;
  enabled: boolean;
  running: boolean;
};

export type ChannelAdapter = {
  name: ChannelId;
  displayName: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  send: (msg: ChannelOutboundMessage) => Promise<void>;
  handleHttp?: (req: Request, url: URL) => Promise<Response | null>;
  login?: (options?: { force?: boolean }) => Promise<boolean>;
  status?: () => Promise<ChannelStatus>;
  sendDelta?: (chatId: string, delta: string, metadata?: Record<string, unknown>) => Promise<void>;
  sendReasoningDelta?: (chatId: string, delta: string, metadata?: Record<string, unknown>) => Promise<void>;
  sendReasoningEnd?: (chatId: string, metadata?: Record<string, unknown>) => Promise<void>;
};

export type ChannelInboundHandler = (message: ChannelInboundMessage) => Promise<void>;
```

- [x] **Step 4: Add manager**

Create `src/channels/manager.ts` with:

- `createChannelManager(services, deps)`
- `start`, `stop`, `handleHttp`
- `dispatchInbound(inbound)` calling `runChannelTurn`
- `dispatchOutbound(outbound)` choosing `send`, `sendDelta`, `sendReasoningDelta`, or `sendReasoningEnd`
- `sendWithRetry(adapter, outbound)` using `services.config.channels.sendMaxRetries`

- [x] **Step 5: Keep registry compatibility**

Change `src/channels/registry.ts` to re-export:

```ts
export { createChannelManager as createChannelRegistry } from "./manager.ts";
export type { ChannelManager as ChannelRegistry, ChannelManagerDeps as ChannelRegistryDeps } from "./manager.ts";
```

Keep `createEmptyChannelRegistry()` as a thin manager-compatible object for existing imports.

- [x] **Step 6: Run manager tests**

Run: `bun test tests/channels-registry.test.ts --timeout 30000`

Expected: PASS after Telegram/QQ factory wiring compiles in later tasks.

- [x] **Step 7: Commit**

```bash
git add src/channels/adapter.ts src/channels/manager.ts src/channels/registry.ts src/gateway/http.ts src/server.ts tests/channels-registry.test.ts
git commit -m "refactor(channels): add shared channel manager"
```

---

### Task 4: Telegram Adapter Migration

**Files:**
- Modify: `src/channels/telegram/adapter.ts`
- Modify: `src/channels/telegram/types.ts`
- Modify: `tests/telegram-webhook.test.ts`
- Modify: `tests/channels-registry.test.ts`

- [x] **Step 1: Write failing Telegram tests**

Update tests to expect:

```ts
expect(binding).toMatchObject({
  channel: "telegram",
  externalChatId: "telegram:123",
});
```

Update adapter creation to use manager injection if needed:

```ts
const adapter = createTelegramAdapter(services, config, {
  sendMessage: async (chatId, text) => { sent.push({ chatId, text }); },
});
```

- [x] **Step 2: Run Telegram tests to verify they fail**

Run: `bun test tests/telegram-webhook.test.ts tests/channels-registry.test.ts --timeout 30000`

Expected: FAIL because Telegram still emits `conversationId` and directly calls the old runtime.

- [x] **Step 3: Update Telegram config type**

Add shared fields to `src/channels/telegram/types.ts`:

```ts
allowFrom: string[];
streaming: boolean;
```

Retain `allowedChatIds` during this task as a Telegram-specific compatibility allowlist for webhook tests.

- [x] **Step 4: Update Telegram adapter**

Return `ChannelAdapter` with `name: "telegram"` and `displayName: "Telegram"`. `handleHttp` normalizes Telegram updates to:

```ts
{
  channel: "telegram",
  chatId: inbound.chatId,
  senderId: inbound.userId,
  content: inbound.text,
  media: [],
  metadata: { messageId: inbound.messageId },
  sessionKey: `telegram:${inbound.chatId}`,
}
```

Then call manager inbound hook or `runChannelTurn` through the manager-compatible context, and send via `adapter.send`.

- [x] **Step 5: Run Telegram tests**

Run: `bun test tests/telegram-webhook.test.ts tests/channels-registry.test.ts --timeout 30000`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/channels/telegram/adapter.ts src/channels/telegram/types.ts tests/telegram-webhook.test.ts tests/channels-registry.test.ts
git commit -m "refactor(channels): migrate telegram to channel protocol"
```

---

### Task 5: QQ Adapter Migration

**Files:**
- Modify: `src/channels/qq/adapter.ts`
- Modify: `src/channels/qq/types.ts`
- Modify: `tests/qq-adapter.test.ts`
- Modify: `tests/channels-registry.test.ts`

- [x] **Step 1: Write failing QQ tests**

Update binding expectations:

```ts
const binding = await services.channelBindings.find("qq", "qq:c2c:user-a");
expect(binding?.externalChatId).toBe("qq:c2c:user-a");
```

For group:

```ts
const binding = await services.channelBindings.find("qq", "qq:group:group-a");
expect(binding?.externalUserId).toBe("member-a");
```

- [x] **Step 2: Run QQ tests to verify they fail**

Run: `bun test tests/qq-adapter.test.ts tests/channels-registry.test.ts --timeout 30000`

Expected: FAIL because QQ still emits old binding ids.

- [x] **Step 3: Update QQ config type**

Add shared fields to `QqConfig` through schema in Task 6 and use them in tests:

```ts
allowFrom: string[];
streaming: boolean;
```

Keep `allowedConversationIds`, `allowedUserIds`, and `allowedGroupOpenids` for QQ-specific allowlists during this migration.

- [x] **Step 4: Update QQ adapter**

Return `ChannelAdapter` with `name: "qq"` and `displayName: "QQ"`. Normalize QQ events to:

```ts
{
  channel: "qq",
  chatId: inbound.chatId,
  senderId: inbound.senderId,
  content: inbound.content,
  media: [],
  metadata: {
    messageId: event.messageId,
    qqType: event.type,
    groupOpenid: event.groupOpenid,
    guildId: event.guildId,
    channelId: event.channelId,
  },
  sessionKey: `qq:${inbound.chatId}`,
}
```

Keep passive `reply(event, content)` first and proactive fallback on failure.

- [x] **Step 5: Run QQ tests**

Run: `bun test tests/qq-adapter.test.ts tests/channels-registry.test.ts --timeout 30000`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/channels/qq/adapter.ts src/channels/qq/types.ts tests/qq-adapter.test.ts tests/channels-registry.test.ts
git commit -m "refactor(channels): migrate qq to channel protocol"
```

---

### Task 6: Config Schema and Full Verification

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `tests/config.test.ts`
- Modify: `src/channels/README.md`

- [x] **Step 1: Write failing config tests**

Update `tests/config.test.ts` to expect shared fields:

```ts
expect(config.channels).toMatchObject({
  sendProgress: true,
  sendToolHints: false,
  showReasoning: true,
  sendMaxRetries: 3,
});
expect(config.channels.telegram).toMatchObject({
  allowFrom: [],
  streaming: false,
});
expect(config.channels.qq).toMatchObject({
  allowFrom: [],
  streaming: false,
});
```

Add alias test:

```ts
const config = resolveRuntimeConfig({
  channels: {
    send_progress: false,
    telegram: { allow_from: ["42"], streaming: true },
  },
}, { homeEnv: "", configDir: "/tmp/cfg" });
expect(config.channels.sendProgress).toBe(false);
expect(config.channels.telegram.allowFrom).toEqual(["42"]);
```

- [x] **Step 2: Run config tests to verify they fail**

Run: `bun test tests/config.test.ts --timeout 30000`

Expected: FAIL because aliases and shared fields are not implemented yet.

- [x] **Step 3: Update config schema**

In `src/config/schema.ts`, add shared fields to `ChannelsSchema` using zod alias/preprocess helpers where needed:

- `sendProgress`
- `sendToolHints`
- `showReasoning`
- `sendMaxRetries`
- per-channel `allowFrom`
- per-channel `streaming`

Read snake_case aliases: `send_progress`, `send_tool_hints`, `show_reasoning`, `send_max_retries`, `allow_from`.

- [x] **Step 4: Update README if implementation details changed**

Keep `src/channels/README.md` aligned with actual file names and config field names.

- [x] **Step 5: Run focused backend tests**

Run:

```bash
bun test tests/config.test.ts tests/channels-session-bindings.test.ts tests/channels-runtime.test.ts tests/telegram-webhook.test.ts tests/qq-adapter.test.ts tests/channels-registry.test.ts --timeout 30000
```

Expected: PASS.

- [x] **Step 6: Run typecheck**

Run: `bun run typecheck`

Expected: PASS with 0 TypeScript errors.

- [x] **Step 7: Run backend test suite**

Run: `bun run test`

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/config/schema.ts tests/config.test.ts src/channels/README.md
git commit -m "feat(channels): finalize channel protocol config"
```

---

## Self-Review

- Spec coverage: protocol types, adapter contract, manager, session binding rename, Telegram/QQ migrations, config aliases, README rule, and verification are all covered.
- Placeholder scan: no task contains TBD/TODO/implement later placeholders.
- Type consistency: the plan uses `chatId`, `sessionKey`, `externalChatId`, `ChannelAdapter`, and `ChannelOutboundMessage` consistently across tasks.
