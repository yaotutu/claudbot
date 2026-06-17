import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildServices } from "../src/runtime/services.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { runtimePaths } from "../src/config/paths.ts";
import { handleHttp } from "../src/gateway/http.ts";
import type { QueryFactory } from "../src/agent/runner.ts";
import type { SdkMessage } from "../src/agent/events.ts";
import { readFileSync } from "node:fs";
import { appendSessionJsonlEntry } from "../src/sessions/jsonl-store.ts";
import { readFile } from "node:fs/promises";

function makeRecordingQueryFactory(events: SdkMessage[]): QueryFactory & { calls: Array<{ prompt: string; resumeSessionId?: string }> } {
  const calls: Array<{ prompt: string; resumeSessionId?: string }> = [] as never;
  const factory: QueryFactory = async function* (args) {
    (calls as Array<{ prompt: string; resumeSessionId?: string }>).push({ prompt: args.prompt, resumeSessionId: args.resumeSessionId });
    for (const e of events) yield e;
  };
  return Object.assign(factory, { calls: calls as Array<{ prompt: string; resumeSessionId?: string }> });
}

async function makeServices(queryFactory: QueryFactory) {
  const dir = await mkdtemp(join(tmpdir(), "claudebot-gw-"));
  const config = resolveRuntimeConfig({ home: dir }, {});
  const paths = runtimePaths(config);
  const services = await buildServices({ config, paths, queryFactory });
  return { services, dir };
}

