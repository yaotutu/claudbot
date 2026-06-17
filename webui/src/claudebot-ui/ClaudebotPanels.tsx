import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { fetchMemoryStatus, runMemoryDream } from "@/lib/claudebot-api";
import type { MemoryStatus, RuntimeInfo } from "@/lib/claudebot-types";
import { cn } from "@/lib/utils";

import { McpPanel } from "./McpPanel";
import type { ClaudebotUtilityPanel } from "./types";

type ClaudebotPanelsProps = {
  panel: Exclude<ClaudebotUtilityPanel, "tasks" | null>;
  runtime: RuntimeInfo;
  activeSessionId: string | null;
  onClose: () => void;
};

export function ClaudebotPanels({ panel, runtime, activeSessionId, onClose }: ClaudebotPanelsProps) {
  return (
    <div className="absolute inset-y-4 right-4 z-40 flex w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/60 px-4">
        <h2 className="text-sm font-semibold">{panelTitle(panel)}</h2>
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
        {panel === "settings" ? <SettingsPanel runtime={runtime} /> : null}
        {panel === "search" ? <PlaceholderPanel title="Search" body="会话搜索暂未接入。当前迁移阶段先复用 Nanobot 的入口和反馈，再按 Claudebot 原生协议补搜索索引。" /> : null}
        {panel === "skills" ? <McpPanel activeSessionId={activeSessionId} /> : null}
      </div>
    </div>
  );
}

function SettingsPanel({ runtime }: { runtime: RuntimeInfo }) {
  const [memory, setMemory] = useState<MemoryStatus | null>(null);
  const [message, setMessage] = useState("");
  const rows = [
    ["Model", runtime.providerModel.length > 0 ? `${runtime.model} -> ${runtime.providerModel}` : runtime.model],
    ["Workspace", runtime.workspace],
    ["Home", runtime.home],
    ["Gateway", `${runtime.gateway.host}:${runtime.gateway.port}`],
    ["Permission", runtime.permissionMode],
  ] as const;

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
    <div className="grid gap-4">
      <div className="mb-4">
        <h3 className="text-base font-semibold">运行状态</h3>
        <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
          Claudebot runtime is connected through the native WebUI protocol.
        </p>
      </div>
      <dl className="grid gap-2">
        {rows.map(([label, value]) => (
          <InfoRow key={label} label={label} value={value} />
        ))}
      </dl>
      <section className="border-t border-border/60 pt-4">
        <h3 className="text-base font-semibold">Memory</h3>
        {memory ? (
          <dl className="mt-3 grid gap-2">
            <InfoRow label="File" value="MEMORY.md" />
            <InfoRow label="Size" value={`${memory.sizeBytes} bytes`} />
            <InfoRow label="Pending" value={String(memory.pendingCandidates)} />
            <InfoRow label="Git" value={memory.gitAudit.available ? "available" : `unavailable: ${memory.gitAudit.reason ?? "unknown"}`} />
          </dl>
        ) : (
          <p className="mt-3 text-[13px] leading-6 text-muted-foreground">Loading memory status...</p>
        )}
        <button
          type="button"
          className="mt-3 rounded-lg border border-border bg-background px-3 py-2 text-[12px] font-medium transition-colors hover:bg-muted"
          onClick={handleRunDream}
        >
          Run Dream
        </button>
        {message ? <p className="mt-2 text-[13px] leading-6 text-muted-foreground">{message}</p> : null}
      </section>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={cn("rounded-xl border border-border/60 bg-background px-3 py-2")}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-[13px]" title={value}>{value}</dd>
    </div>
  );
}

function PlaceholderPanel({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-3 text-[13px] leading-6 text-muted-foreground">{body}</p>
    </div>
  );
}

function panelTitle(panel: Exclude<ClaudebotUtilityPanel, "tasks" | null>): string {
  if (panel === "settings") return "Settings";
  if (panel === "search") return "Search";
  return "Skills";
}
