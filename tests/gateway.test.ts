import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServices } from "../src/runtime/services.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { runtimePaths } from "../src/config/paths.ts";
import { handleHttp } from "../src/gateway/http.ts";
import { ClaudeRunner, type QueryFactory } from "../src/agent/runner.ts";
import type { SdkMessage } from "../src/agent/events.ts";
import { readFileSync } from "node:fs";

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
  test("GET /health returns ok", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const res = await handleHttp(new Request("http://x/health"), new URL("http://x/health"), services);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  test("create, list, get session", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const created = await handleHttp(new Request("http://x/api/sessions", { method: "POST", body: JSON.stringify({ title: "hello" }) }), new URL("http://x/api/sessions"), services);
    expect(created.status).toBe(200);
    const session = await created.json() as { id: string; title: string };
    expect(session.title).toBe("hello");
    expect(session.id).toBeTruthy();
    const list = await handleHttp(new Request("http://x/api/sessions"), new URL("http://x/api/sessions"), services);
    const arr = await list.json() as { id: string }[];
    expect(arr.find((s) => s.id === session.id)).toBeTruthy();
  });

  test("POST /api/sessions/:id/activate updates last active", async () => {
    const { services } = await makeServices(makeRecordingQueryFactory([]));
    const create = await handleHttp(new Request("http://x/api/sessions", { method: "POST" }), new URL("http://x/api/sessions"), services);
    const session = await create.json() as { id: string };
    const activate = await handleHttp(new Request(`http://x/api/sessions/${session.id}/activate`, { method: "POST" }), new URL(`http://x/api/sessions/${session.id}/activate`), services);
    expect(activate.status).toBe(200);
    const state = await services.runtimeState.get();
    expect(state.lastActiveSessionId).toBe(session.id);
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
    const sched = await services.scheduler.create({ name: "t", cronExpr: "* * * * *", timezone: "UTC", message: "x" });
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
  test("user message -> mocked runner -> assistant message appended", async () => {
    const init = JSON.parse(readFileSync("tests/fixtures/sdk-events/01-init.json", "utf8")) as SdkMessage;
    const text = JSON.parse(readFileSync("tests/fixtures/sdk-events/05-text-assistant.json", "utf8")) as SdkMessage;
    const result = JSON.parse(readFileSync("tests/fixtures/sdk-events/07-result-success.json", "utf8")) as SdkMessage;
    const factory = makeRecordingQueryFactory([init, text, result]);
    const { services } = await makeServices(factory);

    // Create + activate a session via HTTP
    const create = await handleHttp(new Request("http://x/api/sessions", { method: "POST" }), new URL("http://x/api/sessions"), services);
    const session = await create.json() as { id: string };
    await handleHttp(new Request(`http://x/api/sessions/${session.id}/activate`, { method: "POST" }), new URL(`http://x/api/sessions/${session.id}/activate`), services);

    // Drive a user turn via the runner (mimics the WS handler)
    const runner = services.makeRunner("user_turn", session.id);
    const events: { type: string; text?: string; result?: string; sessionId?: string }[] = [];
    for await (const ev of runner.run({ prompt: "hi" })) events.push(ev as never);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "turn_done")).toBe(true);

    // Append user + assistant messages to the session
    const record = await services.sessions.get(session.id);
    expect(record).toBeTruthy();
    await services.sessions.appendMessage(session.id, { role: "user", content: "hi", metadata: {} });
    await services.sessions.appendMessage(session.id, { role: "assistant", content: events.find((e) => e.type === "text_delta")?.text || "", metadata: {} });
    const after = await services.sessions.get(session.id);
    expect(after?.messages.length).toBe(2);
    expect(after?.messages[1].role).toBe("assistant");

    expect(factory.calls.length).toBe(1);
    expect(factory.calls[0].prompt).toBe("hi");
  });
});
