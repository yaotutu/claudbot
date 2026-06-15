import { useEffect, useState } from "react";
import { fetchMemoryStatus, runMemoryDream } from "@/lib/claudebot-api";
import type { MemoryStatus, RuntimeInfo } from "@/lib/claudebot-types";

export function InfoPanel({ panel, runtime, onClose }: { panel: "settings" | "search" | "skills"; runtime: RuntimeInfo; onClose: () => void }) {
  return (
    <div className="absolute right-5 top-16 z-20 w-[360px] rounded-lg border border-border bg-popover p-4 text-sm shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{panel === "settings" ? "运行状态" : panel === "search" ? "Search" : "Skills"}</h2>
        <button className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted" onClick={onClose}>Close</button>
      </div>
      {panel === "settings" ? (
        <SettingsPanel runtime={runtime} />
      ) : panel === "search" ? (
        <p className="text-muted-foreground">会话搜索暂未接入。当前重构阶段先保证原生会话、消息流和运行状态稳定。</p>
      ) : (
        <p className="text-muted-foreground">技能目录暂未接入。当前可用能力由 claudebot 运行时和内置工具提供。</p>
      )}
    </div>
  );
}

function SettingsPanel({ runtime }: { runtime: RuntimeInfo }) {
  const [memory, setMemory] = useState<MemoryStatus | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetchMemoryStatus()
      .then((status) => {
        if (!cancelled) setMemory(status);
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleRunDream() {
    setMessage("Running Dream...");
    try {
      const result = await runMemoryDream({ dryRun: true });
      setMessage(`${result.dryRun ? "Dream dry-run complete" : "Dream complete"}: ${result.summary}`);
      setMemory(await fetchMemoryStatus());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="grid gap-3">
      <dl className="grid gap-2 text-xs">
        <InfoRow label="Model" value={runtime.model} />
        <InfoRow label="Workspace" value={runtime.workspace} />
        <InfoRow label="Home" value={runtime.home} />
        <InfoRow label="Gateway" value={`${runtime.gateway.host}:${runtime.gateway.port}`} />
        <InfoRow label="Permission" value={runtime.permissionMode} />
      </dl>
      <section className="border-t border-border pt-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">Memory</h3>
        {memory ? (
          <dl className="grid gap-2 text-xs">
            <InfoRow label="File" value="MEMORY.md" />
            <InfoRow label="Size" value={`${memory.sizeBytes} bytes`} />
            <InfoRow label="Pending" value={String(memory.pendingCandidates)} />
            <InfoRow label="Git" value={memory.gitAudit.available ? "available" : `unavailable: ${memory.gitAudit.reason ?? "unknown"}`} />
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">Loading memory status...</p>
        )}
        <button className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted" onClick={handleRunDream}>Run Dream</button>
        {message ? <p className="mt-2 text-xs text-muted-foreground">{message}</p> : null}
      </section>
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
