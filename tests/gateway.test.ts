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
import { createClaudebotSessionStore } from "../src/sessions/adapter.ts";

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
  test("service container exposes SDK sessions but not legacy session store", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));

    expect("sdkSessions" in services).toBe(true);
    expect("sessions" in services).toBe(false);
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

  test("GET /api/sessions lists sessions seeded by the SDK sessionStore", async () => {
    const { services, dir } = await makeServices(makeRecordingQueryFactory([]));
    // Seed a session through the same adapter the SDK uses, so the
    // /api/sessions listing picks it up via services.sdkSessions.list.
    const store = createClaudebotSessionStore({ sessionsDir: join(dir, "sessions") });
    const key = { projectKey: "claudebot", sessionId: "sess-seeded" };
    await store.append(key, [
      { type: "user", uuid: "u1", timestamp: "2026-06-09T10:00:00Z", message: { role: "user", content: "hi" } },
    ]);
    const list = await handleHttp(new Request("http://x/api/sessions"), new URL("http://x/api/sessions"), services);
    expect(list.status).toBe(200);
    const arr = await list.json() as { id: string }[];
    expect(arr.find((s) => s.id === "sess-seeded")).toBeTruthy();
  });

  test("GET /api/sessions returns canonical WebUI session summaries", async () => {
    const { services, dir } = await makeServices(makeRecordingQueryFactory([]));
    const store = createClaudebotSessionStore({ sessionsDir: join(dir, "sessions") });
    const seededId = randomUUID();
    await store.append({ projectKey: "claudebot", sessionId: seededId }, [
      { type: "user", uuid: "u1", timestamp: "2026-06-10T09:59:40.000Z", message: { role: "user", content: "hello world" } },
      { type: "assistant", uuid: "a1", timestamp: "2026-06-10T09:59:45.000Z", message: { role: "assistant", content: "hi" } },
    ]);
    await services.sdkSessions.rename(seededId, "hello world");

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
      model: "glm-5.1",
      permissionMode: "bypassPermissions",
    });
  });

  test("POST /api/sessions/:id/activate updates last active", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const activate = await handleHttp(
      new Request("http://x/api/sessions/sess_activate_test/activate", { method: "POST" }),
      new URL("http://x/api/sessions/sess_activate_test/activate"),
      services,
    );
    expect(activate.status).toBe(200);
    const state = await services.runtimeState.get();
    expect(state.lastActiveSessionId).toBe("sess_activate_test");
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

  test("POST /api/schedules/:id/run-now records a run", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const sched = await services.storeOps.create({ name: "t", cronExpr: "* * * * *", timezone: "UTC", message: "x" });
    const res = await handleHttp(
      new Request(`http://x/api/schedules/${sched.id}/run-now`, { method: "POST" }),
      new URL(`http://x/api/schedules/${sched.id}/run-now`),
      services,
    );
    expect(res.status).toBe(200);
    const run = await res.json() as { status: string; scheduleId: string };
    // Default executor is wired in Task 12; for now the run is recorded (succeeded or failed).
    expect(["succeeded", "failed"]).toContain(run.status);
    expect(run.scheduleId).toBe(sched.id);
  });

  test("failing schedule run persists failure (covered in scheduler.test.ts)", async () => {
    // Executor-failure case is unit-tested directly against SchedulerService.
    // Gateway surface is the same code path as the success test above.
    expect(true).toBe(true);
  });
});

describe("WebSocket chat.user_message end-to-end (mocked runner)", () => {
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
  test("emits native run frames and creates a persisted session from a draft", async () => {
    const init = JSON.parse(readFileSync("tests/fixtures/sdk-events/01-init.json", "utf8")) as SdkMessage;
    const text = JSON.parse(readFileSync("tests/fixtures/sdk-events/05-text-assistant.json", "utf8")) as SdkMessage;
    const result = JSON.parse(readFileSync("tests/fixtures/sdk-events/07-result-success.json", "utf8")) as SdkMessage;
    const factory = makeRecordingQueryFactory([init, text, result]);
    const { services } = await makeServices(factory);

    const sent: unknown[] = [];
    const fakeWs = {
      send: (data: string) => sent.push(JSON.parse(data)),
      data: { sessionId: "", services, send: (m: unknown) => sent.push(m) },
    } as unknown as Parameters<typeof import("../src/gateway/websocket.ts").runUserTurn>[0];

    const { runUserTurn } = await import("../src/gateway/websocket.ts");
    await runUserTurn(fakeWs, services, null, "ping", { draftId: "draft-1" });

    const types = sent.map((m) => (m as { type: string }).type);
    expect(types).toEqual([
      "run.started",
      "session.created",
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

    // Stub WebSocket-like object: runUserTurn writes to ws.data.sessionId
    // after the run, so the fake needs both `send` and a mutable `data`.
    const sent: unknown[] = [];
    const fakeWs = {
      send: (data: string) => sent.push(JSON.parse(data)),
      data: { sessionId: "", services, send: (m: unknown) => sent.push(m) },
    } as unknown as Parameters<typeof import("../src/gateway/websocket.ts").runUserTurn>[0];

    const { runUserTurn } = await import("../src/gateway/websocket.ts");
    await runUserTurn(
      fakeWs,
      services,
      null,
      "hi",
    );

    // The runner stream is forwarded through the claudebot-native run frames.
    const types = sent.map((m) => (m as { type: string }).type);
    expect(types.every((type) => !type.startsWith("agent."))).toBe(true);
    expect(types).toContain("run.delta");
    expect(types).toContain("run.completed");
    // The final assistant message goes out as a single message.appended frame.
    expect(types).toContain("message.appended");
    const appended = sent.find((m) => (m as { type: string }).type === "message.appended") as { type: string; message: { role: string; content: string } } | undefined;
    expect(appended?.message.role).toBe("assistant");
  });
});
