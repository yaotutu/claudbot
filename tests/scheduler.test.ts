import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerStore } from "../src/scheduler/store.ts";
import { createStoreOps } from "../src/scheduler/store-ops.ts";
import { createSchedulerTrigger } from "../src/scheduler/trigger.ts";
import { buildServices } from "../src/runtime/services.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { runtimePaths } from "../src/config/paths.ts";
import type { SdkMessage } from "../src/agent/events.ts";
import type { QueryFactory } from "../src/agent/runner.ts";
import { createSdkJsonlSessionStore } from "../src/sessions/sdk-jsonl-store.ts";

function makeRecordingQueryFactory(events: SdkMessage[]): QueryFactory & { calls: Array<{ prompt: string; resumeSessionId?: string }> } {
  const calls: Array<{ prompt: string; resumeSessionId?: string }> = [] as never;
  const factory: QueryFactory = async function* (args) {
    (calls as Array<{ prompt: string; resumeSessionId?: string }>).push({ prompt: args.prompt, resumeSessionId: args.resumeSessionId });
    for (const e of events) yield e;
  };
  return Object.assign(factory, { calls: calls as Array<{ prompt: string; resumeSessionId?: string }> });
}

describe("scheduler store-ops (CRUD)", () => {
  test("creates cron schedule with next run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const schedule = await storeOps.create({
      name: "test",
      cronExpr: "* * * * *",
      timezone: "UTC",
      message: "run",
    });
    expect(schedule.id.startsWith("sch_")).toBe(true);
    expect(schedule.kind).toBe("cron");
    expect(schedule.deleteAfterRun).toBe(false);
    expect(schedule.state.nextRunAt).toBeTruthy();
    expect(schedule.state.runningStartedAt).toBeNull();
    expect(schedule.state.lastSkippedReason).toBeNull();
  });

  test("creates 'at' one-shot schedule", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const at = new Date(Date.now() + 60_000).toISOString();
    const schedule = await storeOps.create({
      name: "reminder",
      at,
      message: "drink water",
    });
    expect(schedule.kind).toBe("at");
    expect(schedule.at).toBe(at);
    expect(schedule.deleteAfterRun).toBe(true);
    expect(schedule.state.nextRunAt).toBe(at);
  });

  test("creates 'every' recurring schedule", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const schedule = await storeOps.create({
      name: "check",
      everyMs: 300000,
      message: "check status",
    });
    expect(schedule.kind).toBe("every");
    expect(schedule.everyMs).toBe(300000);
    expect(schedule.deleteAfterRun).toBe(false);
    // nextRunAt should be ~5 minutes from now
    const diff = new Date(schedule.state.nextRunAt).getTime() - Date.now();
    expect(diff).toBeGreaterThan(250_000);
    expect(diff).toBeLessThan(350_000);
  });

  test("invalid cron is rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    await expect(
      storeOps.create({ name: "bad", cronExpr: "not a cron", timezone: "UTC", message: "x" })
    ).rejects.toThrow();
  });

  test("no schedule type provided throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    await expect(
      storeOps.create({ name: "empty", message: "x" })
    ).rejects.toThrow("Must provide one of");
  });
});

