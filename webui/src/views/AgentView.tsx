import { useEffect, useState } from "react";
import { api, type AgentFile } from "../lib/api";

const FILES = ["user.md", "soul.md", "memory.json"] as const;
type FileName = typeof FILES[number];

export function AgentView() {
  const [files, setFiles] = useState<Record<FileName, AgentFile | null>>({
    "user.md": null,
    "soul.md": null,
    "memory.json": null,
  });
  const [editing, setEditing] = useState<Record<FileName, string>>({
    "user.md": "",
    "soul.md": "",
    "memory.json": "",
  });
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    for (const name of FILES) {
      api.readAgentFile(name)
        .then((f) => {
          setFiles((prev) => ({ ...prev, [name]: f }));
          setEditing((prev) => ({ ...prev, [name]: f.content }));
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, []);

  async function save(name: FileName) {
    setError(null);
    setStatus("Saving…");
    const current = files[name];
    if (!current) return;
    try {
      const updated = await api.writeAgentFile(name, editing[name], current.version);
      setFiles((prev) => ({ ...prev, [name]: updated }));
      setStatus(`Saved ${name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("");
    }
  }

  return (
    <main className="main">
      <div className="main-header">
        <strong>Agent files</strong>
        <span className="status-line">{status}</span>
      </div>
      <div className="agent-page">
        {error && <div className="error-banner">{error}</div>}
        {FILES.map((name) => (
          <div key={name} className="agent-file">
            <label>{name} <span className="status-line">v={files[name]?.version.slice(0, 12) ?? "?"}</span></label>
            <textarea
              value={editing[name]}
              onChange={(e) => setEditing((prev) => ({ ...prev, [name]: e.target.value }))}
              spellCheck={false}
            />
            <div>
              <button onClick={() => save(name)} disabled={!files[name]}>Save</button>
              <button
                onClick={() => setEditing((prev) => ({ ...prev, [name]: files[name]?.content ?? "" }))}
                style={{ marginLeft: 8 }}
              >Reload</button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
