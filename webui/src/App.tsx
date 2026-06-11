import { useCallback, useEffect, useMemo, useState } from "react";
import { Brain, MessageSquarePlus, Search, Settings, Sparkles } from "lucide-react";

import { deleteSession, fetchBootstrap, fetchThreadMessages, renameSession } from "@/lib/claudebot-api";
import { ClaudebotWsClient, type ConnectionStatus } from "@/lib/claudebot-ws";
import type { RuntimeInfo, SessionSummary } from "@/lib/claudebot-types";
import { useClaudebotSessions } from "@/hooks/useClaudebotSessions";
import { useClaudebotThread } from "@/hooks/useClaudebotThread";

type BootState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; runtime: RuntimeInfo; wsPath: string; sessions: SessionSummary[]; activeSessionId: string | null };

type Panel = "settings" | "search" | "skills" | null;

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
        {panel ? <InfoPanel panel={panel} runtime={boot.runtime} onClose={() => setPanel(null)} /> : null}
      </main>
    </div>
  );
}

function SidebarButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className="mb-1 flex h-9 w-full items-center gap-2 rounded-full px-3 text-sm hover:bg-sidebar-accent" aria-label={label} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ThreadArea({ messages, loading, streaming, disabled, onSend, onNewChat, hasSession }: {
  messages: Array<{ id: string; role: string; content: string }>;
  loading: boolean;
  streaming: boolean;
  disabled: boolean;
  onSend: (content: string) => void;
  onNewChat: () => void;
  hasSession: boolean;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    if (!hasSession) onNewChat();
    onSend(text);
    setValue("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-8">
        {loading ? <div className="text-sm text-muted-foreground">Loading...</div> : null}
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center">
            <h1 className="text-5xl font-semibold tracking-normal">What are we building today?</h1>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {messages.map((message) => (
              <div key={message.id} className={message.role === "user" ? "self-end rounded-2xl bg-muted px-4 py-3" : "self-start leading-7"}>
                {message.content}
              </div>
            ))}
            {streaming ? <div className="text-sm text-muted-foreground">Streaming...</div> : null}
          </div>
        )}
      </div>
      <div className="shrink-0 px-8 pb-6">
        <div className="mx-auto flex max-w-4xl items-end gap-3 rounded-3xl border border-border bg-background p-3 shadow-lg">
          <textarea
            className="min-h-20 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none"
            placeholder="Ask anything..."
            value={value}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button aria-label="Send message" className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground text-background" onClick={submit} disabled={disabled || !value.trim()}>
            <Sparkles size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoPanel({ panel, runtime, onClose }: { panel: Exclude<Panel, null>; runtime: RuntimeInfo; onClose: () => void }) {
  return (
    <div className="absolute right-5 top-16 z-20 w-[360px] rounded-lg border border-border bg-popover p-4 text-sm shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{panel === "settings" ? "运行状态" : panel === "search" ? "Search" : "Skills"}</h2>
        <button className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted" onClick={onClose}>Close</button>
      </div>
      {panel === "settings" ? (
        <dl className="grid gap-2 text-xs">
          <InfoRow label="Model" value={runtime.model} />
          <InfoRow label="Workspace" value={runtime.workspace} />
          <InfoRow label="Home" value={runtime.home} />
          <InfoRow label="Gateway" value={`${runtime.gateway.host}:${runtime.gateway.port}`} />
          <InfoRow label="Permission" value={runtime.permissionMode} />
        </dl>
      ) : panel === "search" ? (
        <p className="text-muted-foreground">会话搜索暂未接入。当前重构阶段先保证原生会话、消息流和运行状态稳定。</p>
      ) : (
        <p className="text-muted-foreground">技能目录暂未接入。当前可用能力由 claudebot 运行时和内置工具提供。</p>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate" title={value}>{value}</dd>
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