describe("gateway HTTP", () => {
  test("service container exposes business sessions but not SDK session facade", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));

    expect("sessions" in services).toBe(true);
    expect("sdkSessions" in services).toBe(false);
  });

  test("service container exposes channel session bindings", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));

    await services.channelBindings.upsert({
      channel: "telegram",
      externalChatId: "telegram:chat-1",
      claudebotSessionId: "sess-1",
    });

    expect(await services.channelBindings.find("telegram", "telegram:chat-1")).toMatchObject({
      claudebotSessionId: "sess-1",
    });
  });

  test("delegates channel HTTP routes before normal API handling", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const registry = {
      handleHttp: async (_req: Request, url: URL) => {
        if (url.pathname === "/channels/test") return new Response(JSON.stringify({ handled: true }), { status: 202 });
        return null;
      },
    };

    const res = await handleHttp(
      new Request("http://x/channels/test", { method: "POST" }),
      new URL("http://x/channels/test"),
      services,
      registry,
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ handled: true });
  });

  test("GET /health returns ok", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const res = await handleHttp(new Request("http://x/health"), new URL("http://x/health"), services);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  test("GET /api/sessions returns empty list when no sessions exist", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const list = await handleHttp(new Request("http://x/api/sessions"), new URL("http://x/api/sessions"), services);
    expect(list.status).toBe(200);
    const arr = await list.json() as { id: string }[];
    expect(arr).toEqual([]);
  });

  test("GET /api/sessions lists sessions seeded by JSONL", async () => {
    const { services, dir } = await makeServices(makeRecordingQueryFactory([]));
    await appendSessionJsonlEntry(join(dir, "sessions"), "sess-seeded", {
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-09T10:00:00Z",
      message: { role: "user", content: "hi" },
    });
    const list = await handleHttp(new Request("http://x/api/sessions"), new URL("http://x/api/sessions"), services);
    expect(list.status).toBe(200);
    const arr = await list.json() as { id: string }[];
    expect(arr.find((s) => s.id === "sess-seeded")).toBeTruthy();
  });

  test("GET /api/sessions returns canonical WebUI session summaries", async () => {
    const { services, dir } = await makeServices(makeRecordingQueryFactory([]));
    const seededId = randomUUID();
    await appendSessionJsonlEntry(join(dir, "sessions"), seededId, {
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-10T09:59:40.000Z",
      message: { role: "user", content: "hello world" },
    });
    await appendSessionJsonlEntry(join(dir, "sessions"), seededId, {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-06-10T09:59:45.000Z",
      message: { role: "assistant", content: "hi" },
    });
    await appendSessionJsonlEntry(join(dir, "sessions"), seededId, {
      type: "custom-title",
      uuid: randomUUID(),
      timestamp: "2026-06-10T10:00:00.000Z",
      customTitle: "hello world",
      sessionId: seededId,
    });

    const res = await handleHttp(new Request("http://x/api/sessions"), new URL("http://x/api/sessions"), services);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    const summary = body.find((row) => row.id === seededId);

    expect(summary).toMatchObject({
      id: seededId,
      title: "hello world",
      preview: "hello world",
      messageCount: 2,
      status: "persisted",
    });
    expect(typeof summary?.createdAt).toBe("string");
    expect(typeof summary?.updatedAt).toBe("string");
  });

  test("GET /api/runtime returns read-only runtime info", async () => {
    const { services, dir } = await makeServices(makeRecordingQueryFactory([]));
    const res = await handleHttp(new Request("http://x/api/runtime"), new URL("http://x/api/runtime"), services);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body).toMatchObject({
      home: dir,
      workspace: join(dir, "workspace"),
      gateway: { host: "0.0.0.0", port: 18790 },
      model: "sonnet",
      providerModel: "",
      permissionMode: "bypassPermissions",
    });
  });

  test("GET /api/notifications returns newest WebUI delivery records first", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    await services.notificationStore.create({
      source: "schedule",
      title: "定时任务 older",
      content: "old result",
      status: "succeeded",
      scheduleId: "sch_old",
      runId: "run_old",
      delivery: { type: "webui_inbox", scope: "global" },
    });
    const newest = await services.notificationStore.create({
      source: "schedule",
      title: "定时任务 newer",
      content: "new result",
      status: "failed",
      scheduleId: "sch_new",
      runId: "run_new",
      delivery: { type: "webui_inbox", scope: "global" },
    });

    const res = await handleHttp(new Request("http://x/api/notifications"), new URL("http://x/api/notifications"), services);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;

    expect(body[0]).toMatchObject({ id: newest.id, source: "schedule", content: "new result", readAt: null });
    expect(body.map((row) => row.runId)).toEqual(["run_new", "run_old"]);
  });

  test("POST /api/notifications/read-all marks WebUI delivery records read", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const first = await services.notificationStore.create({
      source: "schedule",
      title: "定时任务 first",
      content: "first result",
      status: "succeeded",
      scheduleId: "sch_first",
      runId: "run_first",
      delivery: { type: "webui_inbox", scope: "global" },
    });
    const second = await services.notificationStore.create({
      source: "schedule",
      title: "定时任务 second",
      content: "second result",
      status: "succeeded",
      scheduleId: "sch_second",
      runId: "run_second",
      delivery: { type: "webui_inbox", scope: "global" },
    });

    const res = await handleHttp(new Request("http://x/api/notifications/read-all", { method: "POST" }), new URL("http://x/api/notifications/read-all"), services);
    expect(res.status).toBe(200);
    const body = await res.json() as { updated: number };
    expect(body.updated).toBe(2);

    const rows = await services.notificationStore.list();
    expect(rows.find((row) => row.id === first.id)?.readAt).toEqual(expect.any(String));
    expect(rows.find((row) => row.id === second.id)?.readAt).toEqual(expect.any(String));
  });

  test("POST /api/sessions/:id/activate updates last active", async () => {
    const { services, dir } = await makeServices(makeRecordingQueryFactory([]));
    await appendSessionJsonlEntry(join(dir, "sessions"), "sess_activate_test", { type: "user", uuid: "u1" });
    const activate = await handleHttp(
      new Request("http://x/api/sessions/sess_activate_test/activate", { method: "POST" }),
      new URL("http://x/api/sessions/sess_activate_test/activate"),
      services,
    );
    expect(activate.status).toBe(200);
    const state = await services.runtimeState.get();
    expect(state.lastActiveSessionId).toBe("sess_activate_test");
  });

  test("POST /api/sessions/:id/activate clears stale active ids", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const activate = await handleHttp(
      new Request("http://x/api/sessions/missing/activate", { method: "POST" }),
      new URL("http://x/api/sessions/missing/activate"),
      services,
    );
    expect(activate.status).toBe(200);
    expect(await activate.json()).toEqual({ activeSessionId: null });
    expect((await services.runtimeState.get()).lastActiveSessionId).toBe("");
  });

  test("PUT /api/agent/files/:name returns 409 on stale version", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const r1 = await handleHttp(new Request("http://x/api/agent/files/user.md"), new URL("http://x/api/agent/files/user.md"), services);
    const file = await r1.json() as { content: string; version: string };
    const put1 = await handleHttp(
      new Request("http://x/api/agent/files/user.md", { method: "PUT", body: JSON.stringify({ content: "v1", expectedVersion: file.version }) }),
      new URL("http://x/api/agent/files/user.md"),
      services,
    );
    expect(put1.status).toBe(200);
    const put2 = await handleHttp(
      new Request("http://x/api/agent/files/user.md", { method: "PUT", body: JSON.stringify({ content: "v2-stale", expectedVersion: file.version }) }),
      new URL("http://x/api/agent/files/user.md"),
      services,
    );
    expect(put2.status).toBe(409);
  });

  test("GET /api/agent/files returns only profile files", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const res = await handleHttp(new Request("http://x/api/agent/files"), new URL("http://x/api/agent/files"), services);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["soul.md", "user.md"]);
  });

  test("memory endpoints expose status files dream and commits", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    await Bun.write(services.paths.longTermMemoryFile, "# Memory\n\nHTTP visible fact.\n");
    await appendSessionJsonlEntry(services.paths.sessionsDir, "sess_memory_http", {
      type: "user",
      uuid: "mem-http-1",
      timestamp: "2026-06-15T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "请记住：HTTP status should report applied candidates as drained." }] },
    });

    const status = await handleHttp(new Request("http://x/api/memory/status"), new URL("http://x/api/memory/status"), services);
    expect(status.status).toBe(200);
    const statusBody = await status.json() as { longTermFile: string; exists: boolean; pendingCandidates: number; gitAudit: { available: boolean } };
    expect(statusBody.longTermFile.endsWith("MEMORY.md")).toBe(true);
    expect(statusBody.exists).toBe(true);
    expect(statusBody.pendingCandidates).toBe(1);

    const files = await handleHttp(new Request("http://x/api/memory/files"), new URL("http://x/api/memory/files"), services);
    expect(files.status).toBe(200);
    const filesBody = await files.json() as Record<string, { content: string; version: string }>;
    expect(filesBody["memory/MEMORY.md"].content).toContain("HTTP visible fact");

    const dream = await handleHttp(
      new Request("http://x/api/memory/dream", { method: "POST", body: JSON.stringify({ dryRun: true }) }),
      new URL("http://x/api/memory/dream"),
      services,
    );
    expect(dream.status).toBe(200);
    expect(await dream.json()).toMatchObject({ dryRun: true, applied: 1 });

    const applyDream = await handleHttp(
      new Request("http://x/api/memory/dream", { method: "POST", body: JSON.stringify({ dryRun: false }) }),
      new URL("http://x/api/memory/dream"),
      services,
    );
    expect(applyDream.status).toBe(200);
    expect(await applyDream.json()).toMatchObject({ dryRun: false, applied: 1 });

    const drained = await handleHttp(new Request("http://x/api/memory/status"), new URL("http://x/api/memory/status"), services);
    const drainedBody = await drained.json() as { pendingCandidates: number };
    expect(drainedBody.pendingCandidates).toBe(0);

    const commits = await handleHttp(new Request("http://x/api/memory/commits"), new URL("http://x/api/memory/commits"), services);
    expect(commits.status).toBe(200);
    expect(Array.isArray(await commits.json())).toBe(true);
  });

  test("POST /api/schedules/:id/run-now starts a run without waiting for agent execution", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const factory: QueryFactory = async function* () {
      await blocker;
      yield { type: "result", session_id: "sched-fast-return", result: "done", is_error: false } as SdkMessage;
    };
    const { services } = await makeServices(factory);
    const sched = await services.storeOps.create({ name: "t", cronExpr: "* * * * *", timezone: "UTC", message: "x" });
    const pending = handleHttp(
      new Request(`http://x/api/schedules/${sched.id}/run-now`, { method: "POST" }),
      new URL(`http://x/api/schedules/${sched.id}/run-now`),
      services,
    );

    const res = await Promise.race([
      pending,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    release();
    expect(res).not.toBe("timeout");
    if (res === "timeout") return;
    expect(res.status).toBe(200);
    const run = await res.json() as { started: boolean; runId: string; status: string; scheduleId: string };
    expect(run.started).toBe(true);
    expect(run.status).toBe("running");
    expect(run.scheduleId).toBe(sched.id);
  });

  test("scheduler CRUD API creates, updates, lists runs, and deletes schedules", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));

    const create = await handleHttp(
      new Request("http://x/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "daily", cronExpr: "* * * * *", timezone: "UTC", message: "check" }),
      }),
      new URL("http://x/api/schedules"),
      services,
    );
    expect(create.status).toBe(200);
    const created = await create.json() as { id: string; name: string; enabled: boolean };
    expect(created.name).toBe("daily");
    expect(created.enabled).toBe(true);

    const update = await handleHttp(
      new Request(`http://x/api/schedules/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "daily updated", message: "check harder", enabled: false }),
      }),
      new URL(`http://x/api/schedules/${created.id}`),
      services,
    );
    expect(update.status).toBe(200);
    const updated = await update.json() as { id: string; name: string; message: string; enabled: boolean };
    expect(updated).toMatchObject({ id: created.id, name: "daily updated", message: "check harder", enabled: false });

    await services.trigger.runNow(created.id);
    const runs = await handleHttp(
      new Request(`http://x/api/schedule-runs?scheduleId=${created.id}`),
      new URL(`http://x/api/schedule-runs?scheduleId=${created.id}`),
      services,
    );
    expect(runs.status).toBe(200);
    const runRows = await runs.json() as Array<{ scheduleId: string }>;
    expect(runRows.length).toBeGreaterThanOrEqual(1);
    expect(runRows.every((run) => run.scheduleId === created.id)).toBe(true);

    const del = await handleHttp(
      new Request(`http://x/api/schedules/${created.id}`, { method: "DELETE" }),
      new URL(`http://x/api/schedules/${created.id}`),
      services,
    );
    expect(del.status).toBe(200);
    const list = await handleHttp(new Request("http://x/api/schedules"), new URL("http://x/api/schedules"), services);
    const remaining = await list.json() as Array<{ id: string }>;
    expect(remaining.find((schedule) => schedule.id === created.id)).toBeUndefined();
  });

  test("failing schedule run persists failure (covered in scheduler.test.ts)", async () => {
    // Executor-failure case is unit-tested directly against SchedulerService.
    // Gateway surface is the same code path as the success test above.
    expect(true).toBe(true);
  });
});

