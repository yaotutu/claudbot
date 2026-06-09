import { CronExpressionParser } from "cron-parser";
import { newId } from "../utils/id.ts";
import type { ScheduleRecord, ScheduleRunRecord } from "./types.ts";
import type { SchedulerStore } from "./store.ts";

type CreateScheduleInput = {
  name: string;
  cronExpr: string;
  timezone: string;
  message: string;
};

type ScheduleExecutor = (schedule: ScheduleRecord, run: ScheduleRunRecord) => Promise<string>;

function now(): string {
  return new Date().toISOString();
}

export class SchedulerService {
  constructor(
    private readonly store: SchedulerStore,
    private readonly executor: ScheduleExecutor,
  ) {}

  async create(input: CreateScheduleInput): Promise<ScheduleRecord> {
    // Validate cron up-front so we never persist an invalid schedule.
    this.nextRunAt(input.cronExpr, input.timezone);
    const time = now();
    const schedule: ScheduleRecord = {
      id: newId("sch"),
      name: input.name,
      enabled: true,
      cronExpr: input.cronExpr,
      timezone: input.timezone,
      message: input.message,
      state: {
        nextRunAt: this.nextRunAt(input.cronExpr, input.timezone),
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        runCount: 0,
        running: false,
      },
      createdAt: time,
      updatedAt: time,
    };
    const schedules = await this.store.listSchedules();
    schedules.push(schedule);
    await this.store.saveSchedules(schedules);
    return schedule;
  }

  async list(): Promise<ScheduleRecord[]> {
    return this.store.listSchedules();
  }

  async runNow(id: string): Promise<ScheduleRunRecord> {
    const schedules = await this.store.listSchedules();
    const schedule = schedules.find((item) => item.id === id);
    if (!schedule) throw new Error(`schedule not found: ${id}`);
    return this.runSchedule(schedule, schedules);
  }

  async tick(at: Date = new Date()): Promise<ScheduleRunRecord[]> {
    const schedules = await this.store.listSchedules();
    const due = schedules.filter((s) => s.enabled && new Date(s.state.nextRunAt).getTime() <= at.getTime());
    const runs: ScheduleRunRecord[] = [];
    for (const schedule of due) {
      runs.push(await this.runSchedule(schedule, schedules));
    }
    return runs;
  }

  private async runSchedule(schedule: ScheduleRecord, schedules: ScheduleRecord[]): Promise<ScheduleRunRecord> {
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
      await this.store.appendRun(run);
      return run;
    }
    schedule.state.running = true;
    await this.store.saveSchedules(schedules);
    await this.store.appendRun(run);
    try {
      run.result = await this.executor(schedule, run);
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
      schedule.state.nextRunAt = this.nextRunAt(schedule.cronExpr, schedule.timezone);
      schedule.updatedAt = now();
      await this.store.saveSchedules(schedules);
      await this.store.updateRun(run);
    }
    return run;
  }

  private nextRunAt(cronExpr: string, timezone: string): string {
    return CronExpressionParser.parse(cronExpr, { tz: timezone }).next().toDate().toISOString();
  }
}
