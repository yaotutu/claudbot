# Runtime Directory Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Claudebot runtime persistence into a clearer user-facing directory layout inspired by nanobot's config/workspace/data separation.

**Architecture:** `RuntimePaths` becomes the single source of truth for the new layout. Profile text, memory data, schedules, sessions, WebUI state, audit logs, media, logs, and Claude SDK config each get a clear top-level domain under the active instance home. No legacy path compatibility or data migration is added.

**Tech Stack:** Bun, TypeScript, bun:test, Claude Agent SDK session store.

---

### Task 1: Runtime Path Model

**Files:**
- Modify: `src/config/paths.ts`
- Modify: `tests/config.test.ts`

- [x] **Step 1: Write failing tests** asserting `runtimePaths()` returns `profile/user.md`, `profile/soul.md`, `memory/memory.json`, `schedules/jobs.json`, `schedules/runs`, `claude/config`, and `logs`.
- [x] **Step 2: Run `bun test tests/config.test.ts`** and verify the new path assertions fail against the current layout.
- [x] **Step 3: Update `RuntimePaths` and `runtimePaths()`** to use the new directory names.
- [x] **Step 4: Re-run `bun test tests/config.test.ts`** and verify it passes.

### Task 2: Schedule Run Storage

**Files:**
- Modify: `src/scheduler/store.ts`
- Modify: `src/runtime/services.ts`
- Modify: `tests/scheduler.test.ts`
- Modify: `tests/gateway.test.ts`

- [x] **Step 1: Write failing tests** for run records stored as `schedules/runs/<run-id>.json` while preserving `listRuns()` behavior.
- [x] **Step 2: Run targeted scheduler/gateway tests** and verify failures.
- [x] **Step 3: Change `SchedulerStore` to accept `jobsPath` and `runsDir`, keep schedules in `jobs.json`, and persist each run as one JSON file.**
- [x] **Step 4: Re-run targeted tests** and verify they pass.

### Task 3: Runtime Wiring

**Files:**
- Modify: `src/runtime/services.ts`
- Modify: `src/agent/runner.ts` tests if needed

- [x] **Step 1: Ensure services wire `profileDir`, `memoryDir`, `schedulesDir`, `scheduleRunsDir`, `claudeDir`, and `sdkConfigDir` from `RuntimePaths`.**
- [x] **Step 2: Run `bun run typecheck`** and fix any stale path property references.

### Task 4: Verification

**Files:**
- Modify tests only as required by renamed paths.

- [x] **Step 1: Run `bun run typecheck`.** Expected: exit 0.
- [x] **Step 2: Run `bun run test`.** Expected: all backend tests pass.
- [x] **Step 3: Do not run WebUI CDP verification because this refactor has no user-visible WebUI behavior change.**
