// Schedule trigger — execution layer (runNow, tick).
// Depends on SchedulerStore + executor callback.
// Created after queryFactory is available, breaking the circular dependency.

import { newId } from "../utils/id.ts";
import { computeNextRunAt } from "./store-ops.ts";
import type { SchedulerStore } from "./store.ts";
import type { ScheduleRecord, ScheduleRunRecord } from "./types.ts";

export type ScheduleExecutor = (schedule: ScheduleRecord, run: ScheduleRunRecord) => Promise<string>;

function now(): string {
  return new Date().toISOString();
}

async function runSchedule(
  schedule: ScheduleRecord,
  schedules: ScheduleRecord[],
  store: SchedulerStore,
  executor: ScheduleExecutor,
): Promise<ScheduleRunRecord> {
  const start = now();
  const run: ScheduleRunRecord = {
    id: newId("run"),
    scheduleId: schedule.id,
    startedAt: start,
    finishedAt: null,
    status: "running",
    result: "",
    error: "",
  };

  if (schedule.state.running) {
    run.status = "skipped_running";
    run.finishedAt = now();
    await store.appendRun(run);
    return run;
  }

  schedule.state.running = true;
  await store.saveSchedules(schedules);
  await store.appendRun(run);
  try {
    run.result = await executor(schedule, run);
    run.status = "succeeded";
    schedule.state.lastStatus = "succeeded";
    schedule.state.lastError = null;
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    run.status = "failed";
    schedule.state.lastStatus = "failed";
    schedule.state.lastError = run.error;
  } finally {
    run.finishedAt = now();
    schedule.state.running = false;
    schedule.state.lastRunAt = start;
    schedule.state.runCount += 1;
    schedule.state.nextRunAt = computeNextRunAt(schedule.cronExpr, schedule.timezone);
    schedule.updatedAt = now();
    await store.saveSchedules(schedules);
    await store.updateRun(run);
  }
  return run;
}

export function createSchedulerTrigger(store: SchedulerStore, executor: ScheduleExecutor) {
  return {
    async runNow(id: string): Promise<ScheduleRunRecord> {
      const schedules = await store.listSchedules();
      const schedule = schedules.find((item) => item.id === id);
      if (!schedule) throw new Error(`schedule not found: ${id}`);
      return runSchedule(schedule, schedules, store, executor);
    },

    async tick(at: Date = new Date()): Promise<ScheduleRunRecord[]> {
      const schedules = await store.listSchedules();
      const due = schedules.filter((s) => s.enabled && new Date(s.state.nextRunAt).getTime() <= at.getTime());
      const runs: ScheduleRunRecord[] = [];
      for (const schedule of due) {
        runs.push(await runSchedule(schedule, schedules, store, executor));
      }
      return runs;
    },
  };
}

export type SchedulerTrigger = ReturnType<typeof createSchedulerTrigger>;
