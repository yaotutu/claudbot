import { useEffect, useState } from "react";
import { api, type Session } from "./lib/api";
import { Sidebar } from "./views/Sidebar";
import { ChatView } from "./views/ChatView";
import { AgentView } from "./views/AgentView";

type View = "chat" | "agent";

export function App() {
  const [bootError, setBootError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>("inbox");
  const [view, setView] = useState<View>("chat");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api.bootstrap()
      .then((b) => {
        setSessions(b.sessions as unknown as Session[]);
        setActiveId(b.lastActiveSessionId || "inbox");
      })
      .catch((e) => setBootError(e instanceof Error ? e.message : String(e)));
  }, [reloadKey]);

  async function refreshSessions() {
    const list = await api.listSessions();
    setSessions(list);
  }

  async function createSession() {
    const s = await api.createSession("New chat");
    await refreshSessions();
    setActiveId(s.id);
    await api.activateSession(s.id);
  }

  async function deleteSession(id: string) {
    if (!confirm("Delete this session?")) return;
    await api.deleteSession(id);
    if (activeId === id) setActiveId("inbox");
    await refreshSessions();
  }

  if (bootError) {
    return (
      <div className="app" style={{ gridTemplateColumns: "1fr" }}>
        <div className="main-body">
          <div className="error-banner">Failed to load: {bootError}</div>
          <p>Is the claudebot server running on http://127.0.0.1:18790 ?</p>
          <button onClick={() => { setBootError(null); setReloadKey((k) => k + 1); }}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        view={view}
        onView={setView}
        onSelect={async (id) => { setActiveId(id); await api.activateSession(id); }}
        onCreate={createSession}
        onDelete={deleteSession}
        onRefresh={refreshSessions}
      />
      {view === "chat"
        ? <ChatView sessionId={activeId} onSessionChanged={refreshSessions} />
        : <AgentView />}
    </div>
  );
}