describe("scheduler trigger (execution)", () => {
  test("run now records result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "done");
    const schedule = await storeOps.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    const run = await trigger.runNow(schedule.id);
    expect(run.status).toBe("succeeded");
    expect(run.result).toBe("done");
  });

  test("stores each run as a separate JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const runsDir = join(dir, "runs");
    const store = new SchedulerStore(join(dir, "jobs.json"), runsDir);
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "done");
    const schedule = await storeOps.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });

    const run = await trigger.runNow(schedule.id);
    const raw = await readFile(join(runsDir, `${run.id}.json`), "utf8");
    const saved = JSON.parse(raw) as { id: string; scheduleId: string; status: string; result: string };

    expect(saved.id).toBe(run.id);
    expect(saved.scheduleId).toBe(schedule.id);
    expect(saved.status).toBe("succeeded");
    expect(saved.result).toBe("done");
    expect(await store.listRuns()).toEqual([run]);
  });

  test("run now skips when schedule is already running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "ok");
    const schedule = await storeOps.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    // Simulate a stuck prior run: flip state.running to true and persist.
    const schedules = await store.listSchedules();
    const target = schedules.find((s) => s.id === schedule.id)!;
    target.state.running = true;
    target.state.runningStartedAt = new Date().toISOString();
    await store.saveSchedules(schedules);
    const run = await trigger.runNow(schedule.id);
    expect(run.status).toBe("skipped_running");
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("skipped_running");
    const after = (await store.listSchedules()).find((s) => s.id === schedule.id)!;
    expect(after.state.lastSkippedReason).toBe("already running");
  });

  test("run now clears stale running marker and executes schedule", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    let calls = 0;
    const trigger = createSchedulerTrigger(store, async () => { calls++; return "recovered"; });
    const schedule = await storeOps.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    const schedules = await store.listSchedules();
    const target = schedules.find((s) => s.id === schedule.id)!;
    target.state.running = true;
    target.state.runningStartedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await store.saveSchedules(schedules);

    const run = await trigger.runNow(schedule.id);

    expect(run.status).toBe("succeeded");
    expect(run.result).toBe("recovered");
    expect(calls).toBe(1);
    const after = (await store.listSchedules()).find((s) => s.id === schedule.id)!;
    expect(after.state.running).toBe(false);
    expect(after.state.runningStartedAt).toBeNull();
    expect(after.state.lastSkippedReason).toBeNull();
  });

  test("tick skips re-entry while a previous tick is still running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const trigger = createSchedulerTrigger(store, async () => {
      calls++;
      await blocker;
      return "ok";
    });
    const schedule = await storeOps.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    const schedules = await store.listSchedules();
    schedules[0].state.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveSchedules(schedules);

    const firstTick = trigger.tick(new Date());
    await new Promise((r) => setTimeout(r, 10));
    const secondTick = await trigger.tick(new Date());
    release();
    await firstTick;

    expect(secondTick).toEqual([]);
    expect(calls).toBe(1);
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].scheduleId).toBe(schedule.id);
  });

  test("executor failure is persisted without retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => { throw new Error("boom"); });
    const schedule = await storeOps.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    const run = await trigger.runNow(schedule.id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("boom");
    const schedules = await store.listSchedules();
    const target = schedules.find((s) => s.id === schedule.id)!;
    expect(target.state.lastStatus).toBe("failed");
    expect(target.state.lastError).toBe("boom");
    expect(target.state.runCount).toBe(1);
    expect(target.state.runningStartedAt).toBeNull();
  });

  test("due tick runs due schedules and advances nextRunAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const calls: string[] = [];
    const trigger = createSchedulerTrigger(store, async (sched) => { calls.push(sched.id); return "ok"; });
    const schedule = await storeOps.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    // Force nextRunAt to the past
    const schedules = await store.listSchedules();
    const target = schedules.find((s) => s.id === schedule.id)!;
    const past = new Date(Date.now() - 60_000).toISOString();
    target.state.nextRunAt = past;
    await store.saveSchedules(schedules);
    await trigger.tick(new Date());
    expect(calls).toContain(schedule.id);
    const after = (await store.listSchedules()).find((s) => s.id === schedule.id)!;
    expect(after.state.nextRunAt).not.toBe(past);
    expect(new Date(after.state.nextRunAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(after.state.runCount).toBe(1);
  });

  test("tick executes multiple due schedules in parallel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const executionOrder: string[] = [];
    const trigger = createSchedulerTrigger(store, async (sched) => {
      executionOrder.push(`start:${sched.id}`);
      // Simulate work — schedule A takes longer than schedule B
      await new Promise((r) => setTimeout(r, sched.name === "slow" ? 100 : 10));
      executionOrder.push(`end:${sched.id}`);
      return "ok";
    });
    // Create two schedules
    const schedA = await storeOps.create({ name: "slow", cronExpr: "* * * * *", timezone: "UTC", message: "a" });
    const schedB = await storeOps.create({ name: "fast", cronExpr: "* * * * *", timezone: "UTC", message: "b" });
    // Force both to be due
    const schedules = await store.listSchedules();
    const past = new Date(Date.now() - 60_000).toISOString();
    for (const s of schedules) s.state.nextRunAt = past;
    await store.saveSchedules(schedules);

    await trigger.tick(new Date());
    // Both should have completed
    expect(executionOrder).toContain(`start:${schedA.id}`);
    expect(executionOrder).toContain(`start:${schedB.id}`);
    expect(executionOrder).toContain(`end:${schedA.id}`);
    expect(executionOrder).toContain(`end:${schedB.id}`);
    // B (fast) should finish before A (slow) — evidence of parallel execution
    const endB = executionOrder.indexOf(`end:${schedB.id}`);
    const endA = executionOrder.indexOf(`end:${schedA.id}`);
    expect(endB).toBeLessThan(endA);
  });

  test("'at' schedule is deleted after execution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "done");

    const past = new Date(Date.now() - 60_000).toISOString();
    const schedule = await storeOps.create({ name: "one-shot", at: past, message: "remind me" });
    expect(schedule.kind).toBe("at");
    expect(schedule.deleteAfterRun).toBe(true);

    // Force it due
    const schedules = await store.listSchedules();
    schedules[0].state.nextRunAt = past;
    await store.saveSchedules(schedules);

    await trigger.tick(new Date());

    // Schedule should be gone
    const remaining = await store.listSchedules();
    expect(remaining.find((s) => s.id === schedule.id)).toBeUndefined();

    // Run record should exist
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].result).toBe("done");
  });
});

