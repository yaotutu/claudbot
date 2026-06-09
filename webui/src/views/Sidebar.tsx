import { useState } from "react";
import type { Session } from "../lib/api";

type Props = {
  sessions: Session[];
  activeId: string;
  view: "chat" | "agent";
  onView: (v: "chat" | "agent") => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
};

export function Sidebar({ sessions, activeId, view, onView, onSelect, onCreate, onDelete, onRefresh }: Props) {
  const [filter, setFilter] = useState("");
  const filtered = sessions.filter((s) => s.title.toLowerCase().includes(filter.toLowerCase()));
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button onClick={onCreate}>+ New</button>
        <button onClick={onRefresh} title="Refresh">⟳</button>
      </div>
      <div className="sidebar-nav">
        <button className={view === "chat" ? "active" : ""} onClick={() => onView("chat")}>Chat</button>
        <button className={view === "agent" ? "active" : ""} onClick={() => onView("agent")}>Agent</button>
      </div>
      {view === "chat" && (
        <>
          <div style={{ padding: "8px 12px" }}>
            <input
              placeholder="Search…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>
          <div className="session-list">
            {filtered.map((s) => (
              <div
                key={s.id}
                className={"session-item" + (s.id === activeId ? " active" : "")}
                onClick={() => onSelect(s.id)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="session-title">{s.title || "Untitled"}</div>
                  {s.preview && <div className="session-preview">{s.preview.slice(0, 60)}</div>}
                </div>
                <button onClick={(e) => { e.stopPropagation(); onDelete(s.id); }} title="Delete">×</button>
              </div>
            ))}
            {filtered.length === 0 && <div className="status-line" style={{ padding: 8 }}>No sessions.</div>}
          </div>
        </>
      )}
    </aside>
  );
}
