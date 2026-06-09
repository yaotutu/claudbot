import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerStore } from "../src/scheduler/store.ts";
import { SchedulerService } from "../src/scheduler/service.ts";

describe("scheduler", () => {
  test("creates schedule with next run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const service = new SchedulerService(store, async () => "ok");
    const schedule = await service.create({
      name: "test",
      cronExpr: "* * * * *",
      timezone: "UTC",
      message: "run",
    });
    expect(schedule.id.startsWith("sch_")).toBe(true);
    expect(schedule.state.nextRunAt).toBeTruthy();
  });

  test("run now records result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const service = new SchedulerService(store, async () => "done");
    const schedule = await service.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    const run = await service.runNow(schedule.id);
    expect(run.status).toBe("succeeded");
    expect(run.result).toBe("done");
  });

  test("run now skips when schedule is already running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const service = new SchedulerService(store, async () => "ok");
    const schedule = await service.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    // Simulate a stuck prior run: flip state.running to true and persist.
    const schedules = await store.listSchedules();
    const target = schedules.find((s) => s.id === schedule.id)!;
    target.state.running = true;
    await store.saveSchedules(schedules);
    const run = await service.runNow(schedule.id);
    expect(run.status).toBe("skipped_running");
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("skipped_running");
  });

  test("executor failure is persisted without retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const service = new SchedulerService(store, async () => { throw new Error("boom"); });
    const schedule = await service.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    const run = await service.runNow(schedule.id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("boom");
    const schedules = await store.listSchedules();
    const target = schedules.find((s) => s.id === schedule.id)!;
    expect(target.state.lastStatus).toBe("failed");
    expect(target.state.lastError).toBe("boom");
    expect(target.state.runCount).toBe(1);
  });

  test("invalid cron is rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const service = new SchedulerService(store, async () => "x");
    await expect(
      service.create({ name: "bad", cronExpr: "not a cron", timezone: "UTC", message: "x" })
    ).rejects.toThrow();
  });

  test("due tick runs due schedules and advances nextRunAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-scheduler-"));
    const store = new SchedulerStore(join(dir, "schedules.json"), join(dir, "runs.json"));
    const calls: string[] = [];
    const service = new SchedulerService(store, async (sched) => { calls.push(sched.id); return "ok"; });
    const schedule = await service.create({ name: "test", cronExpr: "* * * * *", timezone: "UTC", message: "run" });
    // Force nextRunAt to the past
    const schedules = await store.listSchedules();
    const target = schedules.find((s) => s.id === schedule.id)!;
    const past = new Date(Date.now() - 60_000).toISOString();
    target.state.nextRunAt = past;
    await store.saveSchedules(schedules);
    await service.tick(new Date());
    expect(calls).toContain(schedule.id);
    const after = (await store.listSchedules()).find((s) => s.id === schedule.id)!;
    expect(after.state.nextRunAt).not.toBe(past);
    expect(new Date(after.state.nextRunAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(after.state.runCount).toBe(1);
  });
});
