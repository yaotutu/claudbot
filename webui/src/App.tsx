// Claudebot WebUI entry. Wires bootstrap → client → Sidebar + ThreadShell.
//
// This is a deliberately small replacement for the full nanobot App.tsx.
// Most of the Sidebar's chrome (Skills, Settings, project controls, etc.)
// is rendered from the copied nanobot component, but the handlers here
// are no-ops — claudebot has no auth secret, no settings view, no
// skills catalog, and no workspace scoping.

import { useEffect, useMemo, useState } from "react";

import { Sidebar } from "@/components/Sidebar";
import { ThreadShell } from "@/components/thread/ThreadShell";
import { useSessions } from "@/hooks/useSessions";
import { pickInitialActiveSession } from "@/lib/active-session";
import { fetchBootstrap } from "@/lib/bootstrap";
import { ClaudebotClient } from "@/lib/claudebot-client";
import { ClientProvider } from "@/providers/ClientProvider";
import type { ChatSummary } from "@/lib/types";

type BootState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; client: ClaudebotClient; modelName: string | null; lastActiveSessionId: string | null };

function pickWsUrl(wsPath: string, fallbackPort: number): string {
  if (typeof window === "undefined") {
    return `ws://127.0.0.1:${fallbackPort}${wsPath}`;
  }
  if (window.location.port === "5173") {
    const host = window.location.hostname.includes(":")
      ? `[${window.location.hostname}]`
      : window.location.hostname;
    return `ws://${host}:${fallbackPort}${wsPath}`;
  }
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${wsPath}`;
}

export default function App() {
  const [boot, setBoot] = useState<BootState>({ status: "loading" });

  useEffect(() => {
    let client: ClaudebotClient | null = null;
    let cancelled = false;
    (async () => {
      try {
        const bs = await fetchBootstrap();
        if (cancelled) return;
        const wsUrl = pickWsUrl(bs.ws_path, 18790);
        client = new ClaudebotClient({ url: wsUrl, reconnect: true });
        client.setRuntimeModelName(bs.model_name ?? null);
        client.connect();
        setBoot({
          status: "ready",
          client,
          modelName: bs.model_name ?? null,
          lastActiveSessionId: bs.lastActiveSessionId ?? null,
        });
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setBoot({ status: "error", message });
      }
    })();
    return () => {
      cancelled = true;
      client?.close();
    };
  }, []);

  if (boot.status === "loading") {
    return (
      <div className="boot-splash">
        <div className="boot-splash-inner">
          <span className="boot-dot" aria-hidden="true"></span>
          <span data-boot-copy>Loading claudebot…</span>
        </div>
      </div>
    );
  }

  if (boot.status === "error") {
    return (
      <div className="boot-splash">
        <div className="boot-splash-inner" style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
          <strong>Failed to start claudebot UI</strong>
          <code style={{ fontSize: 12 }}>{boot.message}</code>
        </div>
      </div>
    );
  }

  return (
    <ClientProvider client={boot.client} token="" modelName={boot.modelName}>
      <Shell lastActiveSessionId={boot.lastActiveSessionId} />
    </ClientProvider>
  );
}

function Shell({ lastActiveSessionId }: { lastActiveSessionId: string | null }) {
  const { sessions, loading, refresh, createChat, deleteChat } = useSessions();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  });

  useEffect(() => {
    if (activeKey) return;
    // Pick the session the user was last on. If we can't find it (e.g. it has
    // been deleted), fall through to the most recently updated session so the
    // UI doesn't open onto a blank.
    const next = pickInitialActiveSession(sessions, lastActiveSessionId);
    if (next) setActiveKey(next);
  }, [sessions, activeKey, lastActiveSessionId]);

  const activeSession: ChatSummary | null = useMemo(() => {
    if (!activeKey) return null;
    return sessions.find((s) => s.key === activeKey) ?? null;
  }, [sessions, activeKey]);

  // Stable no-op handlers for Sidebar/ThreadShell props claudebot doesn't implement.
  const noop = () => {};

  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <div className="w-[272px] shrink-0 border-r border-sidebar-border/60">
        <Sidebar
          sessions={sessions}
          activeKey={activeKey}
          loading={loading}
          onNewChat={async () => {
            const id = await createChat();
            setActiveKey(`websocket:${id}`);
          }}
          onSelect={(key) => setActiveKey(key)}
          onRequestDelete={async (key) => {
            if (!confirm("Delete this session?")) return;
            await deleteChat(key);
            if (activeKey === key) setActiveKey(null);
          }}
          onTogglePin={noop}
          onRequestRename={async (key, label) => {
            const { patchSession } = await import("@/lib/api");
            await patchSession("", key, { title: label });
            await refresh();
          }}
          onToggleArchive={noop}
          onToggleGroup={noop}
          onRequestRenameProject={noop}
          onNewChatInProject={async () => {
            const id = await createChat();
            setActiveKey(`websocket:${id}`);
          }}
          onOpenSettings={noop}
          onOpenSkills={noop}
          onOpenSearch={noop}
          onToggleArchived={noop}
          onCollapse={noop}
          pinnedKeys={[]}
          archivedKeys={[]}
          titleOverrides={{}}
          projectNameOverrides={{}}
          collapsedGroups={{}}
          viewState={{
            density: "comfortable",
            show_previews: true,
            show_timestamps: true,
            show_archived: false,
            sort: "updated_desc",
          }}
        />
      </div>
      <main className="flex-1 min-w-0 h-full min-h-0 flex flex-col overflow-hidden">
        {activeSession ? (
          <ThreadShell
            session={activeSession}
            title={activeSession.title || "New chat"}
            onToggleSidebar={noop}
            onCreateChat={async () => {
              const id = await createChat();
              setActiveKey(`websocket:${id}`);
              return id;
            }}
            onTurnEnd={() => void refresh()}
            theme={theme}
            onToggleTheme={() => {
              setTheme((cur) => (cur === "dark" ? "light" : "dark"));
              if (typeof document !== "undefined") {
                document.documentElement.classList.toggle("dark");
              }
            }}
            workspaceScope={null}
            workspaceDefaultScope={null}
            workspaceControls={null}
            workspaceScopeDisabled={true}
            workspaceError={null}
            settingsSnapshot={null}
            hideThemeButton={false}
          />
        ) : (
          <EmptyState onNewChat={async () => {
            const id = await createChat();
            setActiveKey(`websocket:${id}`);
          }} />
        )}
      </main>
    </div>
  );
}

function EmptyState({ onNewChat }: { onNewChat: () => void | Promise<void> }) {
  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <h1 className="text-lg font-semibold">claudebot</h1>
        <p className="text-sm text-muted-foreground">
          Pick a session from the sidebar, or start a new chat.
        </p>
        <button
          className="rounded-md border border-border bg-secondary px-4 py-2 text-sm hover:bg-secondary/80"
          onClick={() => void onNewChat()}
        >
          + New chat
        </button>
      </div>
    </div>
  );
}
