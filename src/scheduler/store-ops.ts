// Schedule CRUD operations — pure data layer, no executor dependency.
// Tools call these. The trigger layer is separate.

import { CronExpressionParser } from "cron-parser";
import { newId } from "../utils/id.ts";
import type { SchedulerStore } from "./store.ts";
import type { ScheduleRecord } from "./types.ts";

type CreateScheduleInput = {
  name: string;
  cronExpr: string;
  timezone: string;
  message: string;
};

function now(): string {
  return new Date().toISOString();
}

/** Compute the next fire time for a cron expression in a given timezone. */
export function computeNextRunAt(cronExpr: string, timezone: string): string {
  return CronExpressionParser.parse(cronExpr, { tz: timezone }).next().toDate().toISOString();
}

export function createStoreOps(store: SchedulerStore) {
  return {
    async create(input: CreateScheduleInput): Promise<ScheduleRecord> {
      // Validate cron up-front so we never persist an invalid schedule.
      computeNextRunAt(input.cronExpr, input.timezone);
      const time = now();
      const schedule: ScheduleRecord = {
        id: newId("sch"),
        name: input.name,
        enabled: true,
        cronExpr: input.cronExpr,
        timezone: input.timezone,
        message: input.message,
        state: {
          nextRunAt: computeNextRunAt(input.cronExpr, input.timezone),
          lastRunAt: null,
          lastStatus: null,
          lastError: null,
          runCount: 0,
          running: false,
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

    async update(id: string, patch: Partial<Pick<ScheduleRecord, "name" | "cronExpr" | "timezone" | "message">>): Promise<ScheduleRecord> {
      const schedules = await store.listSchedules();
      const idx = schedules.findIndex((s) => s.id === id);
      if (idx < 0) throw new Error(`schedule not found: ${id}`);
      const target = schedules[idx];
      if (patch.cronExpr || patch.timezone) {
        computeNextRunAt(patch.cronExpr || target.cronExpr, patch.timezone || target.timezone);
      }
      const next: ScheduleRecord = {
        ...target,
        ...patch,
        state: {
          ...target.state,
          ...(patch.cronExpr || patch.timezone
            ? { nextRunAt: computeNextRunAt(patch.cronExpr || target.cronExpr, patch.timezone || target.timezone) }
            : {}),
        },
        updatedAt: now(),
      };
      schedules[idx] = next;
      await store.saveSchedules(schedules);
      return next;
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
