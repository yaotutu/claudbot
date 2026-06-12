// Schedule trigger — execution layer + cron loop.
// Owns the timer that periodically scans for due schedules and executes them in parallel.
// Created after queryFactory is available, breaking the circular dependency.

import { newId } from "../utils/id.ts";
import { computeNextRunAtFromKind } from "./store-ops.ts";
import type { SchedulerStore } from "./store.ts";
import type { ScheduleRecord, ScheduleRunRecord } from "./types.ts";

export type ScheduleExecutor = (schedule: ScheduleRecord, run: ScheduleRunRecord) => Promise<string>;
export type ScheduleRunStartResult = {
  started: boolean;
  runId: string;
  scheduleId: string;
  status: ScheduleRunRecord["status"];
};

const STALE_RUNNING_MS = 2 * 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

/**
 * Execute a single schedule independently.
 * Reads the store fresh, updates only its own schedule record, writes back.
 * Safe to call in parallel for different schedules.
 */
type StartedScheduleRun = {
  run: ScheduleRunRecord;
  completion?: Promise<ScheduleRunRecord>;
};

async function startScheduleRun(
  scheduleId: string,
  store: SchedulerStore,
  executor: ScheduleExecutor,
  activeRuns: Set<string>,
): Promise<StartedScheduleRun> {
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

  if (activeRuns.has(scheduleId)) {
    run.status = "skipped_running";
    run.finishedAt = now();
    await recordSkippedRun(store, scheduleId, run, "already running");
    return { run };
  }

  // Read fresh from store
  const schedules = await store.listSchedules();
  const schedule = schedules.find((s) => s.id === scheduleId);
  if (!schedule) {
    run.status = "failed";
    run.error = `schedule not found: ${scheduleId}`;
    run.finishedAt = now();
    await store.appendRun(run);
    return { run };
  }

  if (schedule.state.running && !isStaleRunning(schedule)) {
    run.status = "skipped_running";
    run.finishedAt = now();
    await recordSkippedRun(store, scheduleId, run, "already running");
    return { run };
  }

  if (schedule.state.running) {
    schedule.state.running = false;
    schedule.state.runningStartedAt = null;
    schedule.state.lastSkippedReason = "cleared stale running marker";
  }

  // Lock
  activeRuns.add(scheduleId);
  try {
    schedule.state.running = true;
    schedule.state.runningStartedAt = start;
    schedule.state.lastSkippedReason = null;
    await store.saveSchedules(schedules);
    await store.appendRun(run);

    return {
      run,
      completion: finishScheduleRun(scheduleId, start, schedule, schedules, run, store, executor, activeRuns),
    };
  } catch (error) {
    activeRuns.delete(scheduleId);
    throw error;
  }
}

async function finishScheduleRun(
  scheduleId: string,
  start: string,
  schedule: ScheduleRecord,
  schedules: ScheduleRecord[],
  run: ScheduleRunRecord,
  store: SchedulerStore,
  executor: ScheduleExecutor,
  activeRuns: Set<string>,
): Promise<ScheduleRunRecord> {
  try {
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
      schedule.state.runningStartedAt = null;
      schedule.state.lastRunAt = start;
      schedule.state.runCount += 1;
      schedule.state.lastSkippedReason = null;
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
  } finally {
    activeRuns.delete(scheduleId);
  }
}

async function runSchedule(
  scheduleId: string,
  store: SchedulerStore,
  executor: ScheduleExecutor,
  activeRuns: Set<string>,
): Promise<ScheduleRunRecord> {
  const started = await startScheduleRun(scheduleId, store, executor, activeRuns);
  return started.completion ? await started.completion : started.run;
}

async function recordSkippedRun(
  store: SchedulerStore,
  scheduleId: string,
  run: ScheduleRunRecord,
  reason: string,
): Promise<void> {
  const schedules = await store.listSchedules();
  const schedule = schedules.find((s) => s.id === scheduleId);
  if (schedule) {
    schedule.state.lastStatus = "skipped_running";
    schedule.state.lastSkippedReason = reason;
    schedule.updatedAt = now();
    await store.saveSchedules(schedules);
  }
  await store.appendRun(run);
}

function isStaleRunning(schedule: ScheduleRecord): boolean {
  if (!schedule.state.running) return false;
  if (!schedule.state.runningStartedAt) return true;
  const startedAt = new Date(schedule.state.runningStartedAt).getTime();
  if (!Number.isFinite(startedAt)) return true;
  return Date.now() - startedAt > STALE_RUNNING_MS;
}

export function createSchedulerTrigger(store: SchedulerStore, executor: ScheduleExecutor) {
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let tickRunning = false;
  const activeRuns = new Set<string>();

  return {
    /** Run a specific schedule by id immediately. */
    async runNow(id: string): Promise<ScheduleRunRecord> {
      return runSchedule(id, store, executor, activeRuns);
    },

    /** Start a specific schedule immediately and return once the run is queued. */
    async startRunNow(id: string): Promise<ScheduleRunStartResult> {
      const started = await startScheduleRun(id, store, executor, activeRuns);
      if (started.completion) {
        void started.completion.catch((err) => {
          console.error("[scheduler] background run error:", err instanceof Error ? err.message : err);
        });
      }
      return {
        started: Boolean(started.completion),
        runId: started.run.id,
        scheduleId: started.run.scheduleId,
        status: started.run.status,
      };
    },

    /** Scan for all due schedules and execute them in parallel. */
    async tick(at: Date = new Date()): Promise<ScheduleRunRecord[]> {
      if (tickRunning) return [];
      tickRunning = true;
      try {
        const schedules = await store.listSchedules();
        const due = schedules.filter(
          (s) => s.enabled && new Date(s.state.nextRunAt).getTime() <= at.getTime(),
        );
        if (due.length === 0) return [];

        const results = await Promise.allSettled(
          due.map((s) => runSchedule(s.id, store, executor, activeRuns)),
        );
        return results
          .filter((r): r is PromiseFulfilledResult<ScheduleRunRecord> => r.status === "fulfilled")
          .map((r) => r.value);
      } finally {
        tickRunning = false;
      }
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