describe("scheduler trigger (start/stop)", () => {
  test("start triggers periodic ticks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    let tickCount = 0;
    const trigger = createSchedulerTrigger(store, async () => { tickCount++; return "ok"; });
    // Create a schedule that's due now
    const schedule = await storeOps.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    const schedules = await store.listSchedules();
    schedules[0].state.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveSchedules(schedules);

    trigger.start(200); // 200ms interval for fast test
    await new Promise((r) => setTimeout(r, 500));
    trigger.stop();
    expect(tickCount).toBeGreaterThan(0);
  });

  test("stop prevents further ticks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    let tickCount = 0;
    const trigger = createSchedulerTrigger(store, async () => { tickCount++; return "ok"; });
    trigger.start(100);
    await new Promise((r) => setTimeout(r, 250));
    trigger.stop();
    const countAfterStop = tickCount;
    await new Promise((r) => setTimeout(r, 300));
    expect(tickCount).toBe(countAfterStop);
  });

  test("tick error does not break the loop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "jobs.json"), join(dir, "runs"));
    const storeOps = createStoreOps(store);
    let callCount = 0;
    const trigger = createSchedulerTrigger(store, async () => {
      callCount++;
      if (callCount === 1) throw new Error("transient");
      return "ok";
    });
    const schedule = await storeOps.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    // Force schedule due, and keep it due after each run by resetting nextRunAt
    const forceDue = async () => {
      const schedules = await store.listSchedules();
      const s = schedules.find((x) => x.id === schedule.id);
      if (s) { s.state.nextRunAt = new Date(Date.now() - 60_000).toISOString(); await store.saveSchedules(schedules); }
    };
    await forceDue();

    trigger.start(150);
    // After first tick (which fails), reset nextRunAt so next tick finds it due again
    await new Promise((r) => setTimeout(r, 200));
    await forceDue();
    await new Promise((r) => setTimeout(r, 300));
    trigger.stop();
    // First executor call threw, but the loop continued and second call succeeded
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// These exercise the real `runScheduledTurn` wired into the service container.
describe("runScheduledTurn (wired into services)", () => {
  test("creates new session (no resumeSessionId) and calls notifier", async () => {
    const init = { type: "system", subtype: "init", session_id: "sched-new-1" } as SdkMessage;
    const result = { type: "result", session_id: "sched-new-1", result: "hello from schedule", is_error: false } as SdkMessage;
    const factory = makeRecordingQueryFactory([init, result]);

    const dir = await mkdtemp(join(tmpdir(), "claudebot-sched-rt-"));
    const config = resolveRuntimeConfig({ home: dir }, {});
    const paths = runtimePaths(config);
    const services = await buildServices({ config, paths, queryFactory: factory });

    // Track notifier calls
    const delivered: Array<Record<string, unknown>> = [];
    services.notifier.deliver = async (payload) => { delivered.push(payload as Record<string, unknown>); };

    const sched = await services.storeOps.create({ name: "greeting", cronExpr: "* * * * *", timezone: "UTC", message: "say hello" });
    const run = await services.trigger.runNow(sched.id);

    expect(run.status).toBe("succeeded");
    expect(run.result).toBe("hello from schedule");
    // Should NOT pass resumeSessionId — one-off session
    expect(factory.calls.length).toBe(1);
    expect(factory.calls[0].resumeSessionId).toBeUndefined();
    // Prompt should contain schedule name and message
    expect(factory.calls[0].prompt).toContain("greeting");
    expect(factory.calls[0].prompt).toContain("say hello");
    // Notifier should have been called
    expect(delivered.length).toBe(1);
    expect(delivered[0].scheduleId).toBe(sched.id);
    expect(delivered[0].scheduleName).toBe("greeting");
    expect(delivered[0].status).toBe("succeeded");
    expect(delivered[0].result).toBe("hello from schedule");
  });

  test("always executes even without an active session", async () => {
    const init = { type: "system", subtype: "init", session_id: "sched-fresh" } as SdkMessage;
    const result = { type: "result", session_id: "sched-fresh", result: "done", is_error: false } as SdkMessage;
    const factory = makeRecordingQueryFactory([init, result]);

    const dir = await mkdtemp(join(tmpdir(), "claudebot-sched-rt-"));
    const config = resolveRuntimeConfig({ home: dir }, {});
    const paths = runtimePaths(config);
    const services = await buildServices({ config, paths, queryFactory: factory });
    // No lastActiveSessionId set

    const sched = await services.storeOps.create({ name: "t", cronExpr: "* * * * *", timezone: "UTC", message: "tick" });
    const run = await services.trigger.runNow(sched.id);

    // Should still execute (not skip)
    expect(run.status).toBe("succeeded");
    expect(run.result).toBe("done");
    expect(factory.calls.length).toBe(1);
  });

  test("notifies failed scheduled turns before persisting the failed run", async () => {
    const failingFactory: QueryFactory = async function* () {
      throw new Error("Claude turn failed");
    };

    const dir = await mkdtemp(join(tmpdir(), "claudebot-sched-rt-"));
    const config = resolveRuntimeConfig({ home: dir }, {});
    const paths = runtimePaths(config);
    const services = await buildServices({ config, paths, queryFactory: failingFactory });
    const delivered: Array<Record<string, unknown>> = [];
    services.notifier.deliver = async (payload) => { delivered.push(payload as Record<string, unknown>); };

    const sched = await services.storeOps.create({ name: "broken", cronExpr: "* * * * *", timezone: "UTC", message: "fail" });
    const run = await services.trigger.runNow(sched.id);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Claude turn failed");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      scheduleId: sched.id,
      scheduleName: "broken",
      runId: run.id,
      status: "failed",
      result: "Claude turn failed",
    });
  });
});

