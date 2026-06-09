import { readJson, writeJsonAtomic } from "../utils/fs.ts";
import type { ScheduleRecord, ScheduleRunRecord } from "./types.ts";

type SchedulesFile = { schedules: ScheduleRecord[] };
type RunsFile = { runs: ScheduleRunRecord[] };

export class SchedulerStore {
  constructor(private readonly schedulesPath: string, private readonly runsPath: string) {}

  async listSchedules(): Promise<ScheduleRecord[]> {
    return (await readJson<SchedulesFile>(this.schedulesPath, { schedules: [] })).schedules;
  }

  async saveSchedules(schedules: ScheduleRecord[]): Promise<void> {
    await writeJsonAtomic(this.schedulesPath, { schedules });
  }

  async listRuns(): Promise<ScheduleRunRecord[]> {
    return (await readJson<RunsFile>(this.runsPath, { runs: [] })).runs;
  }

  async appendRun(run: ScheduleRunRecord): Promise<void> {
    const runs = await this.listRuns();
    runs.push(run);
    await writeJsonAtomic(this.runsPath, { runs });
  }

  async updateRun(run: ScheduleRunRecord): Promise<void> {
    const runs = await this.listRuns();
    const index = runs.findIndex((item) => item.id === run.id);
    if (index >= 0) runs[index] = run;
    else runs.push(run);
    await writeJsonAtomic(this.runsPath, { runs });
  }
}
