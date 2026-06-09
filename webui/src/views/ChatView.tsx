import { useEffect, useRef, useState } from "react";
import { api, type SessionMessage } from "../lib/api";
import { ClaudebotStream } from "../lib/ws";

type Props = { sessionId: string; onSessionChanged: () => void };

type LiveDelta = { type: "text" | "thinking" | "tool"; text: string };

export function ChatView({ sessionId, onSessionChanged }: Props) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveDeltas, setLiveDeltas] = useState<LiveDelta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<ClaudebotStream | null>(null);

  useEffect(() => {
    const stream = new ClaudebotStream({
      onOpen: () => {
        stream.send({ type: "session.activate", sessionId });
      },
      onMessage: (m) => {
        switch (m.type) {
          case "message.appended":
            setMessages((prev) => {
              if (prev.some((msg) => msg.id === m.message.id)) return prev;
              return [...prev, m.message];
            });
            if (m.message.role === "user" || m.message.role === "system") {
              // user and system messages finalize immediately
            }
            if (m.message.role === "assistant") {
              // final assistant message from server — clear live deltas
              setLiveDeltas([]);
              setStreaming(false);
              onSessionChanged();
            }
            break;
          case "agent.text_delta":
            setLiveDeltas((prev) => [...prev, { type: "text", text: m.text }]);
            break;
          case "agent.thinking_delta":
            setLiveDeltas((prev) => [...prev, { type: "thinking", text: m.thinking }]);
            break;
          case "agent.tool_start":
            setLiveDeltas((prev) => [...prev, { type: "tool", text: `🔧 ${m.name}` }]);
            break;
          case "agent.tool_result":
            setLiveDeltas((prev) => [...prev, { type: "tool", text: `  ↳ ${m.isError ? "error" : "ok"}` }]);
            break;
          case "agent.turn_done":
            setStreaming(false);
            onSessionChanged();
            break;
          case "agent.error":
            setError(m.message);
            setStreaming(false);
            break;
        }
      },
    });
    streamRef.current = stream;
    stream.connect();
    return () => stream.close();
  }, [sessionId, onSessionChanged]);

  useEffect(() => {
    api.getMessages(sessionId).then(setMessages).catch(() => setMessages([]));
  }, [sessionId]);

  function send() {
    if (!draft.trim() || streaming) return;
    setError(null);
    setStreaming(true);
    setLiveDeltas([]);
    streamRef.current?.send({ type: "chat.user_message", content: draft });
    setDraft("");
  }

  return (
    <main className="main">
      <div className="main-header">
        <strong>{sessionId === "inbox" ? "Inbox" : `Session ${sessionId.slice(-8)}`}</strong>
        <span className="status-line">{streaming ? "● streaming…" : "○ idle"}</span>
      </div>
      <div className="main-body">
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        {messages.map((m) => (
          <div key={m.id} className={"message " + m.role}>
            {m.content}
          </div>
        ))}
        {streaming && (
          <div className="message assistant">
            {liveDeltas.length === 0 ? <span className="status-line">…</span> : null}
            {liveDeltas.map((d, i) => {
              if (d.type === "thinking") return <div key={i} className="thinking">💭 {d.text}</div>;
              if (d.type === "tool") return <div key={i} className="tool-event">{d.text}</div>;
              return <span key={i}>{d.text}</span>;
            })}
          </div>
        )}
      </div>
      <div className="composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
          }}
          placeholder="Type a message… (Cmd/Ctrl+Enter to send)"
        />
        <button onClick={send} disabled={!draft.trim() || streaming}>Send</button>
      </div>
    </main>
  );
}