describe("schedule notification delivery", () => {
  test("delivers scheduled results to WebUI notifications without appending to any session", async () => {
    const { deliverScheduleResultToNotification } = await import("../src/scheduler/notify.ts");
    const { parseJsonlToUIMessages } = await import("../src/sessions/jsonl-parser.ts");

    const dir = await mkdtemp(join(tmpdir(), "claudebot-sched-deliver-"));
    const config = resolveRuntimeConfig({ home: dir }, {});
    const paths = runtimePaths(config);
    const services = await buildServices({ config, paths, queryFactory: makeRecordingQueryFactory([]) });
    const store = createSdkJsonlSessionStore({ sessionsDir: paths.sessionsDir });
    await store.append({ projectKey: "claudebot", sessionId: "active-session" }, [
      { type: "user", uuid: "u1", timestamp: "2026-06-11T00:00:00.000Z", message: { role: "user", content: "hello" } },
    ]);
    await services.runtimeState.setLastActiveSession("active-session", "user_open");
    const broadcasted: unknown[] = [];

    const notification = await deliverScheduleResultToNotification(services, {
      scheduleId: "sch_inbox",
      scheduleName: "inbox task",
      status: "succeeded",
      result: "inbox result",
      runId: "run_inbox",
    }, (message) => broadcasted.push(message));

    expect(notification).toMatchObject({
      source: "schedule",
      title: "定时任务 inbox task",
      content: "inbox result",
      status: "succeeded",
      scheduleId: "sch_inbox",
      runId: "run_inbox",
      delivery: { type: "webui_inbox", scope: "global" },
      readAt: null,
    });
    expect((await services.runtimeState.get()).lastActiveSessionId).toBe("active-session");
    expect(broadcasted).toHaveLength(2);
    expect(broadcasted[0]).toMatchObject({ type: "notification.created", notification: { scheduleId: "sch_inbox", runId: "run_inbox" } });
    expect(broadcasted[1]).toMatchObject({ type: "schedule.run.completed", scheduleId: "sch_inbox", runId: "run_inbox", status: "succeeded" });
    const stored = await services.notificationStore.list();
    expect(stored.at(-1)).toMatchObject({ id: notification.id, content: "inbox result" });
    const activeMessages = await parseJsonlToUIMessages(join(paths.sessionsDir, "active-session", "main.jsonl"));
    expect(activeMessages).toHaveLength(1);
  });

  test("does not deliver scheduled results to existing chat sessions", async () => {
    const { deliverScheduleResultToNotification } = await import("../src/scheduler/notify.ts");
    const { parseJsonlToUIMessages } = await import("../src/sessions/jsonl-parser.ts");

    const dir = await mkdtemp(join(tmpdir(), "claudebot-sched-deliver-"));
    const config = resolveRuntimeConfig({ home: dir }, {});
    const paths = runtimePaths(config);
    const services = await buildServices({ config, paths, queryFactory: makeRecordingQueryFactory([]) });
    const store = createSdkJsonlSessionStore({ sessionsDir: paths.sessionsDir });
    await store.append({ projectKey: "claudebot", sessionId: "older-session" }, [
      { type: "user", uuid: "u1", timestamp: "2026-06-11T00:00:00.000Z", message: { role: "user", content: "older" } },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.append({ projectKey: "claudebot", sessionId: "latest-session" }, [
      { type: "user", uuid: "u2", timestamp: "2026-06-11T00:01:00.000Z", message: { role: "user", content: "latest" } },
    ]);
    const broadcasted: unknown[] = [];

    await deliverScheduleResultToNotification(services, {
      scheduleId: "sch_recreated",
      scheduleName: "recreated task",
      status: "succeeded",
      result: "recreated inbox result",
      runId: "run_recreated",
    }, (message) => broadcasted.push(message));

    expect(broadcasted[0]).toMatchObject({ type: "notification.created", notification: { scheduleId: "sch_recreated", runId: "run_recreated" } });
    expect(broadcasted[1]).toMatchObject({ type: "schedule.run.completed", scheduleId: "sch_recreated", runId: "run_recreated", status: "succeeded" });
    const latestMessages = await parseJsonlToUIMessages(join(paths.sessionsDir, "latest-session", "main.jsonl"));
    const olderMessages = await parseJsonlToUIMessages(join(paths.sessionsDir, "older-session", "main.jsonl"));
    expect(latestMessages).toHaveLength(1);
    expect(olderMessages).toHaveLength(1);
  });
});
