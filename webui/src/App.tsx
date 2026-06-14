import { useCallback, useEffect, useMemo, useState } from "react";
import { Brain, CalendarClock, MessageSquarePlus, Search, Settings } from "lucide-react";

import {
  deleteSession,
  fetchBootstrap,
  fetchThreadMessages,
  renameSession,
} from "@/lib/claudebot-api";
import { ClaudebotWsClient, type ConnectionStatus } from "@/lib/claudebot-ws";
import type { RuntimeInfo, SessionSummary } from "@/lib/claudebot-types";
import { InfoPanel } from "@/components/InfoPanel";
import { NotificationToast } from "@/components/NotificationToast";
import { SidebarButton } from "@/components/SidebarButton";
import { TasksPanel } from "@/components/TasksPanel";
import { ThreadArea } from "@/components/ThreadArea";
import { useClaudebotSessions } from "@/hooks/useClaudebotSessions";
import { useClaudebotThread } from "@/hooks/useClaudebotThread";
import { useNotifications } from "@/hooks/useNotifications";

type BootState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; runtime: RuntimeInfo; wsPath: string; sessions: SessionSummary[]; activeSessionId: string | null };

type Panel = "settings" | "search" | "skills" | "tasks" | null;

function pickWsUrl(path: string, runtime: RuntimeInfo): string {
  if (typeof window === "undefined") return `ws://127.0.0.1:${runtime.gateway.port}${path}`;
  if (window.location.port === "5173") return `ws://${window.location.hostname}:${runtime.gateway.port}${path}`;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${path}`;
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
    <div className="flex h-full w-full bg-background text-foreground">
      <aside className="flex w-[272px] shrink-0 flex-col border-r border-sidebar-border/60 bg-sidebar px-2 py-3">
        <div className="mb-5 flex items-center gap-2 px-2">
          <img src="/brand/claudebot_logo.webp" alt="claudebot" className="h-8 w-8 rounded-lg" />
          <span className="text-sm font-medium">claudebot</span>
        </div>
        <SidebarButton icon={<MessageSquarePlus size={17} />} label="New chat" onClick={createDraft} />
        <SidebarButton icon={<Search size={17} />} label="Search" onClick={() => setPanel("search")} />
        <SidebarButton icon={<Brain size={17} />} label="Skills" onClick={() => setPanel("skills")} />
        <SidebarButton icon={<CalendarClock size={17} />} label="Tasks" badge={notifications.unreadNotificationCount} onClick={openTasks} />
        <div className="mt-5 px-2 text-xs text-muted-foreground">Sessions</div>
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {sessions.sessions.map((session) => (
            <button
              key={session.id}
              className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${sessions.activeSessionId === session.id ? "bg-sidebar-accent text-sidebar-foreground" : "hover:bg-sidebar-accent/70"}`}
              onClick={() => sessions.selectSession(session.id)}
            >
              <div className="truncate font-medium">{session.title || "New chat"}</div>
              {session.preview ? <div className="mt-1 truncate text-xs text-muted-foreground">{session.preview}</div> : null}
            </button>
          ))}
        </div>
        <div className="mt-3 border-t border-sidebar-border/60 pt-3">
          <SidebarButton icon={<Settings size={17} />} label="Settings" onClick={() => setPanel("settings")} />
          <div className="px-3 py-2 text-xs text-muted-foreground">{status === "open" ? "Connected" : status}</div>
        </div>
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/40 px-5 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{sessions.activeSession?.title ?? "New chat"}</span>
          <span className="rounded-full border border-border px-2 py-1">{boot.runtime.model}</span>
        </header>
        <ThreadArea
          messages={thread.messages}
          loading={thread.loading}
          streaming={thread.streaming}
          disabled={!sessions.activeSessionId}
          onSend={thread.send}
          onNewChat={createDraft}
          hasSession={Boolean(sessions.activeSessionId)}
        />
        {panel === "tasks" ? <TasksPanel client={client} notifications={notifications.notifications} onNotificationsChange={notifications.setNotifications} onRefreshNotifications={notifications.refreshNotifications} onClose={() => setPanel(null)} /> : null}
        {panel && panel !== "tasks" ? <InfoPanel panel={panel} runtime={boot.runtime} onClose={() => setPanel(null)} /> : null}
        {notifications.toast ? <NotificationToast notification={notifications.toast} onOpen={openTasks} onClose={() => notifications.setToast(null)} /> : null}
      </main>
    </div>
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
