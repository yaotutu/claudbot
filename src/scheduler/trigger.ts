// Schedule trigger — execution layer + cron loop.
// Owns the timer that periodically scans for due schedules and executes them in parallel.
// Created after queryFactory is available, breaking the circular dependency.

import { newId } from "../utils/id.ts";
import { computeNextRunAtFromKind } from "./store-ops.ts";
import type { SchedulerStore } from "./store.ts";
import type { ScheduleRecord, ScheduleRunRecord } from "./types.ts";

export type ScheduleExecutor = (schedule: ScheduleRecord, run: ScheduleRunRecord) => Promise<string>;

function now(): string {
  return new Date().toISOString();
}

/**
 * Execute a single schedule independently.
 * Reads the store fresh, updates only its own schedule record, writes back.
 * Safe to call in parallel for different schedules.
 */
async function runSchedule(
  scheduleId: string,
  store: SchedulerStore,
  executor: ScheduleExecutor,
): Promise<ScheduleRunRecord> {
  const start = now();
  const run: ScheduleRunRecord = {
    id: newId("run"),
    scheduleId,
    startedAt: start,
    finishedAt: null,
    status: "running",
    result: "",
    error: "",
  };

  // Read fresh from store
  const schedules = await store.listSchedules();
  const schedule = schedules.find((s) => s.id === scheduleId);
  if (!schedule) {
    run.status = "failed";
    run.error = `schedule not found: ${scheduleId}`;
    run.finishedAt = now();
    await store.appendRun(run);
    return run;
  }

  if (schedule.state.running) {
    run.status = "skipped_running";
    run.finishedAt = now();
    await store.appendRun(run);
    return run;
  }

  // Lock
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
    schedule.updatedAt = now();

    if (schedule.deleteAfterRun) {
      // One-shot schedule: remove after execution
      const remaining = schedules.filter((s) => s.id !== scheduleId);
      await store.saveSchedules(remaining);
    } else {
      schedule.state.nextRunAt = computeNextRunAtFromKind(schedule);
      await store.saveSchedules(schedules);
    }
    await store.updateRun(run);
  }
  return run;
}

export function createSchedulerTrigger(store: SchedulerStore, executor: ScheduleExecutor) {
  let intervalId: ReturnType<typeof setInterval> | undefined;

  return {
    /** Run a specific schedule by id immediately. */
    async runNow(id: string): Promise<ScheduleRunRecord> {
      return runSchedule(id, store, executor);
    },

    /** Scan for all due schedules and execute them in parallel. */
    async tick(at: Date = new Date()): Promise<ScheduleRunRecord[]> {
      const schedules = await store.listSchedules();
      const due = schedules.filter(
        (s) => s.enabled && new Date(s.state.nextRunAt).getTime() <= at.getTime(),
      );
      if (due.length === 0) return [];

      const results = await Promise.allSettled(
        due.map((s) => runSchedule(s.id, store, executor)),
      );
      return results
        .filter((r): r is PromiseFulfilledResult<ScheduleRunRecord> => r.status === "fulfilled")
        .map((r) => r.value);
    },

    /** Start the cron loop. Periodically calls tick(). */
    start(intervalMs = 30_000): void {
      if (intervalId !== undefined) return; // already running
      intervalId = setInterval(async () => {
        try {
          await this.tick();
        } catch (err) {
          console.error("[scheduler] tick error:", err instanceof Error ? err.message : err);
        }
      }, intervalMs);
    },

    /** Stop the cron loop. */
    stop(): void {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    },
  };
}

export type SchedulerTrigger = ReturnType<typeof createSchedulerTrigger>;
