export type ScheduleRecord = {
  id: string;
  name: string;
  enabled: boolean;
  cronExpr: string;
  timezone: string;
  message: string;
  state: {
    nextRunAt: string;
    lastRunAt: string | null;
    lastStatus: string | null;
    lastError: string | null;
    runCount: number;
    running: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

export type ScheduleRunRecord = {
  id: string;
  scheduleId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "succeeded" | "failed" | "skipped_running";
  result: string;
  error: string;
};
