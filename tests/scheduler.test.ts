import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
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

describe("scheduler store-ops (CRUD)", () => {
  test("creates schedule with next run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const storeOps = createStoreOps(store);
    const schedule = await storeOps.create({
      name: "test",
      cronExpr: "* * * * *",
      timezone: "UTC",
      message: "run",
    });
    expect(schedule.id.startsWith("sch_")).toBe(true);
    expect(schedule.state.nextRunAt).toBeTruthy();
  });

  test("invalid cron is rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const storeOps = createStoreOps(store);
    await expect(
      storeOps.create({ name: "bad", cronExpr: "not a cron", timezone: "UTC", message: "x" })
    ).rejects.toThrow();
  });
});

describe("scheduler trigger (execution)", () => {
  test("run now records result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "done");
    const schedule = await storeOps.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    const run = await trigger.runNow(schedule.id);
    expect(run.status).toBe("succeeded");
    expect(run.result).toBe("done");
  });

  test("run now skips when schedule is already running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const storeOps = createStoreOps(store);
    const trigger = createSchedulerTrigger(store, async () => "ok");
    const schedule = await storeOps.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    // Simulate a stuck prior run: flip state.running to true and persist.
    const schedules = await store.listSchedules();
    const target = schedules.find((s) => s.id === schedule.id)!;
    target.state.running = true;
    await store.saveSchedules(schedules);
    const run = await trigger.runNow(schedule.id);
    expect(run.status).toBe("skipped_running");
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("skipped_running");
  });

  test("executor failure is persisted without retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
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
  });

  test("due tick runs due schedules and advances nextRunAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
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
});

// These exercise the real `runScheduledTurn` wired into the service container.
// We use a recording QueryFactory so we can assert the runner was actually dispatched.
describe("runScheduledTurn (wired into services)", () => {
  function makeRecordingQueryFactory(events: SdkMessage[]): QueryFactory & { calls: Array<{ prompt: string; resumeSessionId?: string }> } {
    const calls: Array<{ prompt: string; resumeSessionId?: string }> = [] as never;
    const factory: QueryFactory = async function* (args) {
      (calls as Array<{ prompt: string; resumeSessionId?: string }>).push({ prompt: args.prompt, resumeSessionId: args.resumeSessionId });
      for (const e of events) yield e;
    };
    return Object.assign(factory, { calls: calls as Array<{ prompt: string; resumeSessionId?: string }> });
  }

  test("dispatches runner.run when there is an active session", async () => {
    const init = { type: "system", subtype: "init", session_id: "sess-1" } as SdkMessage;
    const result = { type: "result", session_id: "sess-1", result: "scheduled output", is_error: false } as SdkMessage;
    const factory = makeRecordingQueryFactory([init, result]);

    const dir = await mkdtemp(join(tmpdir(), "claudebot-sched-rt-"));
    const config = resolveRuntimeConfig({ home: dir }, {});
    const paths = runtimePaths(config);
    const services = await buildServices({ config, paths, queryFactory: factory });

    // Seed the active session so runScheduledTurn has a target.
    await services.runtimeState.setLastActiveSession("sess-1", "user_open");

    const sched = await services.storeOps.create({ name: "t", cronExpr: "* * * * *", timezone: "UTC", message: "tick" });
    const run = await services.trigger.runNow(sched.id);

    expect(run.status).toBe("succeeded");
    expect(run.result).toBe("scheduled output");
    // The runner was invoked once with a prompt tagged with the schedule id.
    expect(factory.calls.length).toBe(1);
    expect(factory.calls[0].prompt).toContain(sched.id);
    expect(factory.calls[0].prompt).toContain("tick");
  });

  test("skips when there is no active session", async () => {
    const factory = makeRecordingQueryFactory([]);

    const dir = await mkdtemp(join(tmpdir(), "claudebot-sched-rt-"));
    const config = resolveRuntimeConfig({ home: dir }, {});
    const paths = runtimePaths(config);
    const services = await buildServices({ config, paths, queryFactory: factory });

    // No lastActiveSessionId is set.
    const sched = await services.storeOps.create({ name: "t", cronExpr: "* * * * *", timezone: "UTC", message: "tick" });
    const run = await services.trigger.runNow(sched.id);

    expect(run.status).toBe("succeeded");
    expect(run.result).toContain("skipped: no active session");
    // The runner was NOT invoked — there's no target to resume.
    expect(factory.calls.length).toBe(0);
  });
});
