import { useCallback, useEffect, useMemo, useState } from "react";

import {
  deleteSession,
  fetchBootstrap,
  fetchThreadMessages,
  renameSession,
} from "@/lib/claudebot-api";
import { ClaudebotWsClient, type ConnectionStatus } from "@/lib/claudebot-ws";
import type { RuntimeInfo, SessionSummary } from "@/lib/claudebot-types";
import { NotificationToast } from "@/components/NotificationToast";
import { TasksPanel } from "@/components/TasksPanel";
import { ClaudebotShell } from "@/claudebot-ui/ClaudebotShell";
import { useClaudebotSessions } from "@/hooks/useClaudebotSessions";
import { useClaudebotThread } from "@/hooks/useClaudebotThread";
import { useNotifications } from "@/hooks/useNotifications";

type BootState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; runtime: RuntimeInfo; wsPath: string; sessions: SessionSummary[]; activeSessionId: string | null };

type Panel = "settings" | "search" | "skills" | "tasks" | null;
type WsLocation = Pick<Location, "protocol" | "host" | "hostname">;

export function pickWsUrl(
  path: string,
  runtime: RuntimeInfo,
  location?: WsLocation,
  isDev = import.meta.env.DEV,
): string {
  if (typeof window === "undefined" && !location) return `ws://127.0.0.1:${runtime.gateway.port}${path}`;
  const currentLocation = location ?? window.location;
  if (isDev) return `ws://${currentLocation.hostname}:${runtime.gateway.port}${path}`;
  const scheme = currentLocation.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${currentLocation.host}${path}`;
}

export default function App() {
  const [boot, setBoot] = useState<BootState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void fetchBootstrap()
      .then((payload) => {
        if (cancelled) return;
        setBoot({
          status: "ready",
          runtime: payload.runtime,
          wsPath: payload.ws.path,
          sessions: payload.sessions,
          activeSessionId: payload.activeSessionId,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setBoot({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (boot.status === "loading") {
    return <Splash text="Loading claudebot..." />;
  }

  if (boot.status === "error") {
    return <Splash title="Failed to start claudebot UI" text={boot.message} />;
  }

  return <ReadyApp boot={boot} />;
}

function ReadyApp({ boot }: { boot: Extract<BootState, { status: "ready" }> }) {
  const [panel, setPanel] = useState<Panel>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const client = useMemo(() => new ClaudebotWsClient({ url: pickWsUrl(boot.wsPath, boot.runtime) }), [boot.runtime, boot.wsPath]);

  useEffect(() => {
    const unsubscribe = client.onStatus(setStatus);
    client.connect();
    return () => {
      unsubscribe();
      client.close();
    };
  }, [client]);

  const notifications = useNotifications(client);

  const openTasks = useCallback(() => {
    setPanel("tasks");
    notifications.markAllReadOptimistic();
  }, [notifications]);

  const sessions = useClaudebotSessions({
    initialSessions: boot.sessions,
    activeSessionId: boot.activeSessionId ?? boot.sessions[0]?.id ?? null,
    client,
    deleteSession,
    renameSession,
  });

  const thread = useClaudebotThread({
    sessionId: sessions.activeSessionId,
    sessionStatus: sessions.activeSession?.status ?? null,
    client,
    fetchMessages: fetchThreadMessages,
  });

  const createDraft = useCallback(() => {
    const draftId = sessions.createDraftSession();
    setPanel(null);
    return draftId;
  }, [sessions]);

  return (
    <ClaudebotShell
      runtime={boot.runtime}
      connectionStatus={status}
      panel={panel}
      sessions={sessions.sessions}
      activeSessionId={sessions.activeSessionId}
      messages={thread.messages}
      activities={thread.activities}
      runStatus={thread.runStatus}
      loading={thread.loading}
      streaming={thread.streaming}
      notificationCount={notifications.unreadNotificationCount}
      tasksPanel={<TasksPanel client={client} notifications={notifications.notifications} onNotificationsChange={notifications.setNotifications} onRefreshNotifications={notifications.refreshNotifications} onClose={() => setPanel(null)} />}
      notificationToast={notifications.toast ? <NotificationToast notification={notifications.toast} onOpen={openTasks} onClose={() => notifications.setToast(null)} /> : null}
      onPanelChange={setPanel}
      onOpenTasks={openTasks}
      onNewChat={createDraft}
      onSelectSession={sessions.selectSession}
      onRenameSession={sessions.renameSession}
      onDeleteSession={sessions.deleteSession}
      onSend={thread.send}
      onCancel={thread.cancel}
    />
  );
}

function Splash({ title, text }: { title?: string; text: string }) {
  return (
    <div className="boot-splash">
      <div className="boot-splash-inner" style={{ flexDirection: title ? "column" : "row", alignItems: title ? "flex-start" : "center", gap: 6 }}>
        {title ? <strong>{title}</strong> : <span className="boot-dot" aria-hidden="true" />}
        <code style={{ fontSize: 12 }}>{text}</code>
      </div>
    </div>
  );
}
