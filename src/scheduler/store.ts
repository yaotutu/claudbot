import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../utils/fs.ts";
import type { ScheduleRecord, ScheduleRunRecord } from "./types.ts";

type SchedulesFile = { schedules: ScheduleRecord[] };

export type SchedulerStore = {
  listSchedules(): Promise<ScheduleRecord[]>;
  saveSchedules(schedules: ScheduleRecord[]): Promise<void>;
  listRuns(): Promise<ScheduleRunRecord[]>;
  appendRun(run: ScheduleRunRecord): Promise<void>;
  updateRun(run: ScheduleRunRecord): Promise<void>;
};

export function createSchedulerStore(schedulesPath: string, runsDir: string): SchedulerStore {
  const writeRun = async (run: ScheduleRunRecord): Promise<void> => {
    await writeJsonAtomic(join(runsDir, `${safeFileName(run.id)}.json`), run);
  };
  return {
    async listSchedules() {
      const file = await readJson<SchedulesFile>(schedulesPath, { schedules: [] });
      return file.schedules.map(normalizeScheduleRecord);
    },
    async saveSchedules(schedules) {
      await writeJsonAtomic(schedulesPath, { schedules });
    },
    async listRuns() {
      let files: string[];
      try {
        files = await readdir(runsDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const runs = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map((file) => readJson<ScheduleRunRecord | null>(join(runsDir, file), null)),
      );
      return runs
        .filter((run): run is ScheduleRunRecord => !!run)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    },
    async appendRun(run) {
      await writeRun(run);
    },
    async updateRun(run) {
      await writeRun(run);
    },
  };
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
