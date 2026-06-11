// Schedule CRUD operations — pure data layer, no executor dependency.
// Tools call these. The trigger layer is separate.

import { CronExpressionParser } from "cron-parser";
import { newId } from "../utils/id.ts";
import type { SchedulerStore } from "./store.ts";
import type { ScheduleKind, ScheduleRecord } from "./types.ts";

export type CreateScheduleInput = {
  name: string;
  message: string;
  // Schedule type — exactly one of these:
  cronExpr?: string;       // kind="cron"
  at?: string;             // kind="at", ISO timestamp
  everyMs?: number;        // kind="every", milliseconds
  timezone?: string;       // default "UTC"
};

function now(): string {
  return new Date().toISOString();
}

/** Compute the next fire time for a cron expression in a given timezone. */
export function computeNextRunAt(cronExpr: string, timezone: string): string {
  return CronExpressionParser.parse(cronExpr, { tz: timezone }).next().toDate().toISOString();
}

/** Compute the next fire time based on schedule kind. */
export function computeNextRunAtFromKind(record: Pick<ScheduleRecord, "kind" | "cronExpr" | "at" | "everyMs" | "timezone">): string {
  switch (record.kind) {
    case "cron":
      return computeNextRunAt(record.cronExpr, record.timezone);
    case "every":
      return new Date(Date.now() + (record.everyMs ?? 0)).toISOString();
    case "at":
      // One-shot: no next run (will be deleted after execution)
      return new Date("9999-12-31").toISOString();
  }
}

function inferKind(input: CreateScheduleInput): ScheduleKind {
  if (input.at) return "at";
  if (input.everyMs) return "every";
  if (input.cronExpr) return "cron";
  throw new Error("Must provide one of: cronExpr, at, or everyMs");
}

export function createStoreOps(store: SchedulerStore) {
  return {
    async create(input: CreateScheduleInput): Promise<ScheduleRecord> {
      const kind = inferKind(input);
      const timezone = input.timezone || "UTC";

      // Validate cron up-front
      if (kind === "cron") {
        computeNextRunAt(input.cronExpr!, timezone);
      }
      // Validate "at" is a parseable date in the future
      if (kind === "at") {
        const atTime = new Date(input.at!).getTime();
        if (isNaN(atTime)) throw new Error(`Invalid ISO timestamp: ${input.at}`);
        // Allow slightly past timestamps (clock skew) but warn if too far past
      }
      // Validate "every" is positive
      if (kind === "every" && (!input.everyMs || input.everyMs < 1000)) {
        throw new Error("everyMs must be >= 1000");
      }

      const time = now();
      let nextRunAt: string;
      switch (kind) {
        case "cron": nextRunAt = computeNextRunAt(input.cronExpr!, timezone); break;
        case "at": nextRunAt = input.at!; break;
        case "every": nextRunAt = new Date(Date.now() + input.everyMs!).toISOString(); break;
      }

      const schedule: ScheduleRecord = {
        id: newId("sch"),
        name: input.name,
        enabled: true,
        kind,
        cronExpr: input.cronExpr || "",
        at: input.at || null,
        everyMs: input.everyMs || null,
        timezone,
        message: input.message,
        deleteAfterRun: kind === "at",
        state: {
          nextRunAt,
          lastRunAt: null,
          lastStatus: null,
          lastError: null,
          runCount: 0,
          running: false,
          runningStartedAt: null,
          lastSkippedReason: null,
        },
        createdAt: time,
        updatedAt: time,
      };
      const schedules = await store.listSchedules();
      schedules.push(schedule);
      await store.saveSchedules(schedules);
      return schedule;
    },

    async list(): Promise<ScheduleRecord[]> {
      return store.listSchedules();
    },

    async update(id: string, patch: Partial<Pick<ScheduleRecord, "name" | "cronExpr" | "timezone" | "message" | "everyMs" | "at">>): Promise<ScheduleRecord> {
      const schedules = await store.listSchedules();
      const idx = schedules.findIndex((s) => s.id === id);
      if (idx < 0) throw new Error(`schedule not found: ${id}`);
      const target = schedules[idx];

      // Validate cron if changed
      if (patch.cronExpr || patch.timezone) {
        computeNextRunAt(patch.cronExpr || target.cronExpr, patch.timezone || target.timezone);
      }

      const merged: ScheduleRecord = {
        ...target,
        ...patch,
        state: {
          ...target.state,
        },
        updatedAt: now(),
      };

      // Recompute nextRunAt if schedule timing fields changed
      if (patch.cronExpr || patch.timezone || patch.at || patch.everyMs) {
        merged.state.nextRunAt = computeNextRunAtFromKind(merged);
      }

      schedules[idx] = merged;
      await store.saveSchedules(schedules);
      return merged;
    },

    async delete(id: string): Promise<void> {
      const schedules = await store.listSchedules();
      const remaining = schedules.filter((s) => s.id !== id);
      if (remaining.length === schedules.length) throw new Error(`schedule not found: ${id}`);
      await store.saveSchedules(remaining);
    },

    async setEnabled(id: string, enabled: boolean): Promise<ScheduleRecord> {
      const schedules = await store.listSchedules();
      const idx = schedules.findIndex((s) => s.id === id);
      if (idx < 0) throw new Error(`schedule not found: ${id}`);
      schedules[idx] = { ...schedules[idx], enabled, updatedAt: now() };
      await store.saveSchedules(schedules);
      return schedules[idx];
    },
  };
}

export type SchedulerStoreOps = ReturnType<typeof createStoreOps>;
