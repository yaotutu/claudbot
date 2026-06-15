import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../utils/fs.ts";
import type { ScheduleRecord, ScheduleRunRecord } from "./types.ts";

type SchedulesFile = { schedules: ScheduleRecord[] };

export class SchedulerStore {
  constructor(private readonly schedulesPath: string, private readonly runsDir: string) {}

  async listSchedules(): Promise<ScheduleRecord[]> {
    const file = await readJson<SchedulesFile>(this.schedulesPath, { schedules: [] });
    return file.schedules.map(normalizeScheduleRecord);
  }

  async saveSchedules(schedules: ScheduleRecord[]): Promise<void> {
    await writeJsonAtomic(this.schedulesPath, { schedules });
  }

  async listRuns(): Promise<ScheduleRunRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.runsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const runs = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) => readJson<ScheduleRunRecord | null>(join(this.runsDir, file), null)),
    );
    return runs
      .filter((run): run is ScheduleRunRecord => !!run)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async appendRun(run: ScheduleRunRecord): Promise<void> {
    await this.writeRun(run);
  }

  async updateRun(run: ScheduleRunRecord): Promise<void> {
    await this.writeRun(run);
  }

  private async writeRun(run: ScheduleRunRecord): Promise<void> {
    await writeJsonAtomic(join(this.runsDir, `${safeFileName(run.id)}.json`), run);
  }
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function normalizeScheduleRecord(schedule: ScheduleRecord): ScheduleRecord {
  return {
    ...schedule,
    state: {
      ...schedule.state,
      runningStartedAt: schedule.state.runningStartedAt ?? null,
      lastSkippedReason: schedule.state.lastSkippedReason ?? null,
    },
  };
}
