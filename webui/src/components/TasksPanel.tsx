import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";

import {
  createSchedule,
  deleteSchedule,
  fetchScheduleRuns,
  listSchedules,
  runScheduleNow,
  updateSchedule,
} from "@/lib/claudebot-api";
import type { CreateSchedulePayload, NotificationRecord, ScheduleRecord, ScheduleRunRecord, ServerFrame } from "@/lib/claudebot-types";

type TasksPanelClient = {
  onFrame: (handler: (frame: ServerFrame) => void) => () => void;
};

export function TasksPanel({ client, notifications, onNotificationsChange, onRefreshNotifications, onClose }: {
  client: TasksPanelClient;
  notifications: NotificationRecord[];
  onNotificationsChange: Dispatch<SetStateAction<NotificationRecord[]>>;
  onRefreshNotifications: () => Promise<void>;
  onClose: () => void;
}) {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [runs, setRuns] = useState<ScheduleRunRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [draft, setDraft] = useState({ name: "", message: "", kind: "cron", cronExpr: "* * * * *", at: "", everyMs: "300000", timezone: "UTC" });

  const refresh = useCallback(async () => {
    const [scheduleRows, runRows] = await Promise.all([listSchedules(), fetchScheduleRuns(), onRefreshNotifications()]);
    setSchedules(scheduleRows);
    setRuns(runRows);
  }, [onRefreshNotifications]);

  useEffect(() => {
    return client.onFrame((frame) => {
      if (frame.type === "notification.created") {
        onNotificationsChange((current) => [frame.notification, ...current.filter((item) => item.id !== frame.notification.id)]);
      }
      if (frame.type === "schedule.run.completed") {
        void refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
      }
    });
  }, [client, onNotificationsChange, refresh]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    refresh()
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const submit = async () => {
    if (!draft.name.trim() || !draft.message.trim()) return;
    setBusy(true);
    setError("");
    try {
      await createSchedule(buildCreatePayload(draft));
      setDraft((current) => ({ ...current, name: "", message: "" }));
      setShowCreateForm(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute right-5 top-16 z-20 flex max-h-[calc(100vh-5rem)] w-[520px] flex-col rounded-lg border border-border bg-popover p-4 text-sm shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">定时任务</h2>
        <div className="flex items-center gap-2">
          <button className="rounded-md border border-border px-2 py-1 text-xs" onClick={() => setShowCreateForm((current) => !current)}>{showCreateForm ? "Cancel" : "New task"}</button>
          <button className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted" onClick={onClose}>Close</button>
        </div>
      </div>
      {error ? <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}
      {showCreateForm ? (
        <div className="grid gap-2 border-b border-border pb-3">
          <div className="grid grid-cols-2 gap-2">
            <input className="rounded-md border border-border bg-background px-2 py-1" placeholder="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            <select className="rounded-md border border-border bg-background px-2 py-1" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
              <option value="cron">cron</option>
              <option value="at">at</option>
              <option value="every">every</option>
            </select>
          </div>
          <textarea className="min-h-16 resize-none rounded-md border border-border bg-background px-2 py-1" placeholder="Message" value={draft.message} onChange={(event) => setDraft({ ...draft, message: event.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            {draft.kind === "cron" ? <input className="rounded-md border border-border bg-background px-2 py-1" value={draft.cronExpr} onChange={(event) => setDraft({ ...draft, cronExpr: event.target.value })} /> : null}
            {draft.kind === "at" ? <input className="rounded-md border border-border bg-background px-2 py-1" placeholder="ISO time" value={draft.at} onChange={(event) => setDraft({ ...draft, at: event.target.value })} /> : null}
            {draft.kind === "every" ? <input className="rounded-md border border-border bg-background px-2 py-1" value={draft.everyMs} onChange={(event) => setDraft({ ...draft, everyMs: event.target.value })} /> : null}
            <input className="rounded-md border border-border bg-background px-2 py-1" value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} />
          </div>
          <button className="w-fit rounded-md bg-foreground px-3 py-1.5 text-background disabled:opacity-50" disabled={busy || !draft.name.trim() || !draft.message.trim()} onClick={submit}>Create</button>
        </div>
      ) : null}
      <div className="mt-3 min-h-0 overflow-y-auto">
        <div className="text-xs font-medium text-muted-foreground">定时任务</div>
        {busy && schedules.length === 0 ? <div className="mt-2 text-xs text-muted-foreground">Loading...</div> : null}
        {!busy && schedules.length === 0 ? <div className="mt-2 text-xs text-muted-foreground">暂无定时任务</div> : null}
        {schedules.map((schedule) => {
          const latestRun = runs.find((run) => run.scheduleId === schedule.id);
          const latestNotification = notifications.find((item) => item.scheduleId === schedule.id);
          return (
            <div key={schedule.id} className="border-b border-border py-3 last:border-b-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{schedule.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{schedule.kind} · next {formatDate(schedule.state.nextRunAt)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{schedule.state.lastStatus ?? latestRun?.status ?? "never"}</div>
                  {schedule.state.lastError ? <div className="mt-1 text-xs text-destructive">{schedule.state.lastError}</div> : null}
                  {latestNotification ? (
                    <div className="mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs leading-5">
                      <div className="text-muted-foreground">{formatDate(latestNotification.createdAt)}</div>
                      <div>{latestNotification.content}</div>
                    </div>
                  ) : latestRun?.result ? (
                    <div className="mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs leading-5">{latestRun.result}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button className="rounded-md border border-border px-2 py-1 text-xs" disabled={busy} onClick={() => mutate(() => updateSchedule(schedule.id, { enabled: !schedule.enabled }))}>{schedule.enabled ? "Disable" : "Enable"}</button>
                  <button className="rounded-md border border-border px-2 py-1 text-xs" disabled={busy} onClick={() => mutate(() => runScheduleNow(schedule.id))}>Run</button>
                  <button className="rounded-md border border-border px-2 py-1 text-xs" disabled={busy} onClick={() => mutate(() => deleteSchedule(schedule.id))}>Delete</button>
                </div>
              </div>
            </div>
          );
        })}
        <section className="mt-3 border-t border-border pt-3">
          <div className="text-xs font-medium text-muted-foreground">最近提醒</div>
          {notifications.length === 0 ? <div className="mt-2 text-xs text-muted-foreground">暂无提醒</div> : null}
          {notifications.slice(0, 5).map((notification) => (
            <div key={notification.id} className="mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs leading-5">
              <div className="flex items-center justify-between gap-2 text-muted-foreground">
                <span className="truncate">{notification.title}</span>
                <span className="shrink-0">{formatDate(notification.createdAt)}</span>
              </div>
              <div className="mt-1 whitespace-pre-wrap">{notification.content}</div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function buildCreatePayload(draft: { name: string; message: string; kind: string; cronExpr: string; at: string; everyMs: string; timezone: string }): CreateSchedulePayload {
  return {
    name: draft.name.trim(),
    message: draft.message.trim(),
    timezone: draft.timezone.trim() || "UTC",
    ...(draft.kind === "at" ? { at: draft.at } : {}),
    ...(draft.kind === "every" ? { everyMs: Number(draft.everyMs) } : {}),
    ...(draft.kind === "cron" ? { cronExpr: draft.cronExpr } : {}),
  };
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
