export type ScheduleKind = "at" | "every" | "cron";

export type ScheduleRecord = {
  id: string;
  name: string;
  enabled: boolean;
  kind: ScheduleKind;
  cronExpr: string;         // kind="cron" — cron expression
  at: string | null;        // kind="at" — ISO timestamp
  everyMs: number | null;   // kind="every" — interval in milliseconds
  timezone: string;
  message: string;
  deleteAfterRun: boolean;  // kind="at" → true automatically
  state: {
    nextRunAt: string;
    lastRunAt: string | null;
    lastStatus: string | null;
    lastError: string | null;
    runCount: number;
    running: boolean;
    runningStartedAt: string | null;
    lastSkippedReason: string | null;
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