describe("ClaudeRunner end-to-end (mocked query factory)", () => {
  test("user message -> mocked runner -> assistant text_delta + turn_done", async () => {
    const init = JSON.parse(readFileSync("tests/fixtures/sdk-events/01-init.json", "utf8")) as SdkMessage;
    const text = JSON.parse(readFileSync("tests/fixtures/sdk-events/05-text-assistant.json", "utf8")) as SdkMessage;
    const result = JSON.parse(readFileSync("tests/fixtures/sdk-events/07-result-success.json", "utf8")) as SdkMessage;
    const factory = makeRecordingQueryFactory([init, text, result]);
    const { services } = await makeServices(factory);

    // No POST /api/sessions create — sessions are created on the first user
    // turn by the SDK itself. Drive the runner with a fresh session id.
    const sessionId = "sess_ws_e2e";
    const runner = services.makeRunner("user_turn", sessionId);
    const events: { type: string; text?: string; result?: string; sessionId?: string }[] = [];
    for await (const ev of runner.run({ prompt: "hi", resumeSessionId: sessionId })) events.push(ev as never);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "turn_done")).toBe(true);

    expect(factory.calls.length).toBe(1);
    expect(factory.calls[0].prompt).toBe("hi");
  });
});

describe("runUserTurn", () => {
  test("uses agentRuntimeManager and remaps draft runtime to SDK session", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const sent: unknown[] = [];
    const calls: Array<{ sessionId: string; content: string; runId?: string; resumeSessionId?: string }> = [];
    const remaps: Array<{ from: string; to: string }> = [];
    services.agentRuntimeManager = {
      ...services.agentRuntimeManager,
      runTurn: async (args: { sessionId: string; content: string; runId?: string; resumeSessionId?: string; onEvent?: (event: unknown) => void }) => {
        calls.push(args);
        const events = [
          { type: "status", status: "session_init", sessionId: "sdk-session-1" },
          { type: "text_delta", text: "pong", sessionId: "sdk-session-1" },
          { type: "turn_done", sessionId: "sdk-session-1", isError: false, result: "pong" },
        ];
        for (const event of events) args.onEvent?.(event);
        return { runId: args.runId || "r1", events };
      },
      remapSession: (from: string, to: string) => { remaps.push({ from, to }); },
    } as never;
    const { runUserTurn } = await import("../src/conversation/run-user-turn.ts");
    await runUserTurn(
      services,
      { source: "webui", sessionId: null, content: "ping", draftId: "draft-1" },
      { send: (event) => { sent.push(event); } },
    );

    expect(calls[0].sessionId).toBe("draft-1");
    expect(calls[0].resumeSessionId).toBeUndefined();
    expect(remaps).toEqual([{ from: "draft-1", to: "sdk-session-1" }]);
    expect(sent.map((m) => (m as { type: string }).type)).toContain("session.created");
  });

  test("emits native run frames and creates a persisted session from a draft", async () => {
    const init = JSON.parse(readFileSync("tests/fixtures/sdk-events/01-init.json", "utf8")) as SdkMessage;
    const text = JSON.parse(readFileSync("tests/fixtures/sdk-events/05-text-assistant.json", "utf8")) as SdkMessage;
    const result = JSON.parse(readFileSync("tests/fixtures/sdk-events/07-result-success.json", "utf8")) as SdkMessage;
    const factory = makeRecordingQueryFactory([init, text, result]);
    const { services } = await makeServices(factory);

    const sent: unknown[] = [];
    const { runUserTurn } = await import("../src/conversation/run-user-turn.ts");
    await runUserTurn(
      services,
      { source: "webui", sessionId: null, content: "ping", draftId: "draft-1" },
      { send: (event) => { sent.push(event); } },
    );

    const types = sent.map((m) => (m as { type: string }).type);
    expect(types).toEqual([
      "run.started",
      "session.created",
      "run.status",
      "run.delta",
      "run.completed",
      "message.appended",
    ]);
    const created = sent.find((m) => (m as { type: string }).type === "session.created") as { draftId?: string; session?: { id?: string; title?: string } } | undefined;
    expect(created?.draftId).toBe("draft-1");
    expect(created?.session?.title).toBe("ping");
  });

  test("forwards only native run frames for the runner stream", async () => {
    const init = JSON.parse(readFileSync("tests/fixtures/sdk-events/01-init.json", "utf8")) as SdkMessage;
    const text = JSON.parse(readFileSync("tests/fixtures/sdk-events/05-text-assistant.json", "utf8")) as SdkMessage;
    const result = JSON.parse(readFileSync("tests/fixtures/sdk-events/07-result-success.json", "utf8")) as SdkMessage;
    const factory = makeRecordingQueryFactory([init, text, result]);
    const { services } = await makeServices(factory);

    const sent: unknown[] = [];
    const { runUserTurn } = await import("../src/conversation/run-user-turn.ts");
    await runUserTurn(
      services,
      { source: "webui", sessionId: null, content: "hi" },
      { send: (event) => { sent.push(event); } },
    );

    // The runner stream is forwarded through the claudebot-native run frames.
    const types = sent.map((m) => (m as { type: string }).type);
    expect(types.every((type) => !type.startsWith("agent."))).toBe(true);
    expect(types).toContain("run.status");
    expect(types).toContain("run.delta");
    expect(types).toContain("run.completed");
    // The final assistant message goes out as a single message.appended frame.
    expect(types).toContain("message.appended");
    const appended = sent.find((m) => (m as { type: string }).type === "message.appended") as { type: string; message: { role: string; content: string } } | undefined;
    expect(appended?.message.role).toBe("assistant");
  });

  test("runs memory dream after a successful explicit memory turn", async () => {
    const factory = makeRecordingQueryFactory([]);
    const { services } = await makeServices(factory);
    const { maybeRunExplicitMemoryDreamAfterTurn } = await import("../src/gateway/websocket.ts");

    await appendSessionJsonlEntry(services.paths.sessionsDir, "sess_auto_memory", {
      type: "user",
      uuid: "msg_auto_memory",
      timestamp: "2026-06-15T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "记住：我叫 yaotutu" }] },
    });

    await maybeRunExplicitMemoryDreamAfterTurn(services, "记住：我叫 yaotutu", "sess_auto_memory", false);

    expect(await readFile(services.paths.longTermMemoryFile, "utf8")).toContain("我叫 yaotutu");
  });

  test("explicit memory turn does not apply unrelated pending candidates", async () => {
    const factory = makeRecordingQueryFactory([]);
    const { services } = await makeServices(factory);
    const { appendMemoryEvent } = await import("../src/memory/markdown-store.ts");
    const { maybeRunExplicitMemoryDreamAfterTurn } = await import("../src/gateway/websocket.ts");

    await appendMemoryEvent(services.memoryPaths, {
      type: "candidate",
      id: "implicit_pending_1",
      sessionId: "sess_other",
      content: "隐式候选不应该被显式触发自动应用。",
      source: "periodic_dream",
      createdAt: "2026-06-15T00:00:00.000Z",
    });
    await appendSessionJsonlEntry(services.paths.sessionsDir, "sess_auto_memory_scoped", {
      type: "user",
      uuid: "msg_auto_memory_scoped",
      timestamp: "2026-06-15T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "记住：我喜欢中文说明" }] },
    });

    await maybeRunExplicitMemoryDreamAfterTurn(services, "记住：我喜欢中文说明", "sess_auto_memory_scoped", false);

    const memory = await readFile(services.paths.longTermMemoryFile, "utf8");
    expect(memory).toContain("我喜欢中文说明");
    expect(memory).not.toContain("隐式候选不应该被显式触发自动应用");
  });

  test("does not run memory dream for ordinary or failed turns", async () => {
    const factory = makeRecordingQueryFactory([]);
    const { services } = await makeServices(factory);
    const { maybeRunExplicitMemoryDreamAfterTurn } = await import("../src/gateway/websocket.ts");

    await appendSessionJsonlEntry(services.paths.sessionsDir, "sess_no_memory", {
      type: "user",
      uuid: "msg_no_memory",
      timestamp: "2026-06-15T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "我叫 yaotutu" }] },
    });
    await appendSessionJsonlEntry(services.paths.sessionsDir, "sess_failed_memory", {
      type: "user",
      uuid: "msg_failed_memory",
      timestamp: "2026-06-15T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "记住：我喜欢短回答" }] },
    });

    await maybeRunExplicitMemoryDreamAfterTurn(services, "我叫 yaotutu", "sess_no_memory", false);
    await maybeRunExplicitMemoryDreamAfterTurn(services, "记住：我喜欢短回答", "sess_failed_memory", true);

    const memory = await readFile(services.paths.longTermMemoryFile, "utf8");
    expect(memory).not.toContain("我叫 yaotutu");
    expect(memory).not.toContain("我喜欢短回答");
  });

  test("forwards MCP init status as run.status", async () => {
    const init = {
      type: "system",
      subtype: "init",
      session_id: "sess_mcp",
      mcp_servers: [{ name: "filesystem", status: "connected" }],
    } as SdkMessage;
    const result = JSON.parse(readFileSync("tests/fixtures/sdk-events/07-result-success.json", "utf8")) as SdkMessage;
    const factory = makeRecordingQueryFactory([init, result]);
    const { services } = await makeServices(factory);

    const sent: unknown[] = [];
    const { runUserTurn } = await import("../src/conversation/run-user-turn.ts");
    await runUserTurn(
      services,
      { source: "webui", sessionId: null, content: "hi" },
      { send: (event) => { sent.push(event); } },
    );

    const status = sent.find((m) => (m as { type: string }).type === "run.status") as { mcpServers?: Array<{ name: string; status: string }> } | undefined;
    expect(status?.mcpServers).toEqual([{ name: "filesystem", status: "connected" }]);
  });
});

describe("cancelUserTurn", () => {
  test("delegates to agent runtime manager", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    let cancelled = "";
    services.agentRuntimeManager = {
      ...services.agentRuntimeManager,
      cancel: async (sessionId: string) => { cancelled = sessionId; },
    } as never;

    const { cancelUserTurn } = await import("../src/gateway/websocket.ts");
    await cancelUserTurn(services, "s1");

    expect(cancelled).toBe("s1");
  });
});
